import { optionLabel, type Callout, type Decision, type SubmittedOrder } from '../../shared/types.js';

function priceText(order: SubmittedOrder): string {
  if (order.orderType !== 'limit' || order.limitPrice === null) return 'market';
  const dollars = `$${order.limitPrice.toFixed(2)}`;
  return order.assetType === 'option' ? `limit ${dollars}/contract` : `limit ${dollars}`;
}

/** Quantity, symbol, contract, and price — the shared body of both receipts. */
function describeOrder(order: SubmittedOrder): string {
  const body =
    order.assetType === 'option' && order.option
      ? `${order.quantity}x ${order.symbol} ${optionLabel(order.option)}`
      : `${order.quantity} ${order.symbol}`;
  return `${body} (${priceText(order)})`;
}

function describeIntent(callout: Callout | null): string {
  if (!callout || !callout.ticker) return 'Callout';
  const side = (callout.action ?? 'trade').toUpperCase();
  if (callout.assetType === 'option' && callout.option) {
    return `${side} ${callout.ticker} ${optionLabel(callout.option)}`;
  }
  return `${side} ${callout.ticker}`;
}

/**
 * The single Discord receipt for a callout, covering every account at once.
 *
 * Deliberately counts rather than names: the source channel is shared, so a
 * per-account receipt would tell everyone reading it what each user holds.
 * Returns null when there is nothing worth saying (a non-callout, or nobody
 * connected to act on it).
 */
export function summarizeFanout(callout: Callout | null, outcomes: readonly Decision[]): string | null {
  if (outcomes.length === 0) return null;

  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
  }

  const breakdown = [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ');
  const accounts = `${outcomes.length} account${outcomes.length === 1 ? '' : 's'}`;
  return `${describeIntent(callout)} — ${breakdown} across ${accounts}.`;
}

/**
 * Receipt text for a sized-but-unsubmitted order awaiting approval. Takes the
 * sized order rather than the callout so it can state the quantity the user is
 * actually being asked to approve.
 */
export function summarizePendingApproval(order: SubmittedOrder): string {
  return `Approval required: ${order.side.toUpperCase()} ${describeOrder(order)}. No order submitted.`;
}

/**
 * Receipt text for a submitted order. `authorName` is null when the submit did
 * not come straight off a Discord message — an approved trade is attributed to
 * the user who approved it, not re-attributed to the Caller.
 */
export function summarize(order: SubmittedOrder, authorName: string | null): string {
  const verb = order.side === 'buy' ? 'Bought' : 'Sold';
  const orderRef = order.orderId ? `, order ${order.orderId}` : '';
  const from = authorName === null ? '' : ` From @${authorName}.`;
  return `${verb} ${describeOrder(order)}. Status: ${order.status ?? 'submitted'}${orderRef}.${from}`;
}
