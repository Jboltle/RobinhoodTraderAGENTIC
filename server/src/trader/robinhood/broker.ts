/**
 * The broker port over Robinhood. Each method is the RobinhoodTools call the
 * pipeline and monitors made directly before the port existed, with the same
 * arguments; the MCP calls and their parsers stay in tools.ts.
 */
import type {
  Broker,
  BrokerAccount,
  BrokerOrder,
  BrokerPosition,
  Instrument,
  OrderRequest,
  PlacedOrder,
} from '../broker/types.js';
import type { RobinhoodTools } from './tools.js';
import type { OptionOrder, OptionPosition, Position } from './types.js';

/**
 * Per-share average cost on an equity position row. `cost_basis` is
 * deliberately not read: it is a position total, not a per-share price.
 */
const AVERAGE_COST_KEYS = ['average_buy_price', 'average_price', 'average_cost'] as const;

export class RobinhoodBroker implements Broker {
  constructor(private readonly tools: RobinhoodTools) {}

  async getAccount(): Promise<BrokerAccount> {
    const account = await this.tools.getBuyingPower();
    return { buyingPowerUsd: account.amountUsd, portfolioValueUsd: account.portfolioValueUsd };
  }

  async getMark(instrument: Instrument): Promise<number | null> {
    if (instrument.kind === 'equity') {
      return (await this.tools.getQuote(instrument.symbol)).price;
    }
    const quote = await this.tools.getOptionsMarkPrice(
      instrument.symbol,
      instrument.optionType,
      instrument.strike,
      instrument.expiration
    );
    return quote?.markPrice ?? null;
  }

  async confirmInstrument(instrument: Instrument): Promise<void> {
    if (instrument.kind === 'equity') {
      // The equity quote is what rejects a ticker Robinhood cannot trade as stock.
      await this.tools.getQuote(instrument.symbol);
      return;
    }
    await this.tools.confirmOption(
      instrument.symbol,
      instrument.optionType,
      instrument.strike,
      instrument.expiration
    );
  }

  async getPositions(kind?: Instrument['kind']): Promise<readonly BrokerPosition[]> {
    if (kind === 'equity') return (await this.tools.getPositions()).positions.map(equityPosition);
    if (kind === 'option') {
      return (await this.tools.getOptionPositions()).positions.map(optionPosition);
    }
    const [equity, options] = await Promise.all([
      this.tools.getPositions(),
      this.tools.getOptionPositions(),
    ]);
    return [...equity.positions.map(equityPosition), ...options.positions.map(optionPosition)];
  }

  // ponytail: option orders only; the MCP advertises no equity order history.
  async getOrders(): Promise<readonly BrokerOrder[] | null> {
    const history = await this.tools.getOptionOrders();
    return history === null ? null : history.orders.map(optionOrder);
  }

  async placeOrder(order: OrderRequest): Promise<PlacedOrder> {
    const { instrument } = order;
    if (instrument.kind === 'equity') {
      if (order.type === 'stop') {
        throw new Error(`Robinhood stop orders are wired for options only, not ${instrument.symbol} stock`);
      }
      const placed = await this.tools.placeOrder({
        symbol: instrument.symbol,
        side: order.side,
        orderType: order.type,
        quantity: order.quantity,
        ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
        ...(order.timeInForce !== undefined ? { timeInForce: order.timeInForce } : {}),
      });
      return { orderId: placed.orderId, status: placed.status };
    }
    const placed = await this.tools.placeOptionsOrder({
      symbol: instrument.symbol,
      optionType: instrument.optionType,
      strike: instrument.strike,
      expiration: instrument.expiration,
      contracts: order.quantity,
      side: order.side,
      orderType: order.type === 'stop' ? 'stop_market' : order.type,
      ...(order.limitPrice !== undefined ? { limitPremium: order.limitPrice } : {}),
      ...(order.stopPrice !== undefined ? { stopPrice: order.stopPrice } : {}),
      ...(order.timeInForce !== undefined ? { timeInForce: order.timeInForce } : {}),
    });
    return { orderId: placed.orderId, status: placed.status };
  }

  // ponytail: every order this system cancels is an option stop, and the MCP
  // wires no equity cancel. Upgrade path: route by the order's instrument.
  async cancelOrder(orderId: string): Promise<void> {
    await this.tools.cancelOptionOrder(orderId);
  }
}

function equityPosition(position: Position): BrokerPosition {
  return {
    instrument: { kind: 'equity', symbol: position.symbol },
    quantity: position.quantity,
    averageEntryPrice: numberFromRaw(position.raw, AVERAGE_COST_KEYS),
  };
}

/** Option position rows carry no cost data; the entry basis comes from order history. */
function optionPosition(position: OptionPosition): BrokerPosition {
  return {
    instrument: {
      kind: 'option',
      symbol: position.symbol,
      optionType: position.optionType,
      strike: position.strike,
      expiration: position.expiration,
    },
    quantity: position.quantity,
    averageEntryPrice: null,
  };
}

function optionOrder(order: OptionOrder): BrokerOrder {
  return {
    orderId: order.orderId,
    instrument: {
      kind: 'option',
      symbol: order.symbol,
      optionType: order.optionType,
      strike: order.strike,
      expiration: order.expiration,
    },
    side: order.side,
    status: order.state,
    fillPrice: order.averagePrice,
    quantity: order.quantity,
    createdAt: order.createdAt,
  };
}

function numberFromRaw(raw: unknown, keys: readonly string[]): number | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0) {
      return Number(v);
    }
  }
  for (const child of Object.values(rec)) {
    if (child && typeof child === 'object') {
      const found = numberFromRaw(child, keys);
      if (found !== null) return found;
    }
  }
  return null;
}
