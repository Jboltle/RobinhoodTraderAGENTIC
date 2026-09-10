import { chat } from '@tanstack/ai';
import { createAnthropicChat } from '@tanstack/ai-anthropic';
import { createOllamaChat } from '@tanstack/ai-ollama';
import { createOpenaiChat } from '@tanstack/ai-openai';

import { config } from './config.js';
import type { AnyTextAdapter, JSONSchema } from '@tanstack/ai';
import type { LlmProvider } from './types.js';

interface AdapterSetup {
  adapter: AnyTextAdapter;
  /** Provider-shaped options; each provider spells "deterministic" differently. */
  modelOptions: Record<string, unknown>;
}

export interface LlmAdapterParams {
  model: string;
  ollamaBaseUrl: string;
  openaiApiKey: string;
  anthropicApiKey: string;
}

type LlmBackend = 'ollama' | 'openai' | 'anthropic';

const BACKENDS = ['ollama', 'openai', 'anthropic'] as const;

const isBackend = (value: string): value is LlmBackend =>
  (BACKENDS as readonly string[]).includes(value);

const looksLikeOpenaiId = (lower: string): boolean => {
  // Ollama tags use a colon (`gpt-oss:20b`). Cloud OpenAI ids do not.
  if (lower.includes(':')) return false;
  return (
    lower.startsWith('gpt-') ||
    lower.startsWith('chatgpt-') ||
    /^o[1-9]/.test(lower)
  );
};

function classifyModel(raw: string): { backend: LlmBackend; model: string } {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash).toLowerCase();
    const rest = trimmed.slice(slash + 1).trim();
    if (isBackend(prefix)) {
      if (!rest) {
        throw new Error(`LLM_MODEL "${raw}" is missing a model after "${prefix}/"`);
      }
      return { backend: prefix, model: rest };
    }
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('claude')) return { backend: 'anthropic', model: trimmed };
  if (looksLikeOpenaiId(lower)) return { backend: 'openai', model: trimmed };
  return { backend: 'ollama', model: trimmed };
}

// OpenAI rejects the `temperature` param on reasoning models (o-series, gpt-5*).
function isOpenaiReasoningModel(model: string): boolean {
  return /^o\d/.test(model) || model.startsWith('gpt-5');
}

const chatAdapters: {
  [K in LlmBackend]: (model: string, params: LlmAdapterParams) => AdapterSetup;
} = {
  ollama: (model, params) => ({
    adapter: createOllamaChat(model, params.ollamaBaseUrl),
    // `think: false` is a top-level /api/chat param (not inside `options`);
    // without it qwen3 defaults to thinking mode (~60s/call vs ~0.7s).
    modelOptions: { think: false, options: { temperature: 0 } },
  }),
  openai: (model, params) => ({
    adapter: createOpenaiChat(
      model as Parameters<typeof createOpenaiChat>[0],
      params.openaiApiKey
    ),
    modelOptions: isOpenaiReasoningModel(model) ? {} : { temperature: 0 },
  }),
  anthropic: (model, params) => ({
    adapter: createAnthropicChat(
      model as Parameters<typeof createAnthropicChat>[0],
      params.anthropicApiKey
    ),
    modelOptions: { temperature: 0 },
  }),
};

/**
 * TanStack adapter router: classify the model id, then run the matching factory.
 */
export function createLlmAdapter(params: LlmAdapterParams): AdapterSetup {
  const { backend, model } = classifyModel(params.model);
  if (backend === 'openai' && !params.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required. Set it in .env (see .env.example).');
  }
  if (backend === 'anthropic' && !params.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required. Set it in .env (see .env.example).');
  }
  return chatAdapters[backend](model, params);
}

/**
 * Single provider-agnostic implementation over TanStack AI: the tool JSON
 * schema is passed straight through as `outputSchema` (TanStack accepts plain
 * JSON Schema) and each adapter's native structured-output API enforces it.
 * Zod validation of the returned object stays at the call site (parseCallout).
 */
export function createLlmProvider(): LlmProvider {
  const { adapter, modelOptions } = createLlmAdapter({
    model: config.llmModel,
    ollamaBaseUrl: config.ollamaBaseUrl,
    openaiApiKey: config.openaiApiKey,
    anthropicApiKey: config.anthropicApiKey,
  });
  return {
    // ponytail: opts.maxTokens is ignored — TanStack AI has no provider-agnostic
    // token cap (per-provider modelOptions only) and the sole caller never sets
    // it. Upgrade path: add a per-provider maxTokens mapping in createLlmAdapter().
    async callStructured(opts): Promise<unknown> {
      return chat({
        adapter,
        systemPrompts: [
          opts.system,
          `Respond by producing the "${opts.tool.name}" object. ${opts.tool.description}`,
        ],
        messages: [{ role: 'user', content: opts.user }],
        outputSchema: opts.tool.schema as unknown as JSONSchema,
        modelOptions,
      });
    },
  };
}
