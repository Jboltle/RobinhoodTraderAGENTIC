import { optionLabel, type SubmittedOrder } from '../../shared/types.js';

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
