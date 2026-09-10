/**
 * createLlmProvider tests — mocked at the TanStack adapter boundary so the
 * real chat() structured-output pipeline runs (schema conversion, adapter
 * structuredOutput call, result finalization) without any network access.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolJsonSchema } from '../types.js';

const mockConfig = vi.hoisted(() => ({
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
  mockConfig.llmModel = 'test-model';
  mockConfig.openaiApiKey = 'sk-test-openai';
  mockConfig.anthropicApiKey = 'sk-test-anthropic';
});

describe('createLlmProvider', () => {
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

  it('openai path: inferred from the model id, built with the configured key', async () => {
    mockConfig.llmModel = 'gpt-4o';
    const raw = JSON.stringify({ ticker: 'MSFT', confidence: 0.8 });
    const { adapter } = fakeAdapter(raw);
    vi.mocked(createOpenaiChat).mockReturnValue(adapter as never);

    const result = await createLlmProvider().callStructured(CALL_OPTS);

    expect(vi.mocked(createOpenaiChat)).toHaveBeenCalledWith('gpt-4o', 'sk-test-openai');
    expect(ResultSchema.parse(result)).toEqual({ ticker: 'MSFT', confidence: 0.8 });
    expect(vi.mocked(createAnthropicChat)).not.toHaveBeenCalled();
    expect(vi.mocked(createOllamaChat)).not.toHaveBeenCalled();
  });

  it('anthropic path: inferred from a Claude model id', async () => {
    mockConfig.llmModel = 'claude-sonnet-4-5';
    const raw = JSON.stringify({ ticker: 'NVDA', confidence: 0.7 });
    const { adapter } = fakeAdapter(raw);
    vi.mocked(createAnthropicChat).mockReturnValue(adapter as never);

    const result = await createLlmProvider().callStructured(CALL_OPTS);

    expect(vi.mocked(createAnthropicChat)).toHaveBeenCalledWith(
      'claude-sonnet-4-5',
      'sk-test-anthropic'
    );
    expect(ResultSchema.parse(result)).toEqual({ ticker: 'NVDA', confidence: 0.7 });
    expect(vi.mocked(createOpenaiChat)).not.toHaveBeenCalled();
  });

  it('openai reasoning model: temperature is omitted from model options', async () => {
    mockConfig.llmModel = 'gpt-5-mini';
    const raw = JSON.stringify({ ticker: 'MSFT', confidence: 0.8 });
    const { adapter, structuredOutput } = fakeAdapter(raw);
    vi.mocked(createOpenaiChat).mockReturnValue(adapter as never);

    await createLlmProvider().callStructured(CALL_OPTS);

    expect(JSON.stringify(structuredOutput.mock.calls[0]?.[0])).not.toContain('"temperature"');
  });

  it('strips an explicit backend prefix before constructing the adapter', async () => {
    mockConfig.llmModel = 'ollama/gpt-4o';
    const raw = JSON.stringify({ ticker: 'AAPL', confidence: 0.9 });
    const { adapter } = fakeAdapter(raw);
    vi.mocked(createOllamaChat).mockReturnValue(adapter as never);

    await createLlmProvider().callStructured(CALL_OPTS);

    expect(vi.mocked(createOllamaChat)).toHaveBeenCalledWith('gpt-4o', 'http://localhost:11434');
    expect(vi.mocked(createOpenaiChat)).not.toHaveBeenCalled();
  });

  it('routes a colon-tagged gpt-oss id to ollama, not openai', async () => {
    mockConfig.llmModel = 'gpt-oss:20b';
    const { adapter } = fakeAdapter('{}');
    vi.mocked(createOllamaChat).mockReturnValue(adapter as never);

    await createLlmProvider().callStructured(CALL_OPTS);

    expect(vi.mocked(createOllamaChat)).toHaveBeenCalledWith('gpt-oss:20b', 'http://localhost:11434');
    expect(vi.mocked(createOpenaiChat)).not.toHaveBeenCalled();
  });

  it('strips openai/ before constructing the OpenAI adapter', async () => {
    mockConfig.llmModel = 'openai/gpt-4o';
    const { adapter } = fakeAdapter('{}');
    vi.mocked(createOpenaiChat).mockReturnValue(adapter as never);

    await createLlmProvider().callStructured(CALL_OPTS);

    expect(vi.mocked(createOpenaiChat)).toHaveBeenCalledWith('gpt-4o', 'sk-test-openai');
  });

  it('keeps an unknown namespace/tag as a full ollama model id', async () => {
    mockConfig.llmModel = 'myorg/custom:tag';
    const { adapter } = fakeAdapter('{}');
    vi.mocked(createOllamaChat).mockReturnValue(adapter as never);

    await createLlmProvider().callStructured(CALL_OPTS);

    expect(vi.mocked(createOllamaChat)).toHaveBeenCalledWith(
      'myorg/custom:tag',
      'http://localhost:11434'
    );
  });

  it('rejects a known prefix with no model', () => {
    mockConfig.llmModel = 'openai/';
    expect(() => createLlmProvider()).toThrow(/missing a model after "openai\/"/);
  });

  it('requires OPENAI_API_KEY when the model routes to OpenAI', () => {
    mockConfig.llmModel = 'gpt-4o';
    mockConfig.openaiApiKey = '';
    expect(() => createLlmProvider()).toThrow(/OPENAI_API_KEY is required/);
  });
});
