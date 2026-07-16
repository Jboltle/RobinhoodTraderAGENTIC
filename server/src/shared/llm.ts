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

// OpenAI rejects the `temperature` param on reasoning models (o-series, gpt-5*).
function isOpenaiReasoningModel(model: string): boolean {
  return /^o\d/.test(model) || model.startsWith('gpt-5');
}

function createAdapter(): AdapterSetup {
  switch (config.llmProvider) {
    case 'ollama':
      return {
        adapter: createOllamaChat(config.llmModel, config.ollamaBaseUrl),
        // `think: false` is a top-level /api/chat param (not inside `options`);
        // without it qwen3 defaults to thinking mode (~60s/call vs ~0.7s).
        modelOptions: { think: false, options: { temperature: 0 } },
      };
    case 'openai':
      return {
        adapter: createOpenaiChat(
          config.llmModel as Parameters<typeof createOpenaiChat>[0],
          config.openaiApiKey
        ),
        modelOptions: isOpenaiReasoningModel(config.llmModel) ? {} : { temperature: 0 },
      };
    case 'anthropic':
      return {
        adapter: createAnthropicChat(
          config.llmModel as Parameters<typeof createAnthropicChat>[0],
          config.anthropicApiKey
        ),
        modelOptions: { temperature: 0 },
      };
    default: {
      const exhaustive: never = config.llmProvider;
      throw new Error(`Unknown LLM_PROVIDER: ${String(exhaustive)}`);
    }
  }
}

/**
 * Single provider-agnostic implementation over TanStack AI: the tool JSON
 * schema is passed straight through as `outputSchema` (TanStack accepts plain
 * JSON Schema) and each adapter's native structured-output API enforces it.
 * Zod validation of the returned object stays at the call site (parseCallout).
 */
export function createLlmProvider(): LlmProvider {
  const { adapter, modelOptions } = createAdapter();
  return {
    // ponytail: opts.maxTokens is ignored — TanStack AI has no provider-agnostic
    // token cap (per-provider modelOptions only) and the sole caller never sets
    // it. Upgrade path: add a per-provider maxTokens mapping in createAdapter().
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
