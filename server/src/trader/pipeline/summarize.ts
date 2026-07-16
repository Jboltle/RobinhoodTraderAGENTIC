import type { Callout, SubmittedOrder } from '../../shared/types.js';

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
