# Session Context — rh-discord-trader refactor (resume file)

Written 2026-07-14 ~8:40 PM. Caveman-compressed. Read with plan file:
`/home/on/.cursor/plans/refactor_and_deploy_trader_f94c450c.plan.md` (compressed; verbose backup = same name `.original.md`).

## Project

Discord→Robinhood auto-trader. Two services: `src/bot/` (Discord gateway, forwards signed envelopes) + `src/trader/` (Fastify webhook → LLM parse → risk filter → Robinhood MCP order). Shared code `src/shared/`. State files `state/`. Git repo, commits "test"/"working on it", many uncommitted changes.

## Locked decisions (user Q&A)

- Bot + trader stay separate services. Keep HMAC webhookAuth (bot→trader trust boundary).
- Self-hosted deployment, each user own instance + own Robinhood. Docker compose.
- Runtime = Bun everywhere. Keep vitest for tests, tsc --noEmit typecheck.
- LLM: ONE factory in `src/shared/llm.ts` via TanStack AI adapters (`@tanstack/ai` + ai-ollama/ai-openai/ai-anthropic). Default provider = ollama, model qwen3:8b. Stability gate: TanStack broken → swap factory internals to Vercel AI SDK v6, same `LlmProvider` interface. `LLM_PROVIDER` typed `z.enum(['ollama','openai','anthropic'])`, fail-fast boot.
- MCP client: keep hand-rolled wrapper (shrink-only), NO @tanstack/ai-mcp in phase 1.
- OAuth: delete Codex import path entirely; persist refresh_token; SDK auto-refresh; harness-agnostic for free.
- Settings: `TradeSettingsSchema` zod, all optional. Webhook body `{ envelope, settings? }`. Resolution payload → state/settings.json → env default. Cooldown STATE stays trader-side (`state/risk.json`); payload = params only.
- Phase 2: `client/` folder at root, TanStack Start. Settings in client state, ride as payload override. Wiring mechanism (push/pull/proxy) = ask user AFTER phase 1 review. Figma kit via /understand-figma; user has FIGMA_TOKEN PAT (ask user for it, never write to files).
- Subagents: cavecrew-investigator locate → karpathy-ponytail implement → cavecrew-reviewer audit → cavecrew-builder ≤2-file fixes. Caveman-terse chat outside plans.

## Environment facts

- Bun 1.2.18. WSL2 Ubuntu on Windows.
- GPU = RTX 3060 **12GB** (plan text says 3060 Ti 8GB — wrong, 12GB confirmed via nvidia-smi). Passthrough works.
- Ollama installed in WSL. Server must be started manually (`ollama serve`, no systemd autostart). qwen3:8b pull was IN PROGRESS at write time — verify `ollama list`.
- sudo needs password — can't install system packages non-interactively.

## Workstream status (updated 8:50 PM)

1. **1a Bun migration: DONE + reviewed.** typecheck clean, `bun build src/bot/index.ts src/trader/index.ts --outdir dist --target bun` works (dist/bot/index.js + dist/trader/index.js). tsx removed, bun.lock regenerated (patch bumps).
2. **1b LLM factory: DONE.** TanStack AI path worked, NO Vercel gate needed. llm.ts = 50-line factory (createOllamaChat/createOpenaiChat/createAnthropicChat + one `chat({ outputSchema })` call; outputSchema accepts raw ToolJsonSchema). config.ts: `requiredEnum` helper, LLM_PROVIDER + TRADE_EXECUTION_MODE fail-fast z.enum; `llmModel` (LLM_MODEL, default qwen3:8b) + `ollamaBaseUrl` replace per-provider models. New test src/shared/__tests__/llm.test.ts. Deps: +@tanstack/ai{,-ollama,-openai,-anthropic}, −@anthropic-ai/sdk −openai. **168 tests pass / 2 skipped** (new baseline). Live qwen3:8b smoke passed. ponytail note: maxTokens/temperature ride adapter defaults.
3. **1b-ii Ollama: DONE.** Installed in WSL, qwen3:8b pulled (5.2GB), GPU-verified. First load hit CUDA OOM once (transient, other apps held VRAM) — retry worked. Server needs manual `ollama serve` (no systemd autostart in this WSL). Structured JSON via /api/chat `format` works great. **qwen3 thinking mode ON by default — burns tokens (60s+); `think:false` → 0.7s.** FIXED: llm.ts spreads `modelOptions:{think:false}` when provider === 'ollama' (llm.ts:41-46, typecheck + tests verified).
4. **1c OAuth: USER-OWNED, HANDS OFF.** rh/ edits (importCodexTokens.ts deleted, tokenBootstrap gutted, mcpClient Codex sites removed) appeared mid-session — user editing concurrently; user ABORTED the dispatched OAuth worker. Do NOT reimplement. When user says ready: run verify only — `rg -i codex src/ package.json` empty, tests ≥168, typecheck, build, then live `bun run connect` (user does browser step) + restart-no-reprompt check + confirm refresh_token persisted in state/rh-tokens.json.
5. **1d embeds: NOT STARTED.** Root cause known: `buildMessageContent` (src/bot/messageAssembly.ts) ignores `message.embeds`; embed-only msgs dropped by `hasForwardableContent`; mirror never re-sends embeds. NOTE: bot files (index.ts, messageFilter.ts, types.ts) + parseCallout.ts also show uncommitted user edits — RE-READ current file state before dispatching, don't trust plan line numbers.
6. **1e type shrink / 1f REST API+settings: NOT STARTED.**
7. **1h Docker/deploy: NOT STARTED.**
- Phase 0 /understand knowledge graph: DONE. `.ua/knowledge-graph.json` saved (128 nodes, 283 edges, 8 layers, 14-step tour, 0 validation issues), analyzed at commit 2fb3374 — pre-refactor snapshot; run incremental update after phase 1 lands. Dashboard not launched (`/understand-dashboard` to view).

## Other notes

- `.env` fixed: LLM_PROVIDER=ollama, LLM_MODEL=qwen3:8b (was openai/gpt-4o-mini, would fail new fail-fast boot).
- `state/rh-tokens.json` WIPED by accidental rhResetAuth run during 1a verify. Re-auth needed at 1c verify (`bun run connect`).
- Baseline to preserve: ≥168 tests pass / 2 skipped.
- .env.example: LLM section done (workstream 2); risk-controls section moves to settings.json in workstream 5 (env stays fallback defaults).
- User pasted Figma PAT in old chat — advise rotation after phase 2; never commit it. Ask user to `export FIGMA_TOKEN=...` for /understand-figma.
- User works in repo concurrently — ALWAYS `git status` + re-read touched files before dispatching a workstream; scope prompts to exact current file state.
