/**
 * Pure embed-text flattening over raw Discord embed JSON, shared by the
 * pipeline's parse path (flattenEnvelope) and the feed's read-time flatten in
 * db.ts. Structural type so any embed-shaped JSON satisfies it without casts.
 */

import type { DiscordEnvelope } from './types.js';

export interface EmbedLike {
  readonly author?: { readonly name?: string | null } | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly fields?: readonly { readonly name: string; readonly value: string }[] | null;
  readonly footer?: { readonly text?: string | null } | null;
  readonly image?: { readonly url?: string | null } | null;
  readonly thumbnail?: { readonly url?: string | null } | null;
  readonly url?: string | null;
}

/** Flatten an embed's textual parts (author, title, description, fields, footer, media URLs) into plain lines. */
export function flattenEmbedText(embed: EmbedLike): string {
  const fields = (embed.fields ?? []).map((f) => `${f.name}: ${f.value}`);
  // Media/link URLs keep image-only embeds non-empty so they survive the forwardability check.
  const media = [embed.image?.url, embed.thumbnail?.url].filter(Boolean).map((u) => `image: ${u}`);
  if (embed.url) media.push(`url: ${embed.url}`);
  return [embed.author?.name, embed.title, embed.description, ...fields, embed.footer?.text, ...media]
    .filter(Boolean)
    .join('\n');
}

/**
 * Assemble one message's full text: body + sticker names + attachment URLs +
 * flattened embeds. The bot (gateway messages) and the trader's REST history
 * reader flatten through this so a catch-up message is shaped exactly like a
 * live one. Callers prepend any context of their own (e.g. the bot's reply
 * prefix goes into `body` first).
 */
export function assembleMessageText(parts: {
  body: string;
  stickerNames: readonly string[];
  attachmentUrls: readonly string[];
  embeds: readonly EmbedLike[];
}): string {
  let body = parts.body.trim();

  if (parts.stickerNames.length > 0) {
    const names = parts.stickerNames.map((name) => `:${name}:`).join(' ');
    body = (body ? body + '\n' : '') + `🏷️ sticker: ${names}`;
  }

  if (parts.attachmentUrls.length > 0) {
    body = (body ? body + '\n' : '') + parts.attachmentUrls.join('\n');
  }

  if (parts.embeds.length > 0) {
    // Separate flattened embeds so consecutive callout cards don't merge into one.
    const embedText = parts.embeds.map(flattenEmbedText).filter(Boolean).join('\n---\n');
    if (embedText) body = (body ? body + '\n' : '') + embedText;
  }

  return body;
}

/** Discord caps total embed text at 6000 chars; parse text stays within that no matter the producer. */
export const MAX_CONTENT_LENGTH = 6000;

/** Slice to `max` chars, dropping a trailing lone high surrogate so JSON encoding stays valid. */
export function truncateSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * The trader-side half of the envelope contract (see DiscordEnvelopeSchema):
 * producers send raw parts — `content` as the message text, `embeds` as raw
 * embed JSON — and this flattens the embeds into `content` so everything
 * downstream (parser, guards, stored feed content) reads one text field.
 *
 * Call it exactly once per envelope, at a domain entry point (the trade
 * pipeline's process(), the recap ingest); a second call would duplicate the
 * embed text. `embeds` stay raw on the returned envelope for storage/display.
 */
export function flattenEnvelope(envelope: DiscordEnvelope): DiscordEnvelope {
  // Envelope embeds are permissive Record JSON; EmbedLike reads the textual
  // parts through optional chaining, so unknown-shaped values flatten to ''.
  const embeds = (envelope.embeds ?? []) as readonly EmbedLike[];
  const content = truncateSafe(
    assembleMessageText({ body: envelope.content, stickerNames: [], attachmentUrls: [], embeds }),
    MAX_CONTENT_LENGTH
  );
  return { ...envelope, content };
}
