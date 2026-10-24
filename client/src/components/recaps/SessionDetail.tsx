/**
 * One trading day: header card (net, record, Preview / Copy recap), the
 * CLOSED TRADES table whose rows expand into the trim ladder and the fills
 * that made the number, and STILL RUNNING for entries opened that day.
 */
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Check, Copy } from 'lucide-react'
import { Fragment, useState } from 'react'

import type { Caller, Decision, TrackedPosition } from '../../lib/api'
import { fmtPremium, fmtUsd, pnlTone } from '../../lib/book'
import { recapText } from '../../lib/recapText'
import { dayLabel, monthLabel, type Session, type SessionTrade } from '../../lib/sessions'
import { PositionCard } from '../book/PositionCard'
import { TrimLadder } from '../book/TrimLadder'
import { CallerChip, MyOutcome } from '../book/chips'
import { ResultDot } from '../book/ClosedRow'
import { fmtPct } from '../performance/format'
import { Bar } from './SessionsKpis'

const COPIED_FEEDBACK_MS = 1500

export function SessionDetail({
  session,
  callers,
  decisionByMessageId,
}: {
  session: Session
  callers: Caller[]
  decisionByMessageId: Map<string, Decision>
}) {
  const callerById = new Map(callers.map((c) => [c.authorId, c]))
  const callerNames = new Map(callers.map((c) => [c.authorId, c.displayName]))
  const [preview, setPreview] = useState(false)
  const text = recapText(session, callerNames)
  const { dow, day } = dayLabel(session.date)

  return (
    <div className="flex flex-col gap-6">
      <Link to="/recaps" search={{}} className="inline-flex items-center gap-1.5 text-xs text-ink-400 hover:text-white">
        <ArrowLeft className="size-3.5" /> All sessions
      </Link>

      <header className="rounded-2xl border border-ink-600 bg-ink-800 px-6 py-5">
        <div className="flex flex-wrap items-start gap-6">
          <div>
            <p className="text-xs uppercase tracking-wider text-ink-400">
              {dow} · {monthLabel(session.date)}
            </p>
            <p className="text-3xl font-semibold tabular-nums text-white">{day}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-ink-400">Net</p>
            <p className={`text-3xl font-semibold tabular-nums ${pnlTone(session.net)}`}>
              {fmtUsd(session.net)}
            </p>
          </div>
          <div className="min-w-40">
            <p className="text-xs uppercase tracking-wider text-ink-400">
              {session.trades.length} closed
              {session.stillRunning.length > 0 ? ` · ${session.stillRunning.length} still running` : ''}
            </p>
            <p className="text-sm tabular-nums text-white">
              {session.wins}W {session.losses}L{session.breakEvens > 0 ? ` ${session.breakEvens}BE` : ''}
            </p>
            <Bar green={session.wins} red={session.losses} grey={session.breakEvens} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPreview((v) => !v)}
              className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-ink-400 transition-colors hover:text-white"
            >
              {preview ? 'Hide preview' : 'Preview'}
            </button>
            <CopyButton text={text} />
          </div>
        </div>
        {session.source === 'recap' && (
          <p className="mt-3 text-xs text-ink-500">
            Before tracking began: trades come from the Caller’s posted recap and dollars are nominal
            ($5,000 per entry).
          </p>
        )}
        {preview && (
          <pre className="mt-4 overflow-x-auto rounded-xl bg-ink-900 p-4 text-xs leading-relaxed whitespace-pre-wrap text-ink-400">
            {text}
          </pre>
        )}
      </header>

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-400">Closed trades</h3>
        {session.trades.length === 0 ? (
          <p className="rounded-xl border border-ink-600 bg-ink-800 px-4 py-6 text-center text-sm text-ink-400">
            Nothing closed this day.
          </p>
        ) : (
          <ClosedTradesTable
            trades={session.trades}
            callerById={callerById}
            decisionByMessageId={decisionByMessageId}
          />
        )}
      </section>

      {session.stillRunning.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-400">Still running</h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {session.stillRunning.map((position) => (
              <PositionCard
                key={position.messageId}
                position={position}
                caller={callerById.get(position.authorId)}
                decision={decisionByMessageId.get(position.messageId)}
                density="normal"
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="inline-flex items-center gap-1.5 rounded-lg bg-brand/15 px-3 py-1.5 text-xs font-medium text-brand transition-colors hover:bg-brand/25"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : 'Copy recap'}
    </button>
  )
}

const cellClass = 'px-3 py-2.5 tabular-nums'
const headClass = 'px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-ink-500'

function ClosedTradesTable({
  trades,
  callerById,
  decisionByMessageId,
}: {
  trades: readonly SessionTrade[]
  callerById: Map<string, Caller>
  decisionByMessageId: Map<string, Decision>
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div className="overflow-x-auto rounded-2xl border border-ink-600 bg-ink-800">
      <table className="w-full text-sm">
        <thead className="border-b border-ink-600">
          <tr>
            <th className={headClass}>Contract</th>
            <th className={headClass}>Caller</th>
            <th className={`${headClass} text-right`}>Entry</th>
            <th className={`${headClass} text-right`}>Exit</th>
            <th className={`${headClass} text-right`}>Realized</th>
            <th className={`${headClass} text-right`}>Peak</th>
            <th className={`${headClass} text-right`}>ROI</th>
            <th className={headClass}>Result</th>
            <th className={headClass}>Mine</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => {
            const open = expanded === trade.key
            const expandable = trade.tracked !== null
            return (
              <Fragment key={trade.key}>
                <tr
                  onClick={() => expandable && setExpanded(open ? null : trade.key)}
                  className={`border-b border-ink-600/60 ${expandable ? 'cursor-pointer hover:bg-ink-700/40' : ''}`}
                >
                  <td className={`${cellClass} font-semibold text-white`}>
                    {trade.ticker} <span className="font-normal text-ink-400">{trade.contract}</span>
                  </td>
                  <td className={cellClass}>
                    {trade.authorId ? (
                      <CallerChip caller={callerById.get(trade.authorId)} authorId={trade.authorId} />
                    ) : (
                      <span className="text-xs text-ink-400">{trade.callerName}</span>
                    )}
                  </td>
                  <td className={`${cellClass} text-right text-ink-400`}>
                    {trade.entryPrice === null ? '—' : fmtPremium(trade.entryPrice)}
                  </td>
                  <td className={`${cellClass} text-right text-ink-400`}>
                    {trade.exitPrice === null ? '—' : fmtPremium(trade.exitPrice)}
                  </td>
                  <td className={`${cellClass} text-right font-semibold ${pnlTone(trade.pnl)}`}>
                    {fmtUsd(trade.pnl)}
                    {trade.nominal && <span className="ml-1 text-[10px] font-normal text-ink-500">nominal</span>}
                  </td>
                  <td className={`${cellClass} text-right text-ink-400`}>
                    {trade.peakPct === null ? '—' : fmtPct(trade.peakPct)}
                  </td>
                  <td className={`${cellClass} text-right ${pnlTone(trade.roiPct)}`}>
                    {trade.roiPct === null ? '—' : fmtPct(trade.roiPct)}
                  </td>
                  <td className={cellClass}>
                    <span className="inline-flex items-center gap-1.5 text-xs uppercase text-ink-400">
                      <ResultDot result={trade.result} /> {trade.result}
                    </span>
                  </td>
                  <td className={cellClass}>
                    {trade.tracked && <MyOutcome decision={decisionByMessageId.get(trade.tracked.messageId)} />}
                  </td>
                </tr>
                {open && trade.tracked && (
                  <tr className="border-b border-ink-600/60 bg-ink-900/40">
                    <td colSpan={9} className="px-4 py-4">
                      <FillsDetail position={trade.tracked} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const FILL_SOURCE_LABEL: Record<TrackedPosition['fills'][number]['source'], string> = {
  ladder: 'ladder',
  caller: 'caller',
  expiry: 'expiry',
}

function FillsDetail({ position }: { position: TrackedPosition }) {
  const entry = position.entryPrice
  return (
    <div className="flex flex-col gap-3">
      <TrimLadder ladder={position.ladder} pctNow={position.pctNow} />
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={headClass}>Time ET</th>
            <th className={`${headClass} text-right`}>Qty</th>
            <th className={`${headClass} text-right`}>Price</th>
            <th className={`${headClass} text-right`}>Gain %</th>
            <th className={`${headClass} text-right`}>Realized</th>
            <th className={headClass}>Via</th>
          </tr>
        </thead>
        <tbody>
          {position.fills.map((fill, i) => {
            const realized = entry === null ? 0 : (fill.price - entry) * fill.qty * 100
            const last = i === position.fills.length - 1 && position.closedAt !== null
            return (
              <tr key={`${fill.at}-${i}`} className="border-t border-ink-600/60">
                <td className={`${cellClass} text-ink-400`}>
                  {timeEt(fill.at)}
                  {last && <span className="ml-2 text-[10px] font-medium uppercase text-brand">Final close</span>}
                </td>
                <td className={`${cellClass} text-right text-white`}>{fill.qty}</td>
                <td className={`${cellClass} text-right text-white`}>{fmtPremium(fill.price)}</td>
                <td className={`${cellClass} text-right ${pnlTone(fill.pctGain)}`}>{fmtPct(fill.pctGain)}</td>
                <td className={`${cellClass} text-right ${pnlTone(realized)}`}>{fmtUsd(realized)}</td>
                <td className={`${cellClass} text-ink-500`}>{FILL_SOURCE_LABEL[fill.source]}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const timeEt = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  })
