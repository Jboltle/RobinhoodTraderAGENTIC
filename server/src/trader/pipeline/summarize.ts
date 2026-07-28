import type { Callout, Decision, SubmittedOrder } from '../../shared/types.js';

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
  return `${describeIntent(callout)} — ${breakdown} across ${plural(outcomes.length, 'account')}.`;
}

function describeIntent(callout: Callout | null): string {
  if (!callout || !callout.ticker) return 'Callout';
  const side = (callout.action ?? 'trade').toUpperCase();
  if (callout.assetType === 'option' && callout.option) {
    const { optionType, strike, expiration } = callout.option;
    return `${side} ${callout.ticker} ${strike}${optionType[0]?.toUpperCase()} ${expiration}`;
  }
  return `${side} ${callout.ticker}`;
}

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Receipt text for a callout parked in approval mode (no order submitted). */
export function summarizePendingApproval(callout: Callout): string {
  const symbol = callout.ticker?.toUpperCase() ?? 'UNKNOWN';
  const side = callout.action ?? 'unknown';

  if (callout.assetType === 'option' && callout.option) {
    const { optionType, strike, expiration } = callout.option;
    const priceText =
      callout.orderType === 'limit' && callout.limitPrice !== null
        ? `limit $${callout.limitPrice.toFixed(2)}/contract`
        : 'market';
    return (
      `Approval required: ${side.toUpperCase()} ${symbol} ${strike}${optionType[0]?.toUpperCase()} ${expiration} ` +
      `(${priceText}). No order submitted.`
    );
  }

  const priceText =
    callout.orderType === 'limit' && callout.limitPrice !== null
      ? `limit $${callout.limitPrice.toFixed(2)}`
      : 'market';
  return `Approval required: ${side.toUpperCase()} ${symbol} equity (${priceText}). No order submitted.`;
}

/** Receipt text for a submitted order. */
export function summarize(order: SubmittedOrder, authorName: string): string {
  const verb = order.side === 'buy' ? 'Bought' : 'Sold';
  const orderRef = order.orderId ? `, order ${order.orderId}` : '';

  if (order.assetType === 'option' && order.option) {
    const { optionType, strike, expiration } = order.option;
    const priceText =
      order.orderType === 'limit' && order.limitPrice !== null
        ? `limit $${order.limitPrice.toFixed(2)}/contract`
        : 'market';
    return (
      `${verb} ${order.quantity}x ${order.symbol} ${strike}${optionType[0]?.toUpperCase()} ${expiration} (${priceText}). ` +
      `Status: ${order.status ?? 'submitted'}${orderRef}. From @${authorName}.`
    );
  }

  const priceText =
    order.orderType === 'limit' && order.limitPrice !== null
      ? `limit $${order.limitPrice.toFixed(2)}`
      : 'market';
  return (
    `${verb} ${order.quantity} ${order.symbol} (${priceText}). ` +
    `Status: ${order.status ?? 'submitted'}${orderRef}. From @${authorName}.`
  );
}
