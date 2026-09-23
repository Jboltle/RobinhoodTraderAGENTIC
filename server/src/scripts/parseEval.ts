/**
 * Parse eval harness — replay a corpus of real Discord messages through the
 * live parser and report invariant violations. This is how parser regressions
 * are found: feed it prod data and see what breaks, instead of hand-building
 * per-caller templates for yesterday's failure.
 *
 *   psql "$DB_URL" -t -A -c "SELECT json_build_object('id', id, 'ts', sent_at,
 *     'content', content, 'embeds', embeds)::text FROM messages ..." > corpus.jsonl
 *   bun run eval:parse corpus.jsonl
 *
 * Each row: { id?, ts, content, embeds? } — content is the raw message body,
 * embeds the raw Discord embed JSON; flattening happens here exactly as in
 * the trade pipeline. Deterministic/pre-filter paths cost no LLM calls;
 * LLM-path messages are parsed live with the configured model.
 *
 * Invariants are heuristic tripwires, not ground truth: a VIOLATION is a
 * parse that contradicts position-lifecycle language in the message itself
 * and deserves a human look; a WARN is a smell worth sampling.
 */
import { readFileSync } from 'node:fs';

import { flattenEnvelope } from '../shared/embedText.js';
import type { Callout, DiscordEnvelope } from '../shared/types.js';
import { LlmCalloutParser } from '../trader/pipeline/parseCallout.js';

interface CorpusRow {
  readonly id?: string;
  readonly ts: string;
  readonly content: string;
  readonly embeds?: unknown[];
}

interface Finding {
  readonly severity: 'VIOLATION' | 'WARN';
  readonly rule: string;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Caller-agnostic invariants over (flattened message text, parse verdict)
// ---------------------------------------------------------------------------

const EXIT_STATUS =
  /\b(?:fully\s+out|sold\s+(?:all|everything)|closed\s+(?:all|everything|out)|stopped\s+out)\b/i;
const ADD_STATUS = /\baverag(?:e|ing|ed)\s+(?:down|up|in)\b|\badded\s+\d+\s*(?:more\b|@)/i;
const EXPIRED_STATUS = /\bexpired\b/i;
const RECAP_LANGUAGE =
  /\bdaily\s+recap\b|\bwin\s+rate\b|\bleaderboard\b|\bperformance\s+recap\b/i;
const CONTRACT_TOKEN = /\b[A-Z]{1,6}\s+\d+(?:\.\d+)?\s?[CP]\b/;

/** Every "X → Y" price pair in the text; the right side is a status/target price. */
function arrowTargets(text: string): number[] {
  const targets: number[] = [];
  for (const match of text.matchAll(
    /\$?(\d+(?:\.\d+)?)\s*(?:→|->|⇒)\s*\$?(\d+(?:\.\d+)?)/g
  )) {
    targets.push(Number(match[2]));
  }
  return targets;
}

function checkInvariants(text: string, callout: Callout): Finding[] {
  const findings: Finding[] = [];
  const flag = (severity: Finding['severity'], rule: string, detail: string): void => {
    findings.push({ severity, rule, detail });
  };

  if (callout.isCallout) {
    if (callout.action === 'buy' && !callout.isAddition && ADD_STATUS.test(text)) {
      flag('VIOLATION', 'add-as-entry',
        'averaging-down/add language parsed as a fresh entry (isAddition=false)');
    }
    if (callout.action === 'buy' && EXIT_STATUS.test(text)) {
      flag('VIOLATION', 'exit-as-buy', 'exit-status language parsed as a buy');
    }
    if (RECAP_LANGUAGE.test(text)) {
      flag('VIOLATION', 'recap-as-callout', 'recap/performance language parsed as a callout');
    }
    if (callout.limitPrice !== null && arrowTargets(text).includes(callout.limitPrice)) {
      flag('VIOLATION', 'arrow-target-as-limit',
        `limit price ${callout.limitPrice} is the right side of a status arrow (X → Y)`);
    }
    if (EXPIRED_STATUS.test(text)) {
      flag('WARN', 'trade-on-expired-language', 'callout from a message mentioning expiry status');
    }
    if (callout.action === 'sell' && callout.orderType === 'limit') {
      flag('WARN', 'limit-exit', 'exits should be market orders; limit came from message prices');
    }
    if (callout.confidence < 0.6) {
      flag('WARN', 'low-confidence-callout', `confidence ${callout.confidence}`);
    }
  } else if (EXIT_STATUS.test(text) && CONTRACT_TOKEN.test(text)) {
    flag('WARN', 'possible-missed-exit',
      'exit-status language with a contract token classified as non-callout');
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const file = process.argv[2];
if (!file) {
  console.error('usage: bun run eval:parse <corpus.jsonl>');
  process.exit(1);
}

const rows: CorpusRow[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as CorpusRow);

const parser = new LlmCalloutParser();
const ruleCounts = new Map<string, number>();
const pathCounts = new Map<string, number>();
let flagged = 0;
let llmCalls = 0;

for (const [index, row] of rows.entries()) {
  const envelope = flattenEnvelope({
    messageId: row.id ?? `eval-${index}`,
    channelId: 'eval',
    guildId: null,
    authorId: 'eval',
    authorName: 'eval',
    authorAvatarUrl: null,
    content: row.content ?? '',
    embeds: (row.embeds ?? []) as DiscordEnvelope['embeds'],
    timestamp: row.ts,
  } as DiscordEnvelope);

  let traced;
  try {
    traced = await parser.parseTraced(envelope);
  } catch (err) {
    flagged += 1;
    ruleCounts.set('parse-error', (ruleCounts.get('parse-error') ?? 0) + 1);
    console.log(`VIOLATION parse-error       ${row.id ?? index}: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  llmCalls += traced.llmCalls;
  pathCounts.set(traced.path, (pathCounts.get(traced.path) ?? 0) + 1);

  const findings = checkInvariants(envelope.content, traced.callout);
  if (findings.length === 0) continue;

  flagged += 1;
  const headline = envelope.content.replace(/\s+/g, ' ').slice(0, 70);
  for (const finding of findings) {
    ruleCounts.set(finding.rule, (ruleCounts.get(finding.rule) ?? 0) + 1);
    console.log(
      `${finding.severity.padEnd(9)} ${finding.rule.padEnd(24)} ${row.id ?? index} [${traced.path}] ${finding.detail}\n` +
      `          msg: ${headline}`
    );
  }
}

console.log('\n--- summary ---');
console.log(`messages: ${rows.length}, flagged: ${flagged}, llmCalls: ${llmCalls}`);
console.log('paths:', Object.fromEntries(pathCounts));
console.log('rules:', Object.fromEntries(ruleCounts));
