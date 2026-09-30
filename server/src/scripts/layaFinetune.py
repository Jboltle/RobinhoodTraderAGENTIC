"""Fine-tune LAYA's English checkpoint on the action demo's train split, then serve it.

    python layaFinetune.py train --train train.jsonl --question question.json [--epochs 4] [--seed 42]
    python layaFinetune.py serve --checkpoint <dir> [--port 8766]

Runs on the Windows venv (C:\\Users\\Jon\\.venvs\\laya\\Scripts\\python.exe) with one CUDA GPU.
`train` reads export-train's train.jsonl ({id, text, label}) and question.json (the demo's
questions map), holds out a seeded, stratified slice for temperature fitting ONLY, fully
fine-tunes on the rest, fits the choice temperature on the holdout and saves a directory
laya.Agent loads. The demo's test split is never exported, so it can never reach this script.
`serve` exposes that directory over /v1/systemone as model "english", like laya-serve.

Recipe from laya's notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb: AdamW with
separate encoder/head learning rates, cosine decay, gradient clipping, gradient checkpointing,
per-type temperature fitted by LBFGS on held-out logits, fp16 safetensors on save.
"""
import argparse
import json
import math
import random
import shutil
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import torch

BASE_MODEL = "convaiinnovations/laya"
# The English checkpoint's files at the bundle root; the siblings live in subfolders.
BASE_FILES = ["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"]
DEFAULT_OUT_ROOT = Path.home() / ".venvs" / "laya-ft"
DEFAULT_EPOCHS = 4
DEFAULT_BATCH_SIZE = 8
DEFAULT_SEED = 42
HOLDOUT_FRACTION = 0.15
LR_ENCODER = 2.5e-5
LR_HEAD = 1.0e-4
LR_MIN = 1e-6
WEIGHT_DECAY = 0.01
GRAD_CLIP_NORM = 1.0
EVAL_BATCH_SIZE = 16
MIB = 1 << 20
SPILL_WARN_BYTES = 256 * MIB


def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def read_question(path):
    """question.json is the demo's questions map with exactly one choice question."""
    from laya.agent import Agent

    questions = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(questions, dict) or len(questions) != 1:
        sys.exit("question.json must hold exactly one question, e.g. {\"action\": {...}}")
    (qid, qdef), = questions.items()
    Agent._check_question(qid, qdef)
    if qdef["type"] != "choice":
        sys.exit("question %r is %r; only choice questions are supported" % (qid, qdef["type"]))
    return qid, qdef


def stratified_holdout(rows, seed):
    """Seeded per-label split: round(15%) of each label is held out, the rest trains.

    ponytail: a label with fewer than 4 rows contributes nothing to the holdout, so the
    temperature is fitted on the common labels only. Upgrade: k-fold temperature fitting.
    """
    rng = random.Random(seed)
    by_label = {}
    for row in rows:
        by_label.setdefault(row["label"], []).append(row)
    train, holdout = [], []
    for label in sorted(by_label):
        group = sorted(by_label[label], key=lambda row: row["id"])
        rng.shuffle(group)
        n_holdout = round(len(group) * HOLDOUT_FRACTION)
        holdout += group[:n_holdout]
        train += group[n_holdout:]
    return train, holdout


def encode(agent, internal, labels, row):
    from laya.common import QTYPES, build_sequence

    ids, markers = build_sequence(agent.tok, row["text"], internal,
                                  agent.cfg.get("max_len", 512), agent.cfg.get("head_max_len", 192))
    if len(markers) != len(labels):
        sys.exit("the options overflow head_max_len; shorten the criteria")
    label = labels.index(row["label"])
    target = [0.0] * len(labels)
    target[label] = 1.0
    return {"ids": ids, "markers": markers, "qtype": QTYPES["choice"], "target": target, "label": label}


def forward(model, items, pad_id):
    """Logits [n, k] under the same bf16 autocast LAYA infers with on Ampere."""
    from laya.common import collate_items

    batch = collate_items([[item] for item in items], pad_id)
    with torch.autocast("cuda", dtype=torch.bfloat16):
        logits, _act = model(*(batch[key].cuda() for key in
                               ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")))
    return logits.float(), batch


def fit_temperature(logits, labels):
    """LBFGS on log T, as the notebook does, clamped to the range LAYA actually applies."""
    from laya.common import clamp_temperature

    log_t = torch.zeros(1, requires_grad=True)
    optimizer = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)

    def closure():
        optimizer.zero_grad()
        loss = torch.nn.functional.cross_entropy(logits / log_t.exp(), labels)
        loss.backward()
        return loss

    optimizer.step(closure)
    return clamp_temperature(float(log_t.detach().exp()))


def ece_at(logits, labels, temperature):
    from laya.common import ece_score

    probs = torch.softmax(logits / temperature, -1)
    conf, pred = probs.max(-1)
    return ece_score(conf.numpy(), (pred == labels).float().numpy())


def train(args):
    from huggingface_hub import snapshot_download
    from laya.agent import Agent
    from laya.common import QTYPES
    from safetensors.torch import save_file

    if not torch.cuda.is_available():
        sys.exit("CUDA is not available to torch; fine-tuning needs the GPU")
    qid, qdef = read_question(args.question)
    labels = list(qdef["criteria"])
    rows = read_jsonl(args.train)
    unknown = sorted({row["label"] for row in rows} - set(labels))
    if unknown:
        sys.exit("train.jsonl has labels not in the question's criteria: %s" % unknown)
    train_rows, holdout_rows = stratified_holdout(rows, args.seed)

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    base_dir = Path(snapshot_download(BASE_MODEL, allow_patterns=BASE_FILES))
    agent = Agent(str(base_dir), device="cuda")
    internal = Agent._to_internal(qdef)
    train_items = [encode(agent, internal, labels, row) for row in train_rows]
    holdout_items = [encode(agent, internal, labels, row) for row in holdout_rows]
    pad_id = agent.tok.pad_token_id

    model = agent.model
    model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = True
    model.train()
    encoder_params = [p for name, p in model.named_parameters() if name.startswith("encoder.")]
    head_params = [p for name, p in model.named_parameters() if not name.startswith("encoder.")]
    optimizer = torch.optim.AdamW([{"params": encoder_params, "lr": LR_ENCODER},
                                   {"params": head_params, "lr": LR_HEAD}], weight_decay=WEIGHT_DECAY,
                                  fused=True)  # the default foreach step allocates a params-sized temporary
    total_steps = math.ceil(len(train_items) / args.batch_size) * args.epochs
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, total_steps), eta_min=LR_MIN)

    # ponytail: plain soft cross-entropy. The notebook adds a GRPO term over noisy logits scored
    # by laya.common.proper_reward; with one-hot labels and a fitted temperature it mostly shapes
    # calibration. Upgrade: port loss_rl from the notebook if holdout ECE stays high.
    torch.cuda.reset_peak_memory_stats()
    min_free = torch.cuda.mem_get_info()[0]
    epoch_seconds = []
    print("training %d rows (%d held out) for %d epochs, batch %d, %d steps"
          % (len(train_items), len(holdout_items), args.epochs, args.batch_size, total_steps), flush=True)
    for epoch in range(args.epochs):
        random.Random(args.seed + epoch).shuffle(train_items)
        started, losses = time.time(), []
        for start in range(0, len(train_items), args.batch_size):
            logits, batch = forward(model, train_items[start:start + args.batch_size], pad_id)
            loss = -(batch["target"].cuda() * torch.log_softmax(logits, -1)).sum(-1).mean()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), GRAD_CLIP_NORM)
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad(set_to_none=True)
            losses.append(loss.item())
            min_free = min(min_free, torch.cuda.mem_get_info()[0])
        epoch_seconds.append(time.time() - started)
        print("epoch %d/%d  loss %.4f  %.1fs" % (epoch + 1, args.epochs, np.mean(losses), epoch_seconds[-1]), flush=True)
    peak_allocated = torch.cuda.max_memory_allocated() // MIB
    peak_reserved = torch.cuda.max_memory_reserved() // MIB

    del optimizer, scheduler
    torch.cuda.empty_cache()
    model.eval()
    choice_type = QTYPES["choice"]
    temperature = agent.temperature[choice_type]
    before = after = accuracy = None
    if holdout_items:
        with torch.no_grad():
            logits = torch.cat([forward(model, holdout_items[i:i + EVAL_BATCH_SIZE], pad_id)[0].cpu()
                                for i in range(0, len(holdout_items), EVAL_BATCH_SIZE)])
        gold = torch.tensor([item["label"] for item in holdout_items])
        temperature = fit_temperature(logits, gold)
        accuracy = float((logits.argmax(-1) == gold).float().mean())
        before, after = ece_at(logits, gold, 1.0), ece_at(logits, gold, temperature)
    else:
        print("warning: empty holdout; keeping the base choice temperature %.3f" % temperature)

    out = Path(args.out_root) / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True)
    save_file({key: value.detach().half().contiguous().cpu() for key, value in model.state_dict().items()},
              str(out / "model.safetensors"))
    shutil.copytree(base_dir / "tokenizer", out / "tokenizer")
    shutil.copytree(base_dir / "encoder", out / "encoder")
    cfg = dict(agent.cfg)
    cfg["temperature"] = [temperature if i == choice_type else t for i, t in enumerate(agent.temperature_raw)]
    # One temperature fitted per type; inherited per-bucket values would override it.
    cfg.pop("temperature_by_options", None)
    cfg["fine_tuned"] = {"base": BASE_MODEL, "question_id": qid, "epochs": args.epochs, "seed": args.seed,
                         "train_rows": len(train_items), "holdout_rows": len(holdout_items),
                         "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    (out / "rl_agent_config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")

    train_counts, holdout_counts = Counter(r["label"] for r in train_rows), Counter(r["label"] for r in holdout_rows)
    print("\n%-8s %6s %8s" % ("label", "train", "holdout"))
    for label in labels:
        print("%-8s %6d %8d" % (label, train_counts[label], holdout_counts[label]))
    if accuracy is not None:
        print("holdout accuracy %.3f (%d rows) | ECE %.3f at T=1 -> %.3f at fitted T=%.3f"
              % (accuracy, len(holdout_items), before, after, temperature))
    print("time per epoch %.1fs | peak torch VRAM %d MiB allocated, %d MiB reserved | device free low-water %d MiB"
          % (np.mean(epoch_seconds), peak_allocated, peak_reserved, min_free // MIB))
    if min_free < SPILL_WARN_BYTES:
        print("note: the GPU reported no free VRAM at peak, so Windows paged other GPU apps (e.g. the "
              ":8765 server) to system RAM; if epochs are slow, stop them before a long run")
    print("checkpoint: %s" % out)


def serve(args):
    import uvicorn
    from laya.router import Router
    from laya.serve import create_app

    checkpoint = Path(args.checkpoint)
    if not (checkpoint / "rl_agent_config.json").exists():
        sys.exit("%s is not a laya checkpoint directory" % checkpoint)
    # ponytail: only "english" is remapped. Any other model name auto-routes to the stock
    # multilingual checkpoint (downloaded on first use); the demo always sends "english".
    router = Router(models={"english": str(checkpoint)}, device="cuda", max_loaded=1)
    router.preload(["english"])
    uvicorn.run(create_app(router), host=args.host, port=args.port, log_level="info")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    t = commands.add_parser("train", help="fine-tune on train.jsonl and save a checkpoint")
    t.add_argument("--train", required=True, help="export-train's train.jsonl")
    t.add_argument("--question", required=True, help="export-train's question.json")
    t.add_argument("--epochs", type=int, default=DEFAULT_EPOCHS)
    t.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    t.add_argument("--seed", type=int, default=DEFAULT_SEED)
    t.add_argument("--out-root", default=str(DEFAULT_OUT_ROOT), help="checkpoint goes in <out-root>/<timestamp>")
    s = commands.add_parser("serve", help="serve a fine-tuned checkpoint as model 'english'")
    s.add_argument("--checkpoint", required=True)
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    (train if args.command == "train" else serve)(args)


if __name__ == "__main__":
    main()
