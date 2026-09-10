/**
 * Interactive parse playground — paste a Discord message and see exactly how
 * the live parser classifies it (deterministic template, pre-filter, or LLM)
 * and what Callout it produces. Parse-only: nothing here touches Supabase,
 * Discord or a broker, so no order can ever result.
 *
 *   bun run test:parse-callout                                # interactive
 *   pbpaste | bun run test:parse-callout                      # one-shot stdin
 *   bun run test:parse-callout --timestamp 2026-07-20T14:20:00.000Z
 *
 * Interactive mode: paste a message (multi-line is fine, blank lines are
 * kept), then finish it with a line containing only `---`. Type `quit` on an
 * empty buffer (or Ctrl-C) to exit.
 *
 * Requires LLM_MODEL in .env. Deterministic and pre-filtered messages resolve
 * without ever invoking the model, so they work even when the model is down.
 */
import { createInterface } from 'node:readline';

import { config } from '../shared/config.js';
import type { Callout, DiscordEnvelope } from '../shared/types.js';
import { LlmCalloutParser, type TracedParse } from '../trader/pipeline/parseCallout.js';

const MESSAGE_TERMINATOR = '---';
const QUIT_COMMANDS = new Set(['quit', 'exit', 'q']);

function readTimestampArg(): string {
  const flagIndex = process.argv.indexOf('--timestamp');
  if (flagIndex === -1) return new Date().toISOString();
  const value = process.argv[flagIndex + 1];
  if (!value || !Number.isFinite(new Date(value).getTime())) {
    console.error('--timestamp must be followed by a valid ISO date, e.g. 2026-07-20T14:20:00.000Z');
    process.exit(1);
  }
  return new Date(value).toISOString();
}

function makeEnvelope(content: string, timestamp: string, sequence: number): DiscordEnvelope {
  return {
    messageId: `playground-${sequence}`,
    channelId: 'playground',
    guildId: null,
    authorId: 'playground',
    authorName: 'playground',
    authorAvatarUrl: null,
    content,
    timestamp,
  };
}

function summarizeDecision(callout: Callout): string {
  if (!callout.isCallout) return `NOT A CALLOUT — ${callout.rationale}`;
  const parts = [
    callout.action?.toUpperCase() ?? 'UNKNOWN',
    callout.ticker ?? '?',
    callout.assetType,
  ];
  if (callout.option) {
    parts.push(
      `${callout.option.strike}${callout.option.optionType === 'call' ? 'C' : 'P'}`,
      `exp ${callout.option.expiration}`
    );
  }
  parts.push(callout.orderType === 'limit' ? `limit ${callout.limitPrice}` : 'market');
  if (callout.positionSize) parts.push(`size=${callout.positionSize}`);
  if (callout.sizeHint) parts.push(`sizeHint=${callout.sizeHint.value} ${callout.sizeHint.kind}`);
  return parts.join(' ');
}

function printResult(traced: TracedParse): void {
  console.log('');
  console.log(`path: ${traced.path}   elapsed: ${traced.elapsedMs}ms   llmCalls: ${traced.llmCalls}`);
  console.log(`decision: ${summarizeDecision(traced.callout)}`);
  console.log(JSON.stringify(traced.callout, null, 2));
  console.log('');
}

async function parseAndPrint(
  parser: LlmCalloutParser,
  content: string,
  timestamp: string,
  sequence: number
): Promise<void> {
  try {
    printResult(await parser.parseTraced(makeEnvelope(content, timestamp, sequence)));
  } catch (err) {
    // Usually the LLM provider being unreachable; the loop should survive it.
    console.error(`parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runPipedMode(parser: LlmCalloutParser, timestamp: string): Promise<void> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  const content = data.trim();
  if (!content) {
    console.error('stdin was empty — pipe a Discord message in, or run interactively.');
    process.exit(1);
  }
  await parseAndPrint(parser, content, timestamp, 1);
}

function runInteractiveMode(parser: LlmCalloutParser, timestamp: string): void {
  console.log(`parse playground — model: ${config.llmModel}, reference timestamp: ${timestamp}`);
  console.log(`Paste a Discord message, then a line with only ${MESSAGE_TERMINATOR} to parse it. "quit" exits.`);
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let buffer: string[] = [];
  let sequence = 0;

  rl.on('line', (line) => {
    const trimmed = line.trim();

    if (buffer.length === 0 && QUIT_COMMANDS.has(trimmed.toLowerCase())) {
      rl.close();
      return;
    }

    if (trimmed !== MESSAGE_TERMINATOR) {
      buffer.push(line);
      return;
    }

    const content = buffer.join('\n').trim();
    buffer = [];
    if (!content) return;

    sequence += 1;
    rl.pause();
    void parseAndPrint(parser, content, timestamp, sequence).finally(() => rl.resume());
  });

  rl.on('close', () => process.exit(0));
}

const timestamp = readTimestampArg();
const parser = new LlmCalloutParser();

if (process.stdin.isTTY) {
  runInteractiveMode(parser, timestamp);
} else {
  await runPipedMode(parser, timestamp);
}
