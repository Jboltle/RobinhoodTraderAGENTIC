-- Max Loss records each flatten as kind 'max_loss_exit' (DecisionKind in
-- server/src/shared/types.ts), which this check never allowed: the sell went
-- to the broker, the insert failed, and the next sweep could sell again.
alter table public.trades drop constraint trades_kind_check;

alter table public.trades add constraint trades_kind_check check (
  kind = any (array[
    'not_callout', 'parser_error', 'risk_rejected', 'pending_approval', 'rejected',
    'submitted', 'execution_failed', 'missed', 'max_loss_exit'
  ])
);
