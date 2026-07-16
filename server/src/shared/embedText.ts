/**
 * Pure embed-text flattening shared by the bot (discord.js Embed objects) and
 * the trader's callout history feed (raw REST embed JSON). Structural type so
 * both shapes satisfy it without casts.
 */

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
