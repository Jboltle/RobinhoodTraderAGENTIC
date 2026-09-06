-- Approval flow: 'pending_approval' stops being a dead end.
--
-- It used to be a terminal audit row — parsed, risk-checked, logged, and never
-- actionable. The dashboard can now approve or reject one, so the row needs a
-- state to move to and a record of when someone moved it.
--
-- Rows transition in place rather than appending, which keeps the table's
-- one-row-per-callout-per-user shape (the Trades table renders it directly and
-- would otherwise show the same callout twice). approved_at is what preserves
-- the audit trail across that mutation.

alter table public.trades drop constraint trades_kind_check;

alter table public.trades add constraint trades_kind_check check (
  kind in (
    'not_callout',
    'parser_error',
    'risk_rejected',
    'pending_approval',
    'rejected',
    'submitted',
    'execution_failed',
    'missed'
  )
);

-- When the user approved or rejected a pending trade. Null on every row that
-- never went through approval, which is every row written before this.
alter table public.trades add column approved_at timestamptz;
