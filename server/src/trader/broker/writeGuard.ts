/**
 * The one place TRADE_EXECUTION_MODE=read_only is enforced against a broker.
 *
 * The registry wraps every adapter's Broker with this, so no caller, monitor
 * or route can reach a write on any broker from a read-only deployment.
 * `approval` is a policy about callout-driven trades and is decided by the
 * callers; it does not stop a write here (Max Loss still sells under it).
 */
import { optionLabel, type TradeExecutionMode } from '../../shared/types.js';
import { BrokerWritesDisabledError } from './errors.js';
import type { Broker, OrderRequest } from './types.js';

export function guardWrites(broker: Broker, mode: TradeExecutionMode): Broker {
  if (mode !== 'read_only') return broker;
  // Spelled out method by method rather than proxied: a method added to the
  // port fails to compile here until it is classed as a read or a write.
  return {
    getAccount: () => broker.getAccount(),
    getMark: (instrument) => broker.getMark(instrument),
    confirmInstrument: (instrument) => broker.confirmInstrument(instrument),
    getPositions: (kind) => broker.getPositions(kind),
    getOrders: () => broker.getOrders(),
    placeOrder: async (order) => {
      throw new BrokerWritesDisabledError(`placed ${describeOrder(order)}`);
    },
    cancelOrder: async (orderId) => {
      throw new BrokerWritesDisabledError(`cancelled order ${orderId}`);
    },
  };
}

function describeOrder({ instrument, side, quantity }: OrderRequest): string {
  const contract = instrument.kind === 'option' ? ` ${optionLabel(instrument)}` : '';
  return `${side} ${quantity} ${instrument.symbol}${contract}`;
}
