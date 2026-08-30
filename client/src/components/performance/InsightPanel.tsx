import { Sparkles } from 'lucide-react'

import type { RecapInsight } from '../../lib/api'

/**
 * The cached AI narration. Generated server-side after recap sweeps — never
 * on page load — so this panel only ever reads. Every number in the text
 * comes from the computed stats the model was handed.
 */
export function InsightPanel({ insight }: { insight: RecapInsight | null }) {
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="size-4 text-brand" />
        <h3 className="text-sm font-semibold text-white">AI read</h3>
        {insight && (
          <span className="ml-auto text-xs text-ink-500">
            {new Date(insight.generatedAt).toLocaleString()}
          </span>
        )}
      </div>
      {insight ? (
        <p className="whitespace-pre-line text-sm leading-relaxed text-ink-400">
          {insight.content}
        </p>
      ) : (
        <p className="text-sm text-ink-500">
          No AI read for this window yet — it is generated automatically after
          the next recap sweep.
        </p>
      )}
    </div>
  )
}
