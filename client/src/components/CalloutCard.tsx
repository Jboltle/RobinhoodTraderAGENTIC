/**
 * Card for a Discord callout message: cleans raw Discord artifacts (role
 * mentions, ANSI-colored code fences, markdown, bare image URLs) and renders
 * them as structured header / body / footer.
 */
import type { DiscordEmbed } from '../lib/api'

type Block =
  | { kind: 'code'; text: string }
  | { kind: 'image'; url: string }
  | { kind: 'text'; text: string; footer: boolean }

const ANSI_RE = /\u001b\[[0-9;]*m/g
const ROLE_MENTION_RE = /<@&\d+>/g
const FENCE_RE = /```\w*\n?([\s\S]*?)```/g
const IMAGE_LINE_RE =
  /^(?:image:\s*)?(https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?)$/i
// ***bold italic*** | **bold** | *italic* | [label](url)
const INLINE_RE =
  /\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g

// Boilerplate signature lines: promo links ("[@Namrood](...) - [DASHBOARD](...)"),
// "Twitter: @..." and "@Optionality | <date>" footers. De-emphasized, not stripped.
const LINKS_ONLY_RE = /^(\s|-|\||\[[^\]]*\]\([^)]*\))+$/
const isFooterLine = (line: string): boolean =>
  line.startsWith('Twitter:') || /^@\S+\s+\|/.test(line) || LINKS_ONLY_RE.test(line)

export function parseContent(raw: string): Block[] {
  const text = raw
    .replace(/\r/g, '')
    .replace(ROLE_MENTION_RE, '')
    .replace(ANSI_RE, '')
  const blocks: Block[] = []
  let last = 0
  for (const match of text.matchAll(FENCE_RE)) {
    pushTextLines(blocks, text.slice(last, match.index))
    const code = match[1].trim()
    if (code) blocks.push({ kind: 'code', text: code })
    last = match.index + match[0].length
  }
  pushTextLines(blocks, text.slice(last))
  return blocks
}

function pushTextLines(blocks: Block[], segment: string): void {
  for (const rawLine of segment.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const image = IMAGE_LINE_RE.exec(line)
    if (image) blocks.push({ kind: 'image', url: image[1] })
    else blocks.push({ kind: 'text', text: line, footer: isFooterLine(line) })
  }
}

/** Renders **bold**, ***bold italic***, *italic* and [label](url) inline. */
function Inline({ text }: { text: string }) {
  const nodes: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1] !== undefined) {
      nodes.push(
        <strong key={m.index} className="font-semibold text-white italic">
          {m[1]}
        </strong>,
      )
    } else if (m[2] !== undefined) {
      nodes.push(
        <strong key={m.index} className="font-semibold text-white">
          {m[2]}
        </strong>,
      )
    } else if (m[3] !== undefined) {
      nodes.push(<em key={m.index}>{m[3]}</em>)
    } else {
      nodes.push(
        <a
          key={m.index}
          href={m[5]}
          target="_blank"
          rel="noreferrer"
          className="text-brand hover:underline"
        >
          {m[4]}
        </a>,
      )
    }
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'code':
      return (
        <pre className="my-1 overflow-x-auto rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-sm whitespace-pre-wrap text-white">
          {block.text}
        </pre>
      )
    case 'image':
      return (
        <a href={block.url} target="_blank" rel="noreferrer">
          <img
            src={block.url}
            loading="lazy"
            alt=""
            className="my-1 max-h-48 rounded-lg border border-ink-600"
          />
        </a>
      )
    case 'text':
      return block.footer ? (
        <p className="text-xs text-ink-500">
          <Inline text={block.text} />
        </p>
      ) : (
        <p className="text-sm text-ink-400">
          <Inline text={block.text} />
        </p>
      )
  }
}

const SHORT_TIME: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}

export function CalloutCard({
  authorName,
  channelName,
  timestamp,
  content,
  embeds = [],
  footer,
  dashed = false,
}: {
  authorName: string
  channelName?: string | null
  timestamp: string
  content: string
  embeds?: DiscordEmbed[]
  footer?: React.ReactNode
  dashed?: boolean
}) {
  const blocks = parseContent(content)
  // Discord flattens embed text into `content` on this feed; only render an
  // embed separately when its description isn't already part of the content.
  const extraEmbeds = embeds.filter(
    (e) =>
      typeof e.description === 'string' &&
      !content.replace(/\r/g, '').includes(e.description.replace(/\r/g, '')),
  )

  return (
    <article
      className={`rounded-xl border bg-ink-800 px-5 py-4 ${
        dashed ? 'border-dashed border-ink-600 bg-ink-800/60' : 'border-ink-600'
      }`}
    >
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <span className="truncate text-sm font-medium text-white">
          {authorName}
          {channelName && (
            <span className="ml-2 text-xs font-normal text-ink-500">
              #{channelName}
            </span>
          )}
        </span>
        <time className="shrink-0 text-xs tabular-nums text-ink-400">
          {new Date(timestamp).toLocaleString(undefined, SHORT_TIME)}
        </time>
      </div>

      <div className="flex flex-col gap-1">
        {blocks.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
      </div>

      {extraEmbeds.map((embed, i) => (
        <div key={i} className="mt-3 flex flex-col gap-1 border-l-2 border-brand/25 pl-3">
          {typeof embed.title === 'string' && (
            <p className="text-sm font-medium text-white">{embed.title}</p>
          )}
          {parseContent(embed.description as string).map((block, j) => (
            <BlockView key={j} block={block} />
          ))}
        </div>
      ))}

      {footer && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs">{footer}</p>
      )}
    </article>
  )
}
