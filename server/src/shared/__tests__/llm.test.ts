/**
 * createLlmProvider tests — mocked at the TanStack adapter boundary so the
 * real chat() structured-output pipeline runs (schema conversion, adapter
 * structuredOutput call, result finalization) without any network access.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolJsonSchema } from '../types.js';

const mockConfig = vi.hoisted(() => ({
  llmProvider: 'ollama' as string,
  llmModel: 'test-model',
  ollamaBaseUrl: 'http://localhost:11434',
  openaiApiKey: 'sk-test-openai',
  anthropicApiKey: 'sk-test-anthropic',
}));

vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('@tanstack/ai-ollama', () => ({ createOllamaChat: vi.fn() }));
vi.mock('@tanstack/ai-openai', () => ({ createOpenaiChat: vi.fn() }));
vi.mock('@tanstack/ai-anthropic', () => ({ createAnthropicChat: vi.fn() }));

import { createAnthropicChat } from '@tanstack/ai-anthropic';
import { createOllamaChat } from '@tanstack/ai-ollama';
import { createOpenaiChat } from '@tanstack/ai-openai';
import { createLlmProvider } from '../llm.js';

const TOOL_SCHEMA: ToolJsonSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['ticker', 'confidence'],
  additionalProperties: false,
};

const CALL_OPTS = {
  system: 'You extract trade callouts.',
  user: 'buy AAPL',
  tool: { name: 'report_callout', description: 'Report the callout.', schema: TOOL_SCHEMA },
};

const ResultSchema = z.object({ ticker: z.string(), confidence: z.number() });

/**
 * Minimal TextAdapter standing in for a provider: chat() falls back to the
 * non-streaming structuredOutput() when the adapter has no
 * structuredOutputStream, so this is the only method that must respond.
 */
function fakeAdapter(rawJson: string) {
  const structuredOutput = vi.fn(
    async (_options: { outputSchema: unknown }) => ({
      data: JSON.parse(rawJson) as unknown,
      rawText: rawJson,
    })
  );
  const adapter = {
    kind: 'text' as const,
    name: 'fake',
    model: 'test-model',
    chatStream: () => {
      throw new Error('chatStream must not be called for structured output');
    },
    structuredOutput,
  };
  return { adapter, structuredOutput };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.llmProvider = 'ollama';
  mockConfig.llmModel = 'test-model';
});

describe('createLlmProvider', () => {
  it('throws on an unknown provider', () => {
    mockConfig.llmProvider = 'bogus';
    expect(() => createLlmProvider()).toThrow(/Unknown LLM_PROVIDER: bogus/);
  });

  it('ollama path: fake LLM JSON comes back parsed and zod-valid', async () => {
    const raw = JSON.stringify({ ticker: 'AAPL', confidence: 0.9 });
    const { adapter, structuredOutput } = fakeAdapter(raw);
    vi.mocked(createOllamaChat).mockReturnValue(adapter as never);

    const result = await createLlmProvider().callStructured(CALL_OPTS);

    expect(vi.mocked(createOllamaChat)).toHaveBeenCalledWith('test-model', 'http://localhost:11434');
    expect(ResultSchema.parse(result)).toEqual({ ticker: 'AAPL', confidence: 0.9 });

    const providerCall = structuredOutput.mock.calls[0]?.[0] as {
      outputSchema: { properties: Record<string, unknown> };
      chatOptions: { systemPrompts: string[]; messages: Array<{ role: string }> };
    };
    expect(Object.keys(providerCall.outputSchema.properties)).toEqual(['ticker', 'confidence']);
    expect(providerCall.chatOptions.systemPrompts[0]).toBe(CALL_OPTS.system);
    expect(providerCall.chatOptions.messages.at(-1)).toMatchObject({ role: 'user' });
  });

  it('openai path: adapter is built with the configured key and returns parsed output', async () => {
    mockConfig.llmProvider = 'openai';
    const raw = JSON.stringify({ ticker: 'MSFT', confidence: 0.8 });
    const { adapter } = fakeAdapter(raw);
    vi.mocked(createOpenaiChat).mockReturnValue(adapter as never);

    const result = await createLlmProvider().callStructured(CALL_OPTS);

    expect(vi.mocked(createOpenaiChat)).toHaveBeenCalledWith('test-model', 'sk-test-openai');
    expect(ResultSchema.parse(result)).toEqual({ ticker: 'MSFT', confidence: 0.8 });
    expect(vi.mocked(createAnthropicChat)).not.toHaveBeenCalled();
  });

  it('openai reasoning model: temperature is omitted from model options', async () => {
    mockConfig.llmProvider = 'openai';
    mockConfig.llmModel = 'gpt-5-mini';
    const raw = JSON.stringify({ ticker: 'MSFT', confidence: 0.8 });
    const { adapter, structuredOutput } = fakeAdapter(raw);
    vi.mocked(createOpenaiChat).mockReturnValue(adapter as never);

    await createLlmProvider().callStructured(CALL_OPTS);

    expect(JSON.stringify(structuredOutput.mock.calls[0]?.[0])).not.toContain('"temperature"');
  });
});
