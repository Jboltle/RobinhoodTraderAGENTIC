import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import { config } from './config.js';
import type { LlmProvider, ToolJsonSchema } from './types.js';

// =============================================================================
// Anthropic (Claude)
// =============================================================================

class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts?: { client?: Anthropic; model?: string }) {
    this.client = opts?.client ?? new Anthropic({ apiKey: config.anthropicApiKey });
    this.model = opts?.model ?? config.anthropicModel;
  }

  async callStructured(opts: {
    system: string;
    user: string;
    tool: { name: string; description: string; schema: ToolJsonSchema };
    maxTokens?: number;
  }): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      tools: [
        {
          name: opts.tool.name,
          description: opts.tool.description,
          input_schema: opts.tool.schema as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: opts.tool.name },
      messages: [{ role: 'user', content: opts.user }],
    });

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    if (!block) {
      throw new Error('Anthropic did not produce a tool_use block');
    }
    return block.input;
  }
}

// =============================================================================
// OpenAI (GPT)
// =============================================================================

class OpenAiProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts?: { client?: OpenAI; model?: string }) {
    this.client = opts?.client ?? new OpenAI({ apiKey: config.openaiApiKey });
    this.model = opts?.model ?? config.openaiModel;
  }

  async callStructured(opts: {
    system: string;
    user: string;
    tool: { name: string; description: string; schema: ToolJsonSchema };
    maxTokens?: number;
  }): Promise<unknown> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: opts.tool.name,
            description: opts.tool.description,
            parameters: opts.tool.schema as unknown as Record<string, unknown>,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: opts.tool.name } },
    });

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') {
      throw new Error('OpenAI did not produce a function tool_call');
    }
    try {
      return JSON.parse(toolCall.function.arguments);
    } catch (err) {
      throw new Error(
        `OpenAI tool_call arguments were not valid JSON: ${(err as Error).message}`
      );
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createLlmProvider(): LlmProvider {
  switch (config.llmProvider) {
    case 'openai':
      return new OpenAiProvider();
    case 'anthropic':
      return new AnthropicProvider();
    default: {
      const exhaustive: never = config.llmProvider;
      throw new Error(`Unknown LLM_PROVIDER: ${String(exhaustive)}`);
    }
  }
}
