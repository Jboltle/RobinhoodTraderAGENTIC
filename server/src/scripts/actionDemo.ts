/**
 * Action demo — can LAYA (the open-weight reimplementation of TypeSafe's Jev
 * System One model) classify Discord callouts into Actions reliably? A
 * standalone harness that answers that BEFORE any pipeline migration: it never
 * trades, never calls Robinhood, never touches a database, and never shows
 * model or parser output while you label.
 *
 *   bun src/scripts/actionDemo.ts sample [--size all] [--seed 42] [--force]
 *   bun src/scripts/actionDemo.ts label [--dry-run] [--relabel]
 *   bun src/scripts/actionDemo.ts laya [--tag ft] [--limit N] [--model english] [--gate]
 *   bun src/scripts/actionDemo.ts parser [--live] [--limit N]
 *   bun src/scripts/actionDemo.ts export-train
 *   bun src/scripts/actionDemo.ts report
 *   bun src/scripts/actionDemo.ts decide [--source export.jsonl] [--since ISO]
 *
 * decide is the pre-deploy replay: the production Jev decider (patterns, then
 * hosted Jev) over the labeled set or a messages export, scored against the
 * ship bars in docs/adr/0002. It calls Jev, so it needs JEV_API_KEY.
 *
 * Every command takes --dir (default server/state/action-demo/, gitignored
 * with the rest of state/). labels.jsonl, split.jsonl, laya*.jsonl and
 * parser.jsonl are append-only; report reads the latest row per message.
 * laya posts to LAYA_BASE_URL (default http://127.0.0.1:8765) over Jev's
 * /v1/systemone protocol; LAYA_API_KEY is only for a server that wants a
 * bearer token (hosted Jev would need that plus --model jev-latest).
 *
 * Each labeled message gets a permanent seeded train/test assignment
 * (split.jsonl). export-train writes the train split for fine-tuning; report
 * scores the test split only: untrained LAYA (laya.jsonl), fine-tuned LAYA
 * (laya-ft.jsonl, from `laya --tag ft` against the fine-tuned server) and the
 * current parser.
 *
 * sample reads decisions.jsonl, the parser fixtures and every sources/*.jsonl
 * (parseEval's row shape; the September and Swift dumps live there), so a
 * fresh Supabase export drops straight in once the DB password works (not
 * before: failed logins risk an IP ban). From server/:
 *
 *   psql "$SUPABASE_DB_URL" -t -A -c "SELECT json_build_object('id', id, 'ts', sent_at, 'content', content, 'embeds', embeds, 'author', author_name)::text FROM messages WHERE deleted_at IS NULL ORDER BY sent_at DESC LIMIT 1000" > state/action-demo/sources/supabase.jsonl
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { config as loadDotenv } from 'dotenv';

import { flattenEnvelope } from '../shared/embedText.js';
import type { DiscordEnvelope, OrderSide, PositionSize } from '../shared/types.js';
import {
  ACTING_NOW_QUESTION,
  ACTING_NOW_QUESTION_ID,
  ACTION_CRITERIA,
  ACTION_INSTRUCTIONS,
  ACTION_QUESTION_ID,
  ACTIONS,
  JevError,
  postSystemOne,
  readJevResponse,
  SYSTEMONE_PATH,
  TYPESAFE_API_HOST,
  typesafeKeyFor,
  type Action,
  type JevVerdict,
  type SystemOneCall,
} from '../trader/pipeline/jev.js';
import type { LlmCalloutParser } from '../trader/pipeline/parseCallout.js';
import {
  ALL_FIXTURES,
  envelopeFromFixture,
} from '../trader/pipeline/__tests__/fixtures/discordMessages.js';

// ---------------------------------------------------------------------------
// Actions — the question and criteria LAYA answers live in jev.ts
// ---------------------------------------------------------------------------

export { ACTIONS };
export type { Action };

/** INFO and NONE merged: the parser's not_callout means "no trade" and cannot tell them apart. */
export const MERGED_ACTIONS = ['BUY', 'AVERAGE', 'TRIM', 'SELL', 'NO_TRADE'] as const;
export type MergedAction = (typeof MERGED_ACTIONS)[number];

/** Also TRIM and SELL merged: the only exit distinction the current parser can express. */
export const COARSE_ACTIONS = ['BUY', 'AVERAGE', 'EXIT', 'NO_TRADE'] as const;
export type CoarseAction = (typeof COARSE_ACTIONS)[number];

export type Label = Action | 'UNSURE';

/** An exit read as an entry: followers buy more of what the Caller is getting out of. */
const COSTLY_TRUTHS: ReadonlySet<Action> = new Set<Action>(['TRIM', 'SELL']);
const COSTLY_PREDICTIONS: ReadonlySet<Action> = new Set<Action>(['BUY', 'AVERAGE']);

function isCostly(truth: Action, predicted: Action): boolean {
  return COSTLY_TRUTHS.has(truth) && COSTLY_PREDICTIONS.has(predicted);
}

// ---------------------------------------------------------------------------
// Data locations and records (one JSON object per line)
// ---------------------------------------------------------------------------

const DEFAULT_DIR = fileURLToPath(new URL('../../state/action-demo/', import.meta.url));
const DECISIONS_FILE = fileURLToPath(new URL('../../state/decisions.jsonl', import.meta.url));
const ROOT_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

/** decisions.jsonl rows from the ingest smoke test: replayed text, not real messages. */
const SMOKE_TEST_AUTHOR = 'Local Test';

function dataFiles(dir: string) {
  return {
    sources: join(dir, 'sources'),
    corpus: join(dir, 'corpus.jsonl'),
    labels: join(dir, 'labels.jsonl'),
    split: join(dir, 'split.jsonl'),
    train: join(dir, 'train.jsonl'),
    question: join(dir, 'question.json'),
    parser: join(dir, 'parser.jsonl'),
    report: join(dir, 'report.md'),
  };
}

/** laya.jsonl for the untrained server; laya-<tag>.jsonl for another checkpoint (e.g. ft). */
function layaFile(dir: string, tag?: string): string {
  return join(dir, tag ? `laya-${tag}.jsonl` : 'laya.jsonl');
}

const STRATA = ['exit', 'add', 'entry', 'other'] as const;
type Stratum = (typeof STRATA)[number];

interface CorpusRow {
  readonly id: string;
  /** Flattened message text (embeds folded in), ANSI and control characters stripped. */
  readonly text: string;
  readonly caller: string | null;
  readonly ts: string | null;
  /** Keyword heuristic that only balances the sample. Never shown while labeling. */
  readonly stratum: Stratum;
  readonly source: string;
}

export interface LabelRecord {
  readonly id: string;
  readonly label: Label;
  readonly at: string;
  /** Written by `label --relabel`: this message was re-sorted and is not re-shown. */
  readonly relabeled?: true;
}

interface LayaVerdict extends Omit<JevVerdict, 'actingNow'> {
  /** The state was cut to fit max_len, so LAYA never saw the end of the message. */
  readonly truncated: boolean;
  /** `--gate` runs only: probability the caller is telling followers to trade now. */
  readonly actingNow?: number | null;
}

type LayaSuccess = LayaVerdict & {
  readonly ok: true;
  readonly id: string;
  readonly at: string;
  readonly latencyMs: number;
  readonly attempts: number;
};
type LayaRecord =
  | LayaSuccess
  | { readonly ok: false; readonly id: string; readonly at: string; readonly error: string };

export type Split = 'train' | 'test';

interface SplitRecord {
  readonly id: string;
  readonly split: Split;
  readonly seed: number;
  readonly at: string;
}

/** One export-train row; `text` is byte-for-byte the state laya sends. */
interface TrainExample {
  readonly id: string;
  readonly text: string;
  readonly label: Action;
}

/** The Callout fields that decide an Action. The July saved verdicts predate isAddition. */
export interface ParsedCallout {
  readonly isCallout: boolean;
  readonly action: OrderSide | null;
  readonly isAddition?: boolean;
  readonly positionSize: PositionSize | null;
}

interface ParserRecord {
  readonly id: string;
  readonly at: string;
  /** saved = the July 2026 decisions.jsonl verdict; live = the current parser, re-run here. */
  readonly source: 'saved' | 'live';
  /** null when the parser produced no verdict (parser_error or a crash). */
  readonly action: Action | null;
  readonly callout: ParsedCallout | null;
  /** Decision kind, parse path, or error. */
  readonly detail: string;
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

function appendJsonl(file: string, row: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + '\n');
}

function readCorpus(dir: string): CorpusRow[] {
  const corpus = readJsonl<CorpusRow>(dataFiles(dir).corpus);
  if (corpus.length === 0) fail(`no corpus in ${dir}; run \`sample\` first`);
  return corpus;
}

function readTruths(dir: string, corpus: readonly CorpusRow[]) {
  const labels = new Map(
    readJsonl<LabelRecord>(dataFiles(dir).labels).map((record) => [record.id, record.label])
  );
  const truths = new Map<string, Action>();
  let unsure = 0;
  for (const row of corpus) {
    const label = labels.get(row.id);
    if (label === 'UNSURE') unsure += 1;
    else if (label) truths.set(row.id, label);
  }
  return { truths, unsure };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// sample — dedupe every local source, stratify, shuffle
// ---------------------------------------------------------------------------

/** parseEval's corpus row, plus an optional author name. */
interface SourceRow {
  readonly id?: string;
  readonly ts?: string;
  readonly content?: string;
  readonly embeds?: unknown[];
  readonly author?: string;
}

interface DecisionRow {
  readonly at: string;
  readonly kind: string;
  readonly reason?: string;
  readonly envelope: DiscordEnvelope;
  readonly callout: ParsedCallout | null;
}

// ponytail: keyword strata only balance the sample; they are never shown while
// labeling and never scored. Ceiling: regexes miss paraphrased exits and
// over-match "out"/"close". Upgrade: re-stratify on your own first labels.
const STRATUM_PATTERNS: readonly (readonly [Stratum, RegExp])[] = [
  [
    'add',
    /\baverag(?:e|ed|ing)\s+(?:down|up|in)\b|\badd(?:ed|ing)\b|\bdoubl(?:e|ed|ing)\s+down\b|\bscal(?:e|ed|ing)\s+in\b/i,
  ],
  [
    'exit',
    /\b(?:sold|sell(?:ing)?|trim(?:s|med|ming)?|clos(?:e|ed|ing)|out|stopped|(?:took|tak(?:e|ing))\s+profits?|runners?|cash(?:ed|ing)|locked\s+in|stc|exit(?:ed|ing)?)\b/i,
  ],
  [
    'entry',
    /\b(?:bto|buy(?:ing)?|bought|enter(?:ed|ing)?|entry|grab(?:bed|bing)?|lotto|starter)\b|\bi'?m\s+in\b/i,
  ],
];

/** Share of the sample per stratum: exits get the most so Trim vs Sell is well tested. */
const STRATUM_SHARES: Readonly<Record<Stratum, number>> = {
  exit: 0.4,
  add: 0.1,
  entry: 0.25,
  other: 0.25,
};

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
/** Below 0x20 except tab and newline, plus DEL: raw-mode rendering must not execute them. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function cleanText(text: string): string {
  return text.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS, '').trim();
}

function stratumOf(text: string): Stratum {
  return STRATUM_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}

// ponytail: exact-text dedup (case, whitespace and URLs ignored), so a card
// re-posted with a new P/L number survives as its own message. Upgrade: drop
// digits from the key if near-duplicates start crowding the sample.
function dedupKey(text: string): string {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

/** Seeded PRNG so the same --seed and sources always give the same corpus. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function stratifiedSample(
  rows: readonly CorpusRow[],
  size: number,
  random: () => number
): CorpusRow[] {
  const picked: CorpusRow[] = [];
  const spare: CorpusRow[] = [];
  for (const stratum of STRATA) {
    const pool = shuffle(rows.filter((row) => row.stratum === stratum), random);
    const quota = Math.floor(size * STRATUM_SHARES[stratum]);
    picked.push(...pool.slice(0, quota));
    spare.push(...pool.slice(quota));
  }
  // Strata short of their share leave slots; fill them from what is left.
  picked.push(...shuffle(spare, random).slice(0, Math.max(0, size - picked.length)));
  return shuffle(picked, random);
}

function loadCandidates(sourcesDir: string) {
  const byKey = new Map<string, CorpusRow>();
  const stats = { read: 0, duplicates: 0, empty: 0, smokeTests: 0 };
  const offer = (
    id: string,
    rawText: string,
    caller: string | null,
    ts: string | null,
    source: string
  ): void => {
    stats.read += 1;
    const text = cleanText(rawText);
    if (!text) {
      stats.empty += 1;
      return;
    }
    const key = dedupKey(text);
    if (byKey.has(key)) {
      stats.duplicates += 1;
      return;
    }
    byKey.set(key, { id, text, caller, ts, stratum: stratumOf(text), source });
  };

  // Newest first, so a text posted more than once keeps its latest saved verdict.
  for (const { envelope } of readJsonl<DecisionRow>(DECISIONS_FILE).reverse()) {
    if (envelope.authorName === SMOKE_TEST_AUTHOR) {
      stats.smokeTests += 1;
      continue;
    }
    // Saved envelopes already carry their flattened embed text; flattening again would duplicate it.
    offer(envelope.messageId, envelope.content, envelope.authorName, envelope.timestamp, 'decisions');
  }

  for (const file of readdirSync(sourcesDir).filter((name) => name.endsWith('.jsonl')).sort()) {
    const source = basename(file, '.jsonl');
    readJsonl<SourceRow>(join(sourcesDir, file)).forEach((row, index) => {
      const envelope = flattenEnvelope({
        messageId: row.id ?? `${source}-${index}`,
        channelId: 'demo',
        guildId: null,
        authorId: 'demo',
        authorName: row.author ?? 'demo',
        authorAvatarUrl: null,
        content: row.content ?? '',
        embeds: (row.embeds ?? []) as DiscordEnvelope['embeds'],
        timestamp: row.ts ?? '',
      });
      offer(envelope.messageId, envelope.content, row.author ?? null, row.ts ?? null, source);
    });
  }

  for (const fixture of ALL_FIXTURES) {
    const envelope = envelopeFromFixture(fixture);
    offer(envelope.messageId, envelope.content, fixture.authorName ?? null, envelope.timestamp, 'fixtures');
  }

  return { rows: [...byKey.values()], stats };
}

function sampleCommand(dir: string, size: number, seed: number, force: boolean): void {
  const paths = dataFiles(dir);
  if (existsSync(paths.corpus) && !force) {
    fail(
      `${paths.corpus} already exists and labels point at its ids. Re-run with --force to ` +
        'rebuild it (the same --seed and sources give the same corpus).'
    );
  }
  mkdirSync(paths.sources, { recursive: true });
  console.log('sources:', readdirSync(paths.sources).filter((name) => name.endsWith('.jsonl')));

  const { rows, stats } = loadCandidates(paths.sources);
  const corpus = stratifiedSample(rows, size, mulberry32(seed));
  writeFileSync(paths.corpus, corpus.map((row) => JSON.stringify(row) + '\n').join(''));

  console.log(
    `read ${stats.read} messages: ${rows.length} unique, ${stats.duplicates} duplicates, ` +
      `${stats.empty} empty (${stats.smokeTests} smoke-test rows skipped)`
  );
  console.log(`corpus: ${corpus.length} messages (seed ${seed}) → ${paths.corpus}`);
  console.log('by stratum:', countBy(corpus, (row) => row.stratum), 'pool:', countBy(rows, (row) => row.stratum));
  console.log('by source:', countBy(corpus, (row) => row.source), 'pool:', countBy(rows, (row) => row.source));
}

// ---------------------------------------------------------------------------
// label — blind, keyboard-driven, resumable
// ---------------------------------------------------------------------------

const LABEL_KEYS: Readonly<Record<string, Label>> = {
  b: 'BUY',
  a: 'AVERAGE',
  t: 'TRIM',
  s: 'SELL',
  i: 'INFO',
  n: 'NONE',
  u: 'UNSURE',
};
/** The labels --relabel re-shows: the ones INFO may now take over. */
const RELABEL_FROM: ReadonlySet<Label> = new Set<Label>(['NONE', 'UNSURE']);
const SKIP_KEY = 'k';
/** q, or Ctrl-C: raw mode delivers it as a byte instead of raising SIGINT. */
const QUIT_KEYS = new Set(['q', '\u0003']);
const CLEAR_SCREEN = '\u001b[2J\u001b[H';
const RULE = '─'.repeat(72);

/**
 * Messages the labeler shows, in corpus order. Normally: never labeled. With
 * relabel: latest label NONE or UNSURE and not yet re-sorted by a relabel pass.
 */
export function labelQueue<T extends { id: string }>(
  corpus: readonly T[],
  labels: readonly LabelRecord[],
  relabel: boolean
): T[] {
  const latest = new Map(labels.map((record) => [record.id, record]));
  return corpus.filter((row) => {
    const record = latest.get(row.id);
    return relabel ? !!record && RELABEL_FROM.has(record.label) && !record.relabeled : !record;
  });
}

/** One message as the labeler sees it: text, caller, time, progress; never a verdict. */
function renderCard(row: CorpusRow, progress: string, earlierLabel?: Label): string {
  return [
    RULE,
    ` ${progress}`,
    ` caller: ${row.caller ?? 'unknown'}   time: ${row.ts ?? 'unknown'}`,
    ...(earlierLabel ? [` your earlier label: ${earlierLabel}`] : []),
    RULE,
    '',
    row.text,
    '',
    RULE,
    ' [B]uy  [A]verage  [T]rim  [S]ell  [I]nfo  [N]one   [U]nsure  s[K]ip  [Q]uit',
  ].join('\n');
}

// ponytail: no undo key; a slip is fixed by appending a corrected row to
// labels.jsonl (report reads the last label per id). Upgrade: a Z key that
// re-queues the previous message.
async function labelCommand(dir: string, dryRun: boolean, relabel: boolean): Promise<void> {
  const paths = dataFiles(dir);
  const corpus = readCorpus(dir);
  const labelRecords = readJsonl<LabelRecord>(paths.labels);
  const latestLabel = new Map(labelRecords.map((record) => [record.id, record.label]));
  const queue = labelQueue(corpus, labelRecords, relabel);
  let labeled = corpus.length - labelQueue(corpus, labelRecords, false).length;
  let resorted = 0;
  const progress = (): string =>
    relabel
      ? `relabel ${resorted}/${queue.length} re-sorted (earlier NONE or UNSURE)`
      : `${labeled}/${corpus.length} labeled · ${corpus.length - labeled} to go`;
  const cardFor = (row: CorpusRow): string =>
    renderCard(row, progress(), relabel ? latestLabel.get(row.id) : undefined);

  const first = queue[0];
  if (!first) {
    console.log(relabel ? 'Nothing to relabel.' : `All ${corpus.length} messages are labeled. Next: report.`);
    return;
  }
  if (dryRun) {
    if (relabel) {
      const from = countBy(queue, (row) => latestLabel.get(row.id) ?? 'none');
      console.log(`relabel will show ${queue.length} messages:`, from);
    }
    console.log(cardFor(first));
    return;
  }
  if (!process.stdin.isTTY) fail('label needs an interactive terminal; use --dry-run to preview a card.');

  const stdin = process.stdin;
  let index = 0;
  let skipped = 0;
  let status = '';
  const show = (): void => {
    process.stdout.write(`${CLEAR_SCREEN}${cardFor(queue[index]!)}\n ${status}\n`.replaceAll('\n', '\r\n'));
  };

  await new Promise<void>((resolveDone) => {
    const finish = (): void => {
      stdin.off('data', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      resolveDone();
    };
    const onKey = (chunk: string): void => {
      const key = chunk[0]?.toLowerCase() ?? '';
      const label = LABEL_KEYS[key];
      if (QUIT_KEYS.has(key)) return finish();
      if (label) {
        const record: LabelRecord = {
          id: queue[index]!.id,
          label,
          at: new Date().toISOString(),
          ...(relabel ? { relabeled: true as const } : {}),
        };
        appendJsonl(paths.labels, record);
        if (relabel) resorted += 1;
        else labeled += 1;
        index += 1;
        status = `saved ${label} for the previous message`;
      } else if (key === SKIP_KEY) {
        skipped += 1;
        index += 1;
        status = 'skipped the previous message; it comes back next session';
      } else {
        status = 'unknown key; use B A T S I N U K Q';
      }
      if (index >= queue.length) return finish();
      show();
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onKey);
    stdin.resume();
    show();
  });

  process.stdout.write(CLEAR_SCREEN);
  console.log(
    `${progress()}${skipped ? `, ${skipped} skipped this session` : ''} → ${paths.labels}`
  );
}

// ---------------------------------------------------------------------------
// LAYA requests. The /v1/systemone wire shape lives in jev.ts: LAYA serves
// Jev's protocol (laya/serve.py; README "Three things differ from Jev"), so
// hosted Jev is a base URL, a key and --model jev-1.13.0 away.
// ---------------------------------------------------------------------------

const LAYA_DEFAULT_BASE_URL = 'http://127.0.0.1:8765';
/**
 * LAYA honours a checkpoint name and auto-routes anything else (emoji-heavy
 * text can land on the multilingual checkpoint); pinning keeps every message on
 * the checkpoint the token budget below was measured against.
 */
const LAYA_DEFAULT_MODEL = 'english';
/** English checkpoint's max_len: the state is silently cut so the sequence fits (~377 state tokens here). */
const LAYA_MAX_LEN = 512;

/** Exactly what LAYA reads as `state`; export-train writes the same string. */
export function layaState(row: Pick<CorpusRow, 'text'>): string {
  return row.text;
}

// The criteria were measured with LAYA's own tokenizer (laya-ts, English
// checkpoint) against laya/common.py build_sequence: question head 16 + options
// 137 = 153 of head_max_len 192; the longest option (INFO) is 38 of the 48-token
// per-option cap. Past either limit LAYA silently truncates, so re-measure after edits.
/** The questions map every request sends; export-train writes it verbatim as question.json. */
const LAYA_QUESTIONS = {
  [ACTION_QUESTION_ID]: {
    type: 'choice',
    instructions: ACTION_INSTRUCTIONS,
    criteria: ACTION_CRITERIA,
  },
};

/** Below this act-now probability the gate turns a trade into NONE. */
export const ACTING_NOW_MIN = 0.5;

const TRADE_ACTIONS: ReadonlySet<Action> = new Set<Action>(['BUY', 'AVERAGE', 'TRIM', 'SELL']);

export function buildLayaRequest(state: string, model: string, gate = false): unknown {
  return {
    model,
    state,
    questions: gate ? { ...LAYA_QUESTIONS, [ACTING_NOW_QUESTION_ID]: ACTING_NOW_QUESTION } : LAYA_QUESTIONS,
  };
}

/** The verdict a system acts on: a trade the gate says is not being called now is NONE. */
export function gatedChoice(verdict: Pick<LayaVerdict, 'choice' | 'actingNow'>): Action {
  const { choice, actingNow } = verdict;
  return actingNow != null && actingNow < ACTING_NOW_MIN && TRADE_ACTIONS.has(choice) ? 'NONE' : choice;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** jev.ts's verdict, plus whether LAYA cut the state to fit its 512-token window. */
export function readLayaResponse(json: unknown): LayaVerdict {
  const verdict = readJevResponse(json);
  // Only LAYA cuts the state at 512 tokens (its answers carry `routing`); hosted Jev reads 32k.
  const routed = isRecord(json) && isRecord(json.routing);
  return {
    ...verdict,
    truncated: routed && verdict.inputTokens !== null && verdict.inputTokens >= LAYA_MAX_LEN,
  };
}

/** Generous: a lazily loaded checkpoint takes 7-10 s on its first request (LAYA README). */
const REQUEST_TIMEOUT_MS = 60_000;
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

const TAG_PATTERN = /^[a-z0-9-]+$/i;

/**
 * LAYA_API_KEY goes to whatever server LAYA_BASE_URL names. JEV_API_KEY is a
 * TypeSafe credential, so it is attached only when that server is TypeSafe's.
 */
export function pickApiKey(baseUrl: string, env: Record<string, string | undefined>): string | undefined {
  return env.LAYA_API_KEY?.trim() || typesafeKeyFor(baseUrl, env.JEV_API_KEY);
}

// ponytail: one request at a time keeps per-call latency clean and a single GPU
// busy; ceiling ≈ one forward pass per call. Upgrade: LAYA's batch endpoint.
async function layaCommand(
  dir: string,
  limit: number,
  model: string,
  tag: string | undefined,
  gate: boolean
): Promise<void> {
  if (tag !== undefined && !TAG_PATTERN.test(tag)) fail(`--tag must be letters, digits or dashes, got "${tag}"`);
  const baseUrl = (process.env.LAYA_BASE_URL?.trim() || LAYA_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = pickApiKey(baseUrl, process.env);
  const redact = (text: string): string => (apiKey ? text.replaceAll(apiKey, '[redacted]') : text);
  const url = `${baseUrl}${SYSTEMONE_PATH}`;
  const file = layaFile(dir, tag);
  const corpus = readCorpus(dir);
  const answered = new Set(
    readJsonl<LayaRecord>(file)
      .filter((record) => record.ok)
      .map((record) => record.id)
  );
  const pending = corpus.filter((row) => !answered.has(row.id)).slice(0, limit);
  console.log(
    `laya: ${pending.length} to call, ${answered.size} already answered → ${url} (model ${model}` +
      `${gate ? ', act-now gate' : ''}) → ${file}`
  );

  let failures = 0;
  const recordFailure = (id: string, at: string, progress: string, error: string): void => {
    failures += 1;
    const record: LayaRecord = { ok: false, id, at, error: redact(error) };
    appendJsonl(file, record);
    console.log(`${progress} error ${record.error}`);
  };
  for (const [index, row] of pending.entries()) {
    const at = new Date().toISOString();
    const progress = `${index + 1}/${pending.length}`;
    let call: SystemOneCall;
    try {
      call = await postSystemOne(url, buildLayaRequest(layaState(row), model, gate), {
        apiKey,
        budgetMs: Infinity,
        attemptTimeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      if (!(err instanceof JevError) || err.kind !== 'http') {
        // Unreachable or timing out: stop instead of writing an error per message; a re-run resumes.
        fail(`could not reach LAYA at ${url} (${redact(errorMessage(err))}); stopped without recording this message. Is the server running?`);
      }
      if (err.status !== null && AUTH_FAILURE_STATUSES.has(err.status)) {
        fail(
          `LAYA refused the request (HTTP ${err.status}); set LAYA_API_KEY to the server's bearer token ` +
            `(JEV_API_KEY is used for ${TYPESAFE_API_HOST}).`
        );
      }
      recordFailure(row.id, at, progress, err.message);
      continue;
    }
    try {
      const record: LayaRecord = {
        ok: true,
        id: row.id,
        at,
        latencyMs: call.latencyMs,
        attempts: call.attempts,
        ...readLayaResponse(call.json),
      };
      appendJsonl(file, record);
      // No verdict on screen: running laya before labeling must not un-blind you.
      console.log(`${progress} ok ${call.latencyMs} ms`);
    } catch (err) {
      recordFailure(row.id, at, progress, errorMessage(err));
    }
  }
  console.log(`done: ${pending.length - failures} answered, ${failures} errors → ${file}`);
}

// ---------------------------------------------------------------------------
// split and export-train — a permanent holdout for the fine-tuning comparison
// ---------------------------------------------------------------------------

const TEST_FRACTION = 1 / 3;

function seededHash(seed: number, id: string): string {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

/**
 * Assign newly labeled messages to train or test. Stratified by your label:
 * within each Action, new ids join in seeded-hash order and each goes to test
 * while that Action's test share is below a third. Existing assignments never
 * move and are not returned.
 */
export function assignSplits(
  existing: ReadonlyMap<string, Split>,
  truths: ReadonlyMap<string, Action>,
  seed: number
): [id: string, split: Split][] {
  const assignments: [string, Split][] = [];
  for (const action of ACTIONS) {
    const ids = [...truths].filter(([, truth]) => truth === action).map(([id]) => id);
    let assigned = ids.filter((id) => existing.has(id)).length;
    let tests = ids.filter((id) => existing.get(id) === 'test').length;
    const fresh = ids
      .filter((id) => !existing.has(id))
      .sort((a, b) => seededHash(seed, a).localeCompare(seededHash(seed, b)));
    for (const id of fresh) {
      assigned += 1;
      const split: Split = tests < Math.round(assigned * TEST_FRACTION) ? 'test' : 'train';
      if (split === 'test') tests += 1;
      assignments.push([id, split]);
    }
  }
  return assignments;
}

/** Load split.jsonl, append assignments for any newly labeled message, return all of them. */
function ensureSplits(file: string, truths: ReadonlyMap<string, Action>, seed: number): Map<string, Split> {
  const splits = new Map(readJsonl<SplitRecord>(file).map((record) => [record.id, record.split]));
  const at = new Date().toISOString();
  for (const [id, split] of assignSplits(splits, truths, seed)) {
    const record: SplitRecord = { id, split, seed, at };
    appendJsonl(file, record);
    splits.set(id, split);
  }
  return splits;
}

function exportTrainCommand(dir: string, seed: number): void {
  const paths = dataFiles(dir);
  const corpus = readCorpus(dir);
  const { truths } = readTruths(dir, corpus);
  if (truths.size === 0) fail('no labels yet; run `label` first');
  const splits = ensureSplits(paths.split, truths, seed);
  const examples = corpus.flatMap((row): TrainExample[] => {
    const label = truths.get(row.id);
    return label && splits.get(row.id) === 'train' ? [{ id: row.id, text: layaState(row), label }] : [];
  });
  writeFileSync(paths.train, examples.map((example) => JSON.stringify(example) + '\n').join(''));
  writeFileSync(paths.question, JSON.stringify(LAYA_QUESTIONS, null, 2) + '\n');
  console.log(
    `train: ${examples.length} examples → ${paths.train} (${truths.size - examples.length} test messages held out)`
  );
  console.log(`question → ${paths.question}`);
  console.log('by label:', countBy(examples, (example) => example.label));
  console.log('fine-tune on this exact question:', JSON.stringify(buildLayaRequest('<text>', LAYA_DEFAULT_MODEL)));
}

// ---------------------------------------------------------------------------
// parser — the current pipeline's verdicts as Actions
// ---------------------------------------------------------------------------

/**
 * not_callout → NONE; buy → BUY, or AVERAGE with isAddition. The Callout
 * schema has no Trim/Sell split, so a sell maps on positionSize: any size word
 * (small/medium, or full: "TRIM TRIM", "trimming most", "runners only", which
 * execution sells as held − 1, keeping a runner) is a TRIM; no size word is
 * "sells without saying how much", a SELL.
 *
 * ponytail: positionSize is a size keyword, not an exit extent. Ceiling:
 * "close all" (tagged full) maps to TRIM, and an LLM-path "trimming" with no
 * size word maps to SELL. Upgrade: give the parser schema an explicit Action.
 */
export function parserAction(callout: ParsedCallout | null): Action | null {
  if (!callout) return null;
  if (!callout.isCallout || callout.action === null) return 'NONE';
  if (callout.action === 'buy') return callout.isAddition === true ? 'AVERAGE' : 'BUY';
  return callout.positionSize ? 'TRIM' : 'SELL';
}

export function mergedAction(action: Action): MergedAction {
  return action === 'INFO' || action === 'NONE' ? 'NO_TRADE' : action;
}

export function coarseAction(action: Action): CoarseAction {
  const merged = mergedAction(action);
  return merged === 'TRIM' || merged === 'SELL' ? 'EXIT' : merged;
}

function decidingFields(callout: ParsedCallout): ParsedCallout {
  return {
    isCallout: callout.isCallout,
    action: callout.action,
    isAddition: callout.isAddition,
    positionSize: callout.positionSize,
  };
}

async function parserCommand(dir: string, live: boolean, limit: number): Promise<void> {
  const paths = dataFiles(dir);
  const corpus = readCorpus(dir);
  const recorded = new Set(
    readJsonl<ParserRecord>(paths.parser).map((record) => `${record.source}:${record.id}`)
  );

  const decisions = new Map(
    readJsonl<DecisionRow>(DECISIONS_FILE).map((decision) => [decision.envelope.messageId, decision])
  );
  let saved = 0;
  for (const row of corpus) {
    const decision = decisions.get(row.id);
    if (!decision || recorded.has(`saved:${row.id}`)) continue;
    const { callout } = decision;
    const record: ParserRecord = {
      id: row.id,
      at: new Date().toISOString(),
      source: 'saved',
      action: parserAction(callout),
      callout: callout && decidingFields(callout),
      detail: callout ? decision.kind : `${decision.kind}: ${decision.reason ?? ''}`,
    };
    appendJsonl(paths.parser, record);
    saved += 1;
  }
  console.log(`saved verdicts: ${saved} added from ${DECISIONS_FILE} → ${paths.parser}`);

  if (live) await runLiveParser(corpus, recorded, paths.parser, limit);
}

/** parseEval's path: flatten the envelope, then parseTraced with the configured model. */
async function runLiveParser(
  corpus: readonly CorpusRow[],
  recorded: ReadonlySet<string>,
  file: string,
  limit: number
): Promise<void> {
  let parser: LlmCalloutParser;
  try {
    // Imported here: parseCallout loads shared/config, which requires LLM_MODEL and a provider key.
    const parseModule = await import('../trader/pipeline/parseCallout.js');
    parser = new parseModule.LlmCalloutParser();
  } catch (err) {
    fail(`live parser unavailable: ${errorMessage(err)}`);
  }

  const pending = corpus.filter((row) => !recorded.has(`live:${row.id}`)).slice(0, limit);
  console.log(`live parser: ${pending.length} to parse (each LLM-path message costs a call)`);
  const pathCounts = new Map<string, number>();
  let llmCalls = 0;
  for (const [index, row] of pending.entries()) {
    const at = new Date().toISOString();
    const envelope = flattenEnvelope({
      messageId: row.id,
      channelId: 'eval',
      guildId: null,
      authorId: 'eval',
      authorName: row.caller ?? 'eval',
      authorAvatarUrl: null,
      content: row.text,
      embeds: [],
      timestamp: row.ts ?? at,
    });
    let record: ParserRecord;
    try {
      const traced = await parser.parseTraced(envelope);
      llmCalls += traced.llmCalls;
      pathCounts.set(traced.path, (pathCounts.get(traced.path) ?? 0) + 1);
      record = {
        id: row.id,
        at,
        source: 'live',
        action: parserAction(traced.callout),
        callout: decidingFields(traced.callout),
        detail: traced.path,
      };
    } catch (err) {
      record = { id: row.id, at, source: 'live', action: null, callout: null, detail: `error: ${errorMessage(err)}` };
    }
    appendJsonl(file, record);
    // Progress only; verdicts stay hidden until report.
    console.log(`${index + 1}/${pending.length}`);
  }
  console.log(`llmCalls: ${llmCalls}, paths:`, Object.fromEntries(pathCounts));
}

// ---------------------------------------------------------------------------
// report — the test split, scored against your labels
// ---------------------------------------------------------------------------

const Z_95 = 1.96;

/** Wilson score interval for a binomial proportion; [0, 1] when there is no data. */
export function wilson(successes: number, n: number, z = Z_95): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { lo: Math.max(0, center - halfWidth), hi: Math.min(1, center + halfWidth) };
}

type Pair<T extends string> = readonly [truth: T, predicted: T];

/** Rows are your label, columns the prediction, both in `classes` order. */
export function confusionMatrix<T extends string>(
  pairs: readonly Pair<T>[],
  classes: readonly T[]
): number[][] {
  const matrix = classes.map(() => classes.map(() => 0));
  for (const [truth, predicted] of pairs) {
    const row = matrix[classes.indexOf(truth)];
    const column = classes.indexOf(predicted);
    if (row && column >= 0) row[column] = (row[column] ?? 0) + 1;
  }
  return matrix;
}

/** Bands over answerConfidence, LAYA's calibrated top probability. */
const CONFIDENCE_BANDS = [
  { label: '<0.6', min: 0 },
  { label: '0.6-0.8', min: 0.6 },
  { label: '0.8-0.9', min: 0.8 },
  { label: '0.9-0.97', min: 0.9 },
  { label: '≥0.97', min: 0.97 },
] as const;
type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number]['label'];

export function confidenceBand(p: number): ConfidenceBand {
  let band: ConfidenceBand = CONFIDENCE_BANDS[0].label;
  for (const { label, min } of CONFIDENCE_BANDS) if (p >= min) band = label;
  return band;
}

/** The results file `laya --tag ft` writes when pointed at the fine-tuned server. */
const FINE_TUNED_TAG = 'ft';
/** The results file `laya --tag jev` writes when pointed at hosted Jev. */
const JEV_TAG = 'jev';
/** The same, run with `--gate`. */
const JEV_GATED_TAG = 'jev-gated';

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function accuracyLine<T extends string>(title: string, pairs: readonly Pair<T>[]): string {
  if (pairs.length === 0) return `- ${title}: n/a (nothing scored)`;
  const correct = pairs.filter(([truth, predicted]) => truth === predicted).length;
  const { lo, hi } = wilson(correct, pairs.length);
  return `- ${title}: ${pct(correct / pairs.length)} (${correct}/${pairs.length}), Wilson 95% [${pct(lo)}, ${pct(hi)}]`;
}

function matrixLines<T extends string>(
  pairs: readonly Pair<T>[],
  classes: readonly T[],
  system: string
): string[] {
  const matrix = confusionMatrix(pairs, classes);
  return [
    '',
    `| you ↓ · ${system} → | ${classes.join(' | ')} |`,
    `|---|${classes.map(() => '---:').join('|')}|`,
    ...classes.map((label, i) => `| ${label} | ${(matrix[i] ?? []).join(' | ')} |`),
    '',
  ];
}

const toMerged = (pairs: readonly Pair<Action>[]): Pair<MergedAction>[] =>
  pairs.map(([truth, predicted]) => [mergedAction(truth), mergedAction(predicted)]);

const toCoarse = (pairs: readonly Pair<Action>[]): Pair<CoarseAction>[] =>
  pairs.map(([truth, predicted]) => [coarseAction(truth), coarseAction(predicted)]);

/** A system that can say INFO gets the 6-way view too; the parser only the merged ones. */
function scoreLines(system: string, pairs: readonly Pair<Action>[], sixWay: boolean): string[] {
  const merged = toMerged(pairs);
  const coarse = toCoarse(pairs);
  const costly = pairs.filter(([truth, predicted]) => isCostly(truth, predicted)).length;
  return [
    ...(sixWay ? [accuracyLine('6-way accuracy', pairs)] : []),
    accuracyLine('5-way accuracy (INFO + NONE = NO_TRADE)', merged),
    accuracyLine('coarse accuracy (also TRIM + SELL = EXIT)', coarse),
    `- costly errors (you said TRIM/SELL, ${system} said BUY/AVERAGE): ${costly}`,
    ...(sixWay ? matrixLines(pairs, ACTIONS, system) : []),
    ...matrixLines(merged, MERGED_ACTIONS, `${system}, no-trade merged`),
    ...matrixLines(coarse, COARSE_ACTIONS, `${system}, coarse`),
  ];
}

/** Latest answer per message; an error only stands when there is no answer. */
function latestLayaById(records: readonly LayaRecord[]): Map<string, LayaRecord> {
  const byId = new Map<string, LayaRecord>();
  for (const record of records) {
    if (record.ok || !byId.get(record.id)?.ok) byId.set(record.id, record);
  }
  return byId;
}

/** Latest verdict per message, a live re-run beating a saved one. */
function latestParserById(records: readonly ParserRecord[]): Map<string, ParserRecord> {
  const byId = new Map<string, ParserRecord>();
  for (const record of records) {
    if (record.source === 'live' || byId.get(record.id)?.source !== 'live') byId.set(record.id, record);
  }
  return byId;
}

/** An Action; null for an error or no verdict; undefined when the system never saw the message. */
type VerdictOf = (id: string) => Action | null | undefined;

interface System {
  readonly name: string;
  readonly verdictOf: VerdictOf;
  /** Verdict as shown in the disagreement list. */
  readonly describe: (id: string) => string;
  /** False for the parser: it has no INFO, so it is judged with INFO and NONE merged. */
  readonly sixWay: boolean;
}

function agrees(system: System, truth: Action, verdict: Action): boolean {
  return system.sixWay ? verdict === truth : mergedAction(verdict) === mergedAction(truth);
}

function coverage(truths: ReadonlyMap<string, Action>, verdictOf: VerdictOf) {
  const pairs: Pair<Action>[] = [];
  let errors = 0;
  for (const [id, truth] of truths) {
    const verdict = verdictOf(id);
    if (verdict === null) errors += 1;
    else if (verdict !== undefined) pairs.push([truth, verdict]);
  }
  return { pairs, errors, notRun: truths.size - pairs.length - errors };
}

function layaSystem(name: string, records: ReadonlyMap<string, LayaRecord>): System {
  return {
    name,
    sixWay: true,
    verdictOf: (id) => {
      const record = records.get(id);
      return record === undefined ? undefined : record.ok ? gatedChoice(record) : null;
    },
    describe: (id) => {
      const record = records.get(id);
      if (!record) return '—';
      if (!record.ok) return 'error';
      const gate = record.actingNow != null ? `, act-now ${record.actingNow.toFixed(2)}` : '';
      return `${gatedChoice(record)} (p ${record.answerConfidence.toFixed(2)}${gate})`;
    },
  };
}

function layaLines(
  system: System,
  records: ReadonlyMap<string, LayaRecord>,
  test: ReadonlyMap<string, Action>,
  missingHint: string
): string[] {
  const { pairs, errors, notRun } = coverage(test, system.verdictOf);
  if (pairs.length + errors === 0) return [missingHint, ''];

  const answered = [...records.values()].filter((record): record is LayaSuccess => record.ok);
  const scored = answered.filter((record) => test.has(record.id));
  const bands = new Map<ConfidenceBand, { n: number; correct: number; pSum: number }>();
  for (const record of scored) {
    const band = confidenceBand(record.answerConfidence);
    const tally = bands.get(band) ?? { n: 0, correct: 0, pSum: 0 };
    bands.set(band, {
      n: tally.n + 1,
      correct: tally.correct + (record.choice === test.get(record.id) ? 1 : 0),
      pSum: tally.pSum + record.answerConfidence,
    });
  }
  const latencies = answered.map((record) => record.latencyMs);

  return [
    `Checkpoint: ${[...new Set(scored.map((record) => record.model))].join(', ')}. Scored ${pairs.length} ` +
      `of ${test.size} test messages (${errors} errors, ${notRun} not run); ` +
      `${scored.filter((record) => record.truncated).length} were cut to ${LAYA_MAX_LEN} tokens.`,
    '',
    ...scoreLines(system.name, pairs, true),
    'Accuracy (6-way) by band of `answer_confidence` (calibrated top probability; LAYA\'s ' +
      '`confidence` is 1 − normalized entropy and not calibrated):',
    '',
    '| band | n | accuracy | Wilson 95% | mean p |',
    '|---|---:|---:|---:|---:|',
    ...CONFIDENCE_BANDS.map(({ label }) => {
      const tally = bands.get(label);
      if (!tally) return `| ${label} | 0 | – | – | – |`;
      const { lo, hi } = wilson(tally.correct, tally.n);
      return `| ${label} | ${tally.n} | ${pct(tally.correct / tally.n)} | [${pct(lo)}, ${pct(hi)}] | ${(tally.pSum / tally.n).toFixed(3)} |`;
    }),
    '',
    `- latency over ${latencies.length} answered calls (both splits): p50 ${percentile(latencies, 0.5)} ms, ` +
      `p95 ${percentile(latencies, 0.95)} ms`,
    '',
  ];
}

function parserLines(
  system: System,
  parser: ReadonlyMap<string, ParserRecord>,
  test: ReadonlyMap<string, Action>
): string[] {
  const { pairs, errors, notRun } = coverage(test, system.verdictOf);
  if (pairs.length + errors === 0) {
    return ['No parser verdicts on test messages: run `parser` (add --live to re-run the current parser).', ''];
  }
  const sources = countBy(
    [...parser.values()].filter((record) => test.has(record.id)),
    (record) => record.source
  );
  return [
    `Verdicts: ${sources.live ?? 0} live (current parser, re-run here), ${sources.saved ?? 0} saved ` +
      '(decisions.jsonl, July 2026 parser; it predates isAddition, so a saved verdict never says ' +
      'AVERAGE). Live wins where both exist.',
    `Scored ${pairs.length} of ${test.size} test messages (${errors} parser errors, ${notRun} with no verdict).`,
    'Mapping: not_callout → NO_TRADE; buy → BUY; buy + isAddition → AVERAGE; sell + positionSize ' +
      'small/medium/full → TRIM; sell with no positionSize → SELL. The parser has no INFO concept ' +
      '(not_callout just means "no trade"), so your INFO and NONE labels are scored as one ' +
      'NO_TRADE class; it has no Trim/Sell field either, so the coarse row is the fair comparison.',
    '',
    ...scoreLines(system.name, pairs, false),
  ];
}

function reportCommand(dir: string, seed: number): void {
  const paths = dataFiles(dir);
  const corpus = readCorpus(dir);
  const { truths, unsure } = readTruths(dir, corpus);
  const splits = ensureSplits(paths.split, truths, seed);
  const test = new Map([...truths].filter(([id]) => splits.get(id) === 'test'));
  const unlabeled = corpus.length - truths.size - unsure;

  const untrained = latestLayaById(readJsonl<LayaRecord>(layaFile(dir)));
  const fineTuned = latestLayaById(readJsonl<LayaRecord>(layaFile(dir, FINE_TUNED_TAG)));
  const jev = latestLayaById(readJsonl<LayaRecord>(layaFile(dir, JEV_TAG)));
  const jevGated = latestLayaById(readJsonl<LayaRecord>(layaFile(dir, JEV_GATED_TAG)));
  const parser = latestParserById(readJsonl<ParserRecord>(paths.parser));
  const untrainedSystem = layaSystem('LAYA untrained', untrained);
  const fineTunedSystem = layaSystem('LAYA fine-tuned', fineTuned);
  const jevSystem = layaSystem('Jev (hosted)', jev);
  const jevGatedSystem = layaSystem('Jev (hosted), act-now gate', jevGated);
  const parserSystem: System = {
    name: 'parser',
    sixWay: false,
    verdictOf: (id) => parser.get(id)?.action,
    describe: (id) => {
      const record = parser.get(id);
      if (!record) return '—';
      return record.action ? mergedAction(record.action) : 'no verdict';
    },
  };
  const systems = [untrainedSystem, fineTunedSystem, jevSystem, jevGatedSystem, parserSystem];

  // Head-to-head only over test messages every system that ran has a verdict for.
  const ran = systems.filter((system) => [...test.keys()].some((id) => system.verdictOf(id)));
  const common = [...test].filter(([id]) => ran.every((system) => system.verdictOf(id)));
  const pairsFor = (system: System): Pair<Action>[] =>
    common.flatMap(([id, truth]): Pair<Action>[] => {
      const verdict = system.verdictOf(id);
      return verdict ? [[truth, verdict]] : [];
    });

  const disagreements = [...test]
    .flatMap(([id, truth]) => {
      const verdicts = systems.flatMap((system) => {
        const verdict = system.verdictOf(id);
        return verdict ? [{ system, verdict }] : [];
      });
      if (verdicts.every(({ system, verdict }) => agrees(system, truth, verdict))) return [];
      const costly = verdicts.some(({ verdict }) => isCostly(truth, verdict));
      return [{ id, truth, costly }];
    })
    .sort((a, b) => Number(b.costly) - Number(a.costly));
  const textById = new Map(corpus.map((row) => [row.id, row.text]));
  const sources = Object.entries(countBy(corpus, (row) => row.source))
    .map(([source, count]) => `${source} ${count}`)
    .join(', ');

  const lines = [
    '# Action demo report',
    '',
    `Generated ${new Date().toISOString()} from ${dir}.`,
    '',
    ...(unlabeled > 0
      ? [`> ⚠ ${unlabeled} messages are still unlabeled; reading verdicts before labeling them breaks the blind.`, '']
      : []),
    `Corpus: ${corpus.length} messages from the saved local sources (${sources}); the mix is not natural traffic.`,
    `Labels: ${truths.size} scored (train ${truths.size - test.size}, test ${test.size}), ` +
      `${unsure} unsure (excluded), ${unlabeled} unlabeled. Everything below scores the test split only.`,
    '',
    '## LAYA untrained',
    '',
    ...layaLines(untrainedSystem, untrained, test, 'No answers yet: run `laya` against the untrained server.'),
    '## LAYA fine-tuned',
    '',
    ...layaLines(
      fineTunedSystem,
      fineTuned,
      test,
      `No answers yet: run \`laya --tag ${FINE_TUNED_TAG}\` against the fine-tuned server.`
    ),
    '## Jev (hosted)',
    '',
    ...layaLines(
      jevSystem,
      jev,
      test,
      `No answers yet: run \`laya --tag ${JEV_TAG} --model jev-1.13.0\` with LAYA_BASE_URL=https://${TYPESAFE_API_HOST}.`
    ),
    '## Jev (hosted), act-now gate',
    '',
    ...layaLines(
      jevGatedSystem,
      jevGated,
      test,
      `No answers yet: run \`laya --tag ${JEV_GATED_TAG} --model jev-1.13.0 --gate\` with LAYA_BASE_URL=https://${TYPESAFE_API_HOST}.`
    ),
    '## Current parser',
    '',
    ...parserLines(parserSystem, parser, test),
    ...(ran.length > 1 && common.length > 0
      ? [
          `## Head-to-head (${common.length} test messages every system scored)`,
          '',
          ...ran.flatMap((system) => [
            accuracyLine(`${system.name} 5-way (INFO + NONE = NO_TRADE)`, toMerged(pairsFor(system))),
            accuracyLine(`${system.name} coarse`, toCoarse(pairsFor(system))),
          ]),
          '',
        ]
      : []),
    `## Disagreements on the test split (${disagreements.length})`,
    '',
    ...disagreements.flatMap((d) => [
      `- ${d.costly ? '⚠ costly · ' : ''}you: **${d.truth}** · ` +
        systems.map((system) => `${system.name}: ${system.describe(d.id)}`).join(' · ') +
        ` · \`${d.id}\``,
      `  > ${(textById.get(d.id) ?? '').replace(/\s+/g, ' ')}`,
    ]),
  ];
  const markdown = lines.join('\n') + '\n';
  console.log(markdown);
  writeFileSync(paths.report, markdown);
  console.log(`written → ${paths.report}`);
}

// ---------------------------------------------------------------------------
// decide — replay the production Jev decider before deploy (docs/adr/0002)
// ---------------------------------------------------------------------------

/** One replayed message: what Jev answered and what the decider would trade. */
type DecideRecord =
  | {
      readonly ok: true;
      readonly id: string;
      readonly at: string;
      /** Null for an empty message, which never reaches Jev. */
      readonly choice: Action | null;
      readonly probability: number | null;
      readonly actingNow: number | null;
      readonly patternRead: string | null;
      readonly pattern: string | null;
      readonly trade: 'BUY' | 'TRIM' | 'SELL' | null;
      readonly route: 'automatic' | 'approval' | null;
      /** Null on a contract-less exit, which the pipeline resolves or skips. */
      readonly contract: string | null;
      readonly rationale: string;
    }
  | { readonly ok: false; readonly id: string; readonly at: string; readonly error: string };

type DecideSuccess = Extract<DecideRecord, { ok: true }>;

/** A row of a `messages` export: the psql query `decide --source` reads (see USAGE). */
interface ExportRow {
  readonly id: string;
  readonly ts: string;
  readonly author: string;
  readonly author_id: string;
  readonly channel_id?: string;
  readonly content: string | null;
  readonly embeds: Record<string, unknown>[] | null;
  readonly reply_to?: string | null;
  readonly disposition: string | null;
  readonly parse: ParsedCallout | null;
}

/** Reference ids from the Oct 4 test: state/action-demo-db/replay-gates.json. */
interface ReplayGates {
  readonly followedMissedEntries: readonly string[];
  readonly averagingPosts: readonly string[];
  readonly bishopExits: readonly string[];
}

// The plan's ship bars: the Oct 4 test's numbers, within run-to-run noise.
const GATE_ACCURACY_MIN = 0.84;
const GATE_WRONG_ENTRIES_MAX = 1;
const GATE_EXITS_CAUGHT_MIN = 60;
const GATE_FOLLOWED_ENTRIES_MIN = 20;
/** TypeSafe allows 1,200 requests a minute; one start every 60 ms stays under it. */
const DECIDE_START_INTERVAL_MS = 60;
const DECIDE_CONCURRENCY = 4;
const DEFAULT_GATES_FILE = fileURLToPath(new URL('../../state/action-demo-db/replay-gates.json', import.meta.url));

type Decider = InstanceType<typeof import('../trader/pipeline/decide.js').JevCalloutDecider>;

const EXIT_TRADES: ReadonlySet<string> = new Set(['TRIM', 'SELL']);

/** Variant A's gate as the test scored it: a Buy or Average not called now is NONE, unless a template read Buy. */
function replayedChoice(record: DecideSuccess): Action {
  const choice = record.choice ?? 'NONE';
  const gated = (choice === 'BUY' || choice === 'AVERAGE') && (record.actingNow ?? 0) < 0.3;
  return gated && !(choice === 'BUY' && record.patternRead === 'BUY') ? 'NONE' : choice;
}

async function replayOne(decider: Decider, envelope: DiscordEnvelope): Promise<DecideRecord> {
  const at = new Date().toISOString();
  try {
    const { callout, patterns, verdict } = await decider.decideTraced(envelope);
    const trade = !callout.isCallout
      ? null
      : callout.action === 'buy'
        ? 'BUY'
        : verdict?.choice === 'TRIM'
          ? 'TRIM'
          : 'SELL';
    return {
      ok: true,
      id: envelope.messageId,
      at,
      choice: verdict?.choice ?? null,
      probability: verdict ? verdict.probabilities[verdict.choice] : null,
      actingNow: verdict?.actingNow ?? null,
      patternRead: patterns.read,
      pattern: patterns.pattern,
      trade,
      route: trade ? (callout.reviewReason ? 'approval' : 'automatic') : null,
      contract: callout.option
        ? `${callout.ticker} ${callout.option.strike}${callout.option.optionType[0]!.toUpperCase()} ${callout.option.expiration}`
        : null,
      rationale: callout.rationale,
    };
  } catch (err) {
    return { ok: false, id: envelope.messageId, at, error: errorMessage(err) };
  }
}

/** A few requests in flight, starts paced under TypeSafe's rate limit. */
async function replayAll(decider: Decider, envelopes: readonly DiscordEnvelope[], file: string): Promise<void> {
  let next = 0;
  let nextStartAt = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < envelopes.length) {
      const envelope = envelopes[next++]!;
      const startAt = Math.max(Date.now(), nextStartAt);
      nextStartAt = startAt + DECIDE_START_INTERVAL_MS;
      await sleep(startAt - Date.now());
      const record = await replayOne(decider, envelope);
      appendJsonl(file, record);
      done += 1;
      if (!record.ok) console.log(`${record.id} error ${record.error}`);
      if (done % 100 === 0) console.log(`${done}/${envelopes.length}`);
    }
  };
  await Promise.all(Array.from({ length: DECIDE_CONCURRENCY }, worker));
}

function labeledEnvelopes(dir: string): DiscordEnvelope[] {
  const corpus = readCorpus(dir);
  const { truths } = readTruths(dir, corpus);
  return corpus
    .filter((row) => truths.has(row.id))
    .map((row) =>
      flattenEnvelope({
        messageId: row.id,
        channelId: 'replay',
        guildId: null,
        authorId: 'replay',
        authorName: row.caller ?? 'replay',
        authorAvatarUrl: null,
        content: row.text,
        timestamp: row.ts ?? new Date().toISOString(),
      })
    );
}

function exportEnvelopes(rows: readonly ExportRow[]): DiscordEnvelope[] {
  return rows.map((row) =>
    flattenEnvelope({
      messageId: row.id,
      channelId: row.channel_id ?? 'replay',
      guildId: null,
      authorId: row.author_id,
      authorName: row.author,
      authorAvatarUrl: null,
      content: row.content ?? '',
      embeds: row.embeds ?? [],
      timestamp: row.ts,
      replyToMessageId: row.reply_to ?? null,
    })
  );
}

const verdictLine = (pass: boolean, text: string): string => `${pass ? 'PASS' : 'FAIL'}  ${text}`;

function bishopLine(records: ReadonlyMap<string, DecideSuccess>, gates: ReplayGates | null): string[] {
  const exits = (gates?.bishopExits ?? []).filter((id) => records.has(id));
  if (exits.length === 0) return [];
  const sells = exits.filter((id) => records.get(id)!.trade === 'SELL').length;
  return [verdictLine(sells === exits.length, `Bishop exits back as Sell: ${sells} of ${exits.length}`)];
}

function averagingLine(records: ReadonlyMap<string, DecideSuccess>, gates: ReplayGates | null): string[] {
  const posts = (gates?.averagingPosts ?? []).filter((id) => records.has(id));
  if (posts.length === 0) return [];
  const traded = posts.filter((id) => records.get(id)!.trade === 'BUY');
  return [verdictLine(traded.length === 0, `averaging posts traded: ${traded.length} of ${posts.length} ${traded.join(' ')}`)];
}

function routingLine(records: readonly DecideSuccess[]): string {
  return `trades: ${JSON.stringify(countBy(records.filter((r) => r.trade), (r) => `${r.trade} ${r.route}`))}`;
}

function reportLabeledReplay(dir: string, records: ReadonlyMap<string, DecideSuccess>, gates: ReplayGates | null): void {
  const { truths } = readTruths(dir, readCorpus(dir));
  const scored = [...truths].filter(([id]) => records.has(id));
  const merged = (action: Action): MergedAction => mergedAction(action);
  let right = 0;
  let wrongEntries = 0;
  let falseExits = 0;
  let exitsCaught = 0;
  let exitsExact = 0;
  const nonTradesTraded: string[] = [];
  for (const [id, truth] of scored) {
    const record = records.get(id)!;
    right += merged(replayedChoice(record)) === merged(truth) ? 1 : 0;
    if (record.trade === 'BUY' && truth !== 'BUY') wrongEntries += 1;
    if (record.trade && EXIT_TRADES.has(record.trade)) {
      if (EXIT_TRADES.has(truth)) exitsCaught += 1;
      else falseExits += 1;
      if (record.trade === truth) exitsExact += 1;
    }
    if (record.trade && (truth === 'INFO' || truth === 'NONE')) nonTradesTraded.push(`${id} ${record.trade} ${record.route}`);
  }
  const exitLabels = scored.filter(([, truth]) => EXIT_TRADES.has(truth)).length;
  const accuracy = scored.length ? right / scored.length : 0;
  console.log(
    [
      `labeled replay: ${scored.length} of ${truths.size} labeled messages answered`,
      verdictLine(accuracy >= GATE_ACCURACY_MIN, `5-way accuracy ${pct(accuracy)} (bar ${pct(GATE_ACCURACY_MIN)}; test 85.4%)`),
      verdictLine(wrongEntries <= GATE_WRONG_ENTRIES_MAX, `wrong entries ${wrongEntries} (bar ${GATE_WRONG_ENTRIES_MAX}; test 0)`),
      verdictLine(exitsCaught >= GATE_EXITS_CAUGHT_MIN, `exits caught ${exitsCaught} of ${exitLabels} (bar ${GATE_EXITS_CAUGHT_MIN}; test 61), ${exitsExact} as the exact kind`),
      `false exits ${falseExits} (test 7)`,
      `non-trades that would trade: ${nonTradesTraded.length}${nonTradesTraded.length ? ` — ${nonTradesTraded.join('; ')}` : ''}`,
      ...bishopLine(records, gates),
      ...averagingLine(records, gates),
      routingLine([...records.values()]),
    ].join('\n')
  );
}

/** The parser's verdict on an exported row, as a direction. */
function parserDirection(row: ExportRow): 'entry' | 'exit' | 'none' {
  if (row.disposition !== 'callout') return 'none';
  const action = parserAction(row.parse);
  return action === 'BUY' || action === 'AVERAGE' ? 'entry' : action === 'TRIM' || action === 'SELL' ? 'exit' : 'none';
}

function reportExportReplay(
  rows: readonly ExportRow[],
  records: ReadonlyMap<string, DecideSuccess>,
  gates: ReplayGates | null,
  since: string | undefined
): void {
  const answered = rows.filter((row) => records.has(row.id));
  const direction = (record: DecideSuccess): 'entry' | 'exit' | 'none' =>
    record.trade === 'BUY' ? 'entry' : record.trade ? 'exit' : 'none';
  const matrix = countBy(answered, (row) => `parser ${parserDirection(row)} → jev ${direction(records.get(row.id)!)}`);
  const targets = (gates?.followedMissedEntries ?? []).filter((id) => records.has(id));
  const recovered = targets.filter((id) => records.get(id)!.trade === 'BUY');
  const lines = [
    `export replay: ${answered.length} of ${rows.length} messages answered${since ? ` (sent on or after ${since})` : ''}`,
    `parser vs decider: ${JSON.stringify(matrix)}`,
    ...(targets.length
      ? [
          verdictLine(
            recovered.length >= GATE_FOLLOWED_ENTRIES_MIN,
            `followed missed entries traded: ${recovered.length} of ${targets.length} (bar ${GATE_FOLLOWED_ENTRIES_MIN}; test 22) ${JSON.stringify(countBy(recovered, (id) => records.get(id)!.route ?? ''))}`
          ),
        ]
      : []),
    ...bishopLine(records, gates),
    ...averagingLine(records, gates),
    routingLine([...records.values()]),
  ];
  // Messages the templates were never written against: every disagreement gets a human look.
  if (since) {
    const disagreements = answered.filter((row) => parserDirection(row) !== direction(records.get(row.id)!));
    lines.push(`disagreements to review: ${disagreements.length}`);
    for (const row of disagreements) {
      const record = records.get(row.id)!;
      const text = (row.content || JSON.stringify(row.embeds ?? [])).replace(/\s+/g, ' ').slice(0, 160);
      lines.push(
        `  ${row.ts} ${row.author} | parser ${parserDirection(row)} | jev ${record.choice} ${record.probability?.toFixed(2)} → ${record.trade ?? 'no trade'} ${record.route ?? ''} | ${text}`
      );
    }
  }
  console.log(lines.join('\n'));
}

async function decideCommand(
  dir: string,
  opts: { source?: string; since?: string; gates: string; limit: number }
): Promise<void> {
  const apiKey = process.env.JEV_API_KEY?.trim();
  if (!apiKey) fail('JEV_API_KEY is not set (repo-root .env); it is sent to api.typesafe.ai only');
  let decider: Decider;
  try {
    // Imported here: decide.ts loads parseCallout, whose shared/config requires LLM_MODEL.
    const [{ JevCalloutDecider }, { JevClient }] = await Promise.all([
      import('../trader/pipeline/decide.js'),
      import('../trader/pipeline/jev.js'),
    ]);
    decider = new JevCalloutDecider(new JevClient({ apiKey, model: process.env.JEV_MODEL?.trim() || undefined }));
  } catch (err) {
    fail(`decider unavailable: ${errorMessage(err)}`);
  }

  const rows = opts.source
    ? readJsonl<ExportRow>(resolve(opts.source)).filter((row) => !opts.since || row.ts >= opts.since)
    : [];
  const envelopes = opts.source ? exportEnvelopes(rows) : labeledEnvelopes(dir);
  const file = join(dir, `decide-${opts.source ? basename(opts.source, '.jsonl') : 'labeled'}.jsonl`);
  const answered = new Set(
    readJsonl<DecideRecord>(file)
      .filter((record) => record.ok)
      .map((record) => record.id)
  );
  const pending = envelopes.filter((envelope) => !answered.has(envelope.messageId)).slice(0, opts.limit);
  console.log(`decide: ${pending.length} to replay, ${answered.size} already answered → ${file}`);
  await replayAll(decider, pending, file);

  const records = new Map(
    readJsonl<DecideRecord>(file).flatMap((record): [string, DecideSuccess][] => (record.ok ? [[record.id, record]] : []))
  );
  const gates = existsSync(opts.gates) ? (JSON.parse(readFileSync(opts.gates, 'utf8')) as ReplayGates) : null;
  if (opts.source) reportExportReplay(rows, records, gates, opts.since);
  else reportLabeledReplay(dir, records, gates);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const USAGE = `usage: bun src/scripts/actionDemo.ts <command> [options]
  sample        [--size all] [--seed 42] [--force]   build corpus.jsonl from local sources
  label         [--dry-run] [--relabel]              blind keyboard labeler (B A T S I N U K Q);
                                                     --relabel re-shows your NONE/UNSURE labels
  laya          [--tag ft] [--limit N] [--model english] [--gate]  one LAYA choice call per message (--gate adds the act-now yes/no)
  parser        [--live] [--limit N]                 saved verdicts; --live re-runs the parser (LLM cost)
  export-train  [--seed 42]                          train split → train.jsonl {id, text, label} + question.json
  report        [--seed 42]                          test split: LAYA untrained vs fine-tuned vs parser
  decide        [--source export.jsonl] [--since ISO] [--gates file] [--limit N]
                                                     replay the production Jev decider (JEV_API_KEY, cents);
                                                     labeled set by default, or a messages export scored
                                                     against the parser; --since lists every disagreement
  every command: --dir <path> (default server/state/action-demo)

A messages export for decide --source, run read-only from server/:
  PGOPTIONS='-c default_transaction_read_only=on' psql "$SUPABASE_DB_URL" -X -q -t -A -c "SELECT json_build_object('id', id, 'ts', sent_at, 'channel_id', channel_id, 'author', author_name, 'author_id', author_id, 'content', content, 'embeds', embeds, 'reply_to', raw->>'reference_id', 'disposition', disposition, 'parse', parse)::text FROM messages WHERE deleted_at IS NULL AND sent_at >= '2026-10-05' AND disposition IN ('callout', 'not_callout', 'failed') ORDER BY sent_at" > state/action-demo-db/messages-new.jsonl`;

function numberFlag(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a non-negative number, got "${raw}"`);
  return value;
}

async function main(argv: readonly string[]): Promise<void> {
  loadDotenv({ path: ROOT_ENV_FILE, quiet: true });
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      dir: { type: 'string', default: DEFAULT_DIR },
      size: { type: 'string', default: 'all' },
      seed: { type: 'string', default: '42' },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      relabel: { type: 'boolean', default: false },
      limit: { type: 'string' },
      model: { type: 'string', default: LAYA_DEFAULT_MODEL },
      tag: { type: 'string' },
      gate: { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      source: { type: 'string' },
      since: { type: 'string' },
      gates: { type: 'string', default: DEFAULT_GATES_FILE },
    },
  });
  const dir = resolve(values.dir);
  const seed = numberFlag('seed', values.seed);
  const limit = values.limit === undefined ? Infinity : numberFlag('limit', values.limit);

  switch (positionals[0]) {
    case 'sample':
      return sampleCommand(
        dir,
        values.size === 'all' ? Infinity : numberFlag('size', values.size),
        seed,
        values.force
      );
    case 'label':
      return labelCommand(dir, values['dry-run'], values.relabel);
    case 'laya':
      return layaCommand(dir, limit, values.model, values.tag, values.gate);
    case 'parser':
      return parserCommand(dir, values.live, limit);
    case 'export-train':
      return exportTrainCommand(dir, seed);
    case 'report':
      return reportCommand(dir, seed);
    case 'decide':
      return decideCommand(dir, {
        source: values.source,
        since: values.since,
        gates: resolve(values.gates),
        limit,
      });
    default:
      fail(USAGE);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((err: unknown) => fail(errorMessage(err)));
}
