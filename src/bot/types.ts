/** Types for the Discord forwarder bot. */

export interface MessageFilterConfig {
  readonly discordAllowedChannelIds: readonly string[];
  readonly discordAllowedAuthorIds: readonly string[];
}

export interface MessageClassification {
  readonly forward: boolean;
  /** 'allowed' when forwardable, otherwise the ignore reason code. */
  readonly reason: string;
}

/** The signed HTTP request (url + HMAC headers + body) delivered to the trader. */
export interface ForwardRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Minimal structural shape of a discord.js channel we can post messages to. */
export type TextSendableChannel = {
  readonly id: string;
  readonly name?: string;
  readonly guildId?: string;
  isTextBased?: () => boolean;
  send: (payload: { content: string; allowedMentions: { parse: [] } }) => Promise<unknown>;
};
