/**
 * Phase 0 of the pluggable-broker plan: the four checks against a SnapTrade
 * Personal key on Alpaca Paper, run by hand and one at a time, before any
 * adapter code is written.
 *
 *   npm run snaptrade:check -- self-check     offline: OCC symbols, the paper guard, redaction
 *   npm run snaptrade:check -- connect        check 1: print the Connection Portal link
 *   npm run snaptrade:check -- accounts       check 1: connections, accounts, which may take orders
 *   npm run snaptrade:check -- buy  --underlying SPY --expiry 2026-11-20 --strike 600 --type call --limit 1.25
 *   npm run snaptrade:check -- fills          check 4: read the buy's fill back from recent orders
 *   npm run snaptrade:check -- stop --underlying SPY --expiry 2026-11-20 --strike 600 --type call --stop 0.50
 *   npm run snaptrade:check -- status         working orders and open positions
 *   npm run snaptrade:check -- cleanup --limit 0.01
 *
 * Orders go only to an account that is flagged paper, sits on the Alpaca Paper
 * brokerage and has a `trade` connection; anything else is refused. Every order
 * is one contract on the contract named on the command line.
 *
 * Every response is saved under server/state/snaptrade-check/ (git-ignored) for
 * the Phase 5 mapping tests, with secrets and account numbers removed. The
 * consumer key is never printed. The portal link from `connect` is itself a
 * five-minute credential: it is printed once for the owner to open and is left
 * out of the saved response.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { config as loadDotenv } from 'dotenv';
import {
  Snaptrade,
  SnaptradeAuth,
  SnaptradeError,
  type AccountOrderRecord,
  type AccountPosition,
  type BrokerageAuthorization,
  type ConnectionAccount,
  type MlegLeg,
  type MlegTradeForm,
  type PersonalApiKeyAuth,
  type TimeInForceStrict,
} from 'snaptrade-typescript-sdk';

import { OPTION_TYPES, type OptionType } from '../shared/types.js';

// Loaded here and not through shared/config.ts: that module refuses to load
// without the trader's own settings (LLM_MODEL), and these checks need none.
const rootEnvFile = (name: string): URL => new URL(`../../../${name}`, import.meta.url);
loadDotenv({ path: rootEnvFile('.env'), quiet: true });
loadDotenv({
  path: rootEnvFile(process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'),
  quiet: true,
});

const REQUIRED_ENV = ['SNAPTRADE_CLIENT_ID', 'SNAPTRADE_CONSUMER_KEY', 'SNAPTRADE_OWNER_EMAIL'] as const;

/** The only brokerage this script may send an order to (slug from SnapTrade's brokerage list). */
const ALPACA_PAPER_SLUG = 'ALPACA-PAPER';
const TRADE_CONNECTION_TYPE = 'trade';
const TEST_CONTRACTS = 1;

const OCC_ROOT_WIDTH = 6;
const OCC_STRIKE_DIGITS = 8;
const OCC_STRIKE_SCALE = 1000;

// A Personal key is allowed 10 requests a minute per account. One command
// stays under that: at most 4 order reads, 10 seconds apart, plus the closing
// list of working orders and positions.
const POLL_INTERVAL_MS = 10_000;
const FILL_POLL_ATTEMPTS = 4;
const HTTP_TOO_MANY_REQUESTS = 429;

const RECORD_DIR = fileURLToPath(new URL('../../state/snaptrade-check/', import.meta.url));
const LEDGER_FILE = `${RECORD_DIR}placed.jsonl`;

const REDACTED = '[redacted]';
const SENSITIVE_KEY = /number|secret|token|consumer|password|redirecturi|sessionid|institution_account_id|email/i;
/** Shorter values (a masked "****", a count) would blank out unrelated text. */
const MIN_SENSITIVE_VALUE_LENGTH = 6;

/** Any other status, a missing one included, is listed as still working. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'EXECUTED',
  'CANCELED',
  'PARTIAL_CANCELED',
  'REJECTED',
  'FAILED',
  'EXPIRED',
  'REPLACED',
]);
const REFUSED_STATUSES: ReadonlySet<string> = new Set(['REJECTED', 'FAILED']);
const CANCELLED_STATUSES: ReadonlySet<string> = new Set(['CANCELED', 'CANCEL_PENDING', 'PARTIAL_CANCELED']);

const USAGE = `usage: npm run snaptrade:check -- <command> [flags]

  self-check                 offline checks, no credentials needed
  connect [--pick-broker]    check 1: print the Connection Portal link for Alpaca Paper
                             (--pick-broker: choose the broker in the portal instead)
  accounts                   check 1: list connections and accounts, and which may take orders
  buy     <contract> --limit <price>              check 2: 1-contract limit BUY_TO_OPEN
  fills   [--order <brokerage order id>]          check 4: read the last buy's fill back
  stop    <contract> --stop <price> [--tif gtc|day]  check 3: stop SELL_TO_CLOSE, rest, cancel
  status                     working orders and open positions on the paper account
  cleanup [--limit <price>]  cancel this script's working orders, sell its filled position

  <contract>: --underlying SPY --expiry 2026-11-20 --strike 600 --type call|put
  --account <id>             needed only when more than one Alpaca Paper account qualifies`;

type Client = Snaptrade<PersonalApiKeyAuth>;

interface SnaptradeEnv {
  clientId: string;
  consumerKey: string;
  ownerEmail: string;
}

interface Flags {
  underlying?: string;
  expiry?: string;
  strike?: string;
  type?: string;
  limit?: string;
  stop?: string;
  tif?: string;
  account?: string;
  order?: string;
  'pick-broker'?: boolean;
}

interface OptionContract {
  underlying: string;
  /** ISO date, YYYY-MM-DD. */
  expiry: string;
  strike: number;
  optionType: OptionType;
}

type OrderKind = 'buy' | 'stop' | 'sell';

/** One line of the ledger: an order this script sent, so cleanup touches nothing else. */
interface PlacedOrder {
  at: string;
  kind: OrderKind;
  accountId: string;
  occSymbol: string;
  brokerageOrderId: string;
}

interface Recorded<T> {
  data: T;
  elapsedMs: number;
}

interface JudgedAccount {
  account: ConnectionAccount;
  connection: BrokerageAuthorization | undefined;
  /** Why orders are refused on this account; empty when they are allowed. */
  refusals: string[];
}

interface OrderAttempt {
  /** Null when the order was refused or the request failed. */
  orderId: string | null;
  evidence: Record<string, unknown>;
}

/** The part of a position the script reads; `symbol` is the OCC symbol on an option. */
type HeldPosition = Pick<AccountPosition, 'units'> & { instrument: { kind: string; symbol?: unknown } };

type AccountCheck = (client: Client, accountId: string) => Promise<boolean>;
type Command = (client: Client) => Promise<boolean>;

/** Values scrubbed from everything printed or saved; filled as secrets and account ids are seen. */
const sensitiveValues = new Set<string>();

// ---- Environment -------------------------------------------------------------

function readSnaptradeEnv(env: NodeJS.ProcessEnv): SnaptradeEnv {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} to .env at the repo root ` +
        '(see the SnapTrade section of .env.example).'
    );
  }
  const read = (name: (typeof REQUIRED_ENV)[number]): string => env[name]?.trim() ?? '';
  return {
    clientId: read('SNAPTRADE_CLIENT_ID'),
    consumerKey: read('SNAPTRADE_CONSUMER_KEY'),
    ownerEmail: read('SNAPTRADE_OWNER_EMAIL'),
  };
}

function createClient(env: SnaptradeEnv): Client {
  for (const secret of [env.consumerKey, env.clientId, env.ownerEmail]) sensitiveValues.add(secret);
  return new Snaptrade({
    auth: SnaptradeAuth.personalApiKey({ clientId: env.clientId, consumerKey: env.consumerKey }),
  });
}

// ---- Contract and flags ------------------------------------------------------

function positiveNumber(text: string | undefined, flag: string): number {
  const value = Number(text);
  if (text === undefined || text.trim() === '' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive number, got "${text ?? ''}".`);
  }
  return value;
}

function contractFromFlags(flags: Flags): OptionContract {
  const { underlying, expiry, strike, type } = flags;
  const optionType = OPTION_TYPES.find((candidate) => candidate === type?.toLowerCase());
  if (!underlying || !expiry || !strike || !optionType) {
    throw new Error('A contract needs --underlying <symbol> --expiry YYYY-MM-DD --strike <price> --type call|put.');
  }
  return { underlying, expiry, strike: positiveNumber(strike, '--strike'), optionType };
}

/**
 * The 21-character OCC symbol SnapTrade's option order takes: root padded to 6
 * with spaces, YYMMDD, C or P, strike in thousandths padded to 8 digits.
 * `AAPL  251114C00240000` is the AAPL 2025-11-14 240 call.
 */
function buildOccSymbol(contract: OptionContract): string {
  const root = contract.underlying.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(root)) {
    throw new Error(`underlying must be 1 to ${OCC_ROOT_WIDTH} letters or digits, got "${contract.underlying}".`);
  }
  const expiry = new Date(`${contract.expiry}T00:00:00Z`);
  // The round trip rejects dates the calendar does not have (2026-02-30).
  if (Number.isNaN(expiry.getTime()) || expiry.toISOString().slice(0, 10) !== contract.expiry) {
    throw new Error(`expiry must be a real date as YYYY-MM-DD, got "${contract.expiry}".`);
  }
  const thousandths = Math.round(contract.strike * OCC_STRIKE_SCALE);
  const strikeFits = thousandths > 0 && String(thousandths).length <= OCC_STRIKE_DIGITS;
  if (!strikeFits || Math.abs(contract.strike * OCC_STRIKE_SCALE - thousandths) > 1e-6) {
    throw new Error(`strike must be positive with at most 3 decimals, got ${contract.strike}.`);
  }
  const yymmdd = contract.expiry.slice(2).replaceAll('-', '');
  const side = contract.optionType === 'call' ? 'C' : 'P';
  return `${root.padEnd(OCC_ROOT_WIDTH)}${yymmdd}${side}${String(thousandths).padStart(OCC_STRIKE_DIGITS, '0')}`;
}

/** Brokers return the OCC symbol with or without the root padding. */
function sameOcc(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.replace(/\s+/g, '') === right.replace(/\s+/g, '');
}

function timeInForce(text: string | undefined): TimeInForceStrict {
  // GTC by default: that is how the trader rests its Max Loss stops today (trader/stops.ts).
  const value = (text ?? 'gtc').toLowerCase();
  if (value === 'gtc') return 'GTC';
  if (value === 'day') return 'Day';
  throw new Error(`--tif must be gtc or day, got "${text}".`);
}

// ---- Redaction and recording -------------------------------------------------

/** Remembers the value under every sensitive key, so it is also scrubbed where it shows up under another key. */
function learnSensitiveValues(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, inner] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && typeof inner === 'string' && inner.length >= MIN_SENSITIVE_VALUE_LENGTH) {
      sensitiveValues.add(inner);
    }
    learnSensitiveValues(inner);
  }
}

// ponytail: redaction goes by key name plus the values seen under those keys.
// An account number that only ever appears inside free text (a display name)
// is not caught; read a recording before copying it into a test fixture.
function redact(value: unknown, secrets: Iterable<string> = sensitiveValues): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) text = text.split(secret).join(REDACTED);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SENSITIVE_KEY.test(key) && inner !== null && inner !== undefined ? REDACTED : redact(inner, secrets),
      ])
    );
  }
  return value;
}

function record(name: string, payload: Record<string, unknown>): void {
  learnSensitiveValues(payload);
  mkdirSync(RECORD_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`${RECORD_DIR}${stamp}-${name}.json`, `${JSON.stringify(redact(payload), null, 2)}\n`);
}

function describeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof SnaptradeError)) return { message: err instanceof Error ? err.message : String(err) };
  // Not err.message: the SDK appends every response header to it.
  return {
    status: err.status,
    statusText: err.statusText,
    code: err.code,
    method: err.method,
    url: err.url,
    responseBody: err.responseBody,
  };
}

/** Sends one SDK request, times it, and saves the request with its response or its error. */
async function call<T>(
  name: string,
  request: Record<string, unknown>,
  send: () => Promise<{ data: T; status: number }>
): Promise<Recorded<T>> {
  const startedAt = performance.now();
  try {
    const response = await send();
    const elapsedMs = Math.round(performance.now() - startedAt);
    record(name, { call: name, request, elapsedMs, status: response.status, response: response.data });
    return { data: response.data, elapsedMs };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    record(`${name}-error`, { call: name, request, elapsedMs, error: describeError(err) });
    throw err;
  }
}

function report(check: string, passed: boolean, evidence: Record<string, unknown>): boolean {
  console.log(`\n${passed ? 'PASS' : 'FAIL'}  ${check}`);
  console.log(JSON.stringify(redact(evidence), null, 2));
  return passed;
}

function readLedger(): PlacedOrder[] {
  if (!existsSync(LEDGER_FILE)) return [];
  return readFileSync(LEDGER_FILE, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as PlacedOrder);
}

function appendLedger(entry: PlacedOrder): void {
  mkdirSync(RECORD_DIR, { recursive: true });
  appendFileSync(LEDGER_FILE, `${JSON.stringify(entry)}\n`);
}

// ---- Accounts and the paper guard --------------------------------------------

/** Every reason this account must not receive an order; empty means it may. */
function paperGuardRefusals(account: ConnectionAccount, connection: BrokerageAuthorization | undefined): string[] {
  const refusals: string[] = [];
  if (account.kind !== 'investment') refusals.push(`account kind is ${account.kind}, not investment`);
  else if (account.is_paper !== true) refusals.push('account is not flagged is_paper');
  if (!connection) return [...refusals, 'no connection found for the account'];

  const slug = connection.brokerage?.slug;
  if (slug !== ALPACA_PAPER_SLUG) refusals.push(`brokerage slug is ${slug ?? 'missing'}, not ${ALPACA_PAPER_SLUG}`);
  if (connection.type !== TRADE_CONNECTION_TYPE) {
    refusals.push(`connection type is ${connection.type ?? 'missing'}, not ${TRADE_CONNECTION_TYPE}`);
  }
  if (connection.disabled === true) refusals.push('connection is disabled and needs a reconnect');
  return refusals;
}

function judgeAccounts(accounts: ConnectionAccount[], connections: BrokerageAuthorization[]): JudgedAccount[] {
  return accounts.map((account) => {
    const connection = connections.find((candidate) => candidate.id === account.connection_id);
    return { account, connection, refusals: paperGuardRefusals(account, connection) };
  });
}

/** The one account orders may go to. Throws when there is none, or when the choice is not clear. */
function pickPaperAccount(judged: JudgedAccount[], requestedId: string | undefined): string {
  const allowed = judged.filter((entry) => entry.refusals.length === 0).map((entry) => entry.account.id);
  if (requestedId !== undefined) {
    if (!allowed.includes(requestedId)) {
      throw new Error(`--account ${requestedId} is not an Alpaca Paper account on a trade connection. Refusing.`);
    }
    return requestedId;
  }
  const [only, ...others] = allowed;
  if (only === undefined) {
    throw new Error('No Alpaca Paper account on a trade connection was found. Refusing. Run `connect` first.');
  }
  if (others.length > 0) {
    throw new Error(`${allowed.length} Alpaca Paper accounts qualify (${allowed.join(', ')}). Pass --account <id>.`);
  }
  return only;
}

async function listJudgedAccounts(client: Client): Promise<JudgedAccount[]> {
  const connections = await call('list-connections', {}, () => client.connections.listBrokerageAuthorizations());
  const accounts = await call('list-accounts', {}, () => client.accountInformation.listAllUserAccounts());
  const judged = judgeAccounts(accounts.data.results ?? [], connections.data ?? []);

  console.log(`Connections: ${connections.data.length}. Accounts: ${judged.length}.`);
  for (const { account, connection, refusals } of judged) {
    const brokerage = connection?.brokerage;
    console.log(`  account ${account.id}`);
    console.log(
      `    kind=${account.kind} is_paper=${String(account.is_paper)} number=${String(account.masked_account_number)}`
    );
    console.log(
      `    connection ${connection?.id ?? 'missing'}: ${brokerage?.name ?? '?'} (slug ${brokerage?.slug ?? '?'}) ` +
        `type=${connection?.type ?? '?'} disabled=${String(connection?.disabled)}`
    );
    console.log(`    orders: ${refusals.length === 0 ? 'ALLOWED' : `refused (${refusals.join('; ')})`}`);
  }
  // SnapTrade serves this account list from a cache, so a connection made a moment ago can be ahead of it.
  for (const connection of connections.data ?? []) {
    if (judged.some((entry) => entry.connection === connection)) continue;
    console.log(
      `  connection ${connection.id} (slug ${connection.brokerage?.slug ?? '?'}) has no accounts listed yet; ` +
        'rerun in a few minutes'
    );
  }
  return judged;
}

/** Runs a check on the one Alpaca Paper account, then lists whatever is left working or open on it. */
function onPaperAccount(flags: Flags, check: AccountCheck): Command {
  return async (client) => {
    const accountId = pickPaperAccount(await listJudgedAccounts(client), flags.account);
    try {
      return await check(client, accountId);
    } finally {
      await printLeftovers(client, accountId).catch((err: unknown) => {
        console.error(`Could not list working orders and positions: ${JSON.stringify(redact(describeError(err)))}`);
        console.error('Wait a minute, then run: npm run snaptrade:check -- status');
      });
    }
  };
}

// ---- Orders ------------------------------------------------------------------

function singleLegForm(
  occSymbol: string,
  action: MlegLeg['action'],
  units: number,
  pricing: Omit<MlegTradeForm, 'legs'>
): MlegTradeForm {
  return { ...pricing, legs: [{ instrument: { symbol: occSymbol, instrument_type: 'OPTION' }, action, units }] };
}

async function attemptOrder(
  client: Client,
  accountId: string,
  kind: OrderKind,
  occSymbol: string,
  form: MlegTradeForm
): Promise<OrderAttempt> {
  const leg = form.legs[0];
  console.log(`Sending ${form.order_type} ${leg?.action} x${leg?.units} "${occSymbol}" (${form.time_in_force})`);
  const requestedAt = new Date().toISOString();
  try {
    const placed = await call(`place-${kind}`, { accountId, ...form }, () =>
      client.trading.placeMlegOrder({ accountId, ...form })
    );
    const orderId = placed.data.brokerage_order_id;
    const statuses = (placed.data.orders ?? []).map((order) => order.status ?? 'missing');
    if (orderId) appendLedger({ at: requestedAt, kind, accountId, occSymbol, brokerageOrderId: orderId });
    const refused = !orderId || statuses.some((status) => REFUSED_STATUSES.has(status));
    return {
      orderId: refused ? null : orderId,
      evidence: { brokerageOrderId: orderId, statuses, requestToAcceptedMs: placed.elapsedMs },
    };
  } catch (err) {
    return { orderId: null, evidence: { error: describeError(err) } };
  }
}

async function recentOrders(client: Client, accountId: string): Promise<Recorded<AccountOrderRecord[]>> {
  // onlyExecuted defaults to true, which would hide a resting or rejected order.
  const request = { accountId, onlyExecuted: false };
  const read = await call('recent-orders', request, () =>
    client.accountInformation.getUserAccountRecentOrders(request)
  );
  return { data: read.data.orders ?? [], elapsedMs: read.elapsedMs };
}

async function openPositions(client: Client, accountId: string): Promise<AccountPosition[]> {
  const read = await call('positions', { accountId }, () =>
    client.accountInformation.getAllAccountPositions({ accountId })
  );
  return (read.data.results ?? []).filter((position) => Number(position.units) !== 0);
}

function isWorking(order: AccountOrderRecord): boolean {
  return !TERMINAL_STATUSES.has(order.status ?? '');
}

function findOrder(orders: AccountOrderRecord[], orderId: string): AccountOrderRecord | undefined {
  return orders.find((order) => order.brokerage_order_id === orderId);
}

function orderSymbol(order: AccountOrderRecord): string {
  return order.option_symbol?.ticker ?? order.universal_symbol?.symbol ?? 'unknown symbol';
}

function heldContracts(positions: HeldPosition[], occSymbol: string): number {
  return positions
    .filter(({ instrument }) => instrument.kind === 'option' && sameOcc(instrument.symbol, occSymbol))
    .reduce((total, position) => total + Number(position.units ?? 0), 0);
}

/**
 * Contracts cleanup may sell, per OCC symbol: what this script's own orders
 * bought less what they sold, capped at what the account holds.
 * ponytail: fills are read from recent orders, which cover the last 24 hours.
 * A test position older than that is not sold here; `status` lists it and it
 * is closed by hand in the Alpaca paper dashboard.
 */
function unitsToSell(mine: PlacedOrder[], orders: AccountOrderRecord[], positions: HeldPosition[]): Map<string, number> {
  const net = new Map<string, number>();
  for (const entry of mine) {
    const filled = Number(findOrder(orders, entry.brokerageOrderId)?.filled_quantity ?? 0);
    if (!(filled > 0)) continue;
    net.set(entry.occSymbol, (net.get(entry.occSymbol) ?? 0) + (entry.kind === 'buy' ? filled : -filled));
  }
  const sellable = new Map<string, number>();
  for (const [occSymbol, bought] of net) {
    const units = Math.min(bought, heldContracts(positions, occSymbol));
    if (units > 0) sellable.set(occSymbol, units);
  }
  return sellable;
}

async function printLeftovers(client: Client, accountId: string): Promise<void> {
  const mine = readLedger().filter((entry) => entry.accountId === accountId);
  const working = (await recentOrders(client, accountId)).data.filter(isWorking);
  const open = await openPositions(client, accountId);
  const ownOrder = (order: AccountOrderRecord): boolean =>
    mine.some((entry) => entry.brokerageOrderId === order.brokerage_order_id);
  const ownPosition = (position: AccountPosition): boolean =>
    mine.some((entry) => position.instrument.kind === 'option' && sameOcc(position.instrument.symbol, entry.occSymbol));

  console.log(`\nOrders left working: ${working.length}`);
  for (const order of working) {
    console.log(
      `  ${order.brokerage_order_id} ${order.action} "${orderSymbol(order)}" ${order.order_type} ` +
        `status=${order.status}${ownOrder(order) ? '  <- sent by this script' : ''}`
    );
  }
  console.log(`Positions left open: ${open.length}`);
  for (const position of open) {
    console.log(
      `  "${String(position.instrument.symbol ?? position.instrument.kind)}" units=${position.units} ` +
        `cost_basis=${position.cost_basis}${ownPosition(position) ? '  <- contract this script bought' : ''}`
    );
  }
  if (working.some(ownOrder) || open.some(ownPosition)) {
    console.log('To cancel and sell what this script left: npm run snaptrade:check -- cleanup --limit <price>');
  }
}

// ---- The checks --------------------------------------------------------------

/** Check 1, first half: a portal link from the Personal key alone, with no registered SnapTrade user. */
async function connect(client: Client, pickBroker: boolean): Promise<boolean> {
  const request = {
    connectionType: TRADE_CONNECTION_TYPE,
    connectionPortalVersion: 'v4',
    ...(pickBroker ? {} : { broker: ALPACA_PAPER_SLUG }),
  } as const;
  const login = await call('connect-link', request, () => client.authentication.loginSnapTradeUser(request));
  const link = 'redirectURI' in login.data ? login.data.redirectURI : undefined;
  if (!link) {
    return report('check 1: Connection Portal link from the Personal key', false, {
      responseKeys: Object.keys(login.data),
      elapsedMs: login.elapsedMs,
    });
  }
  report('check 1: Connection Portal link from the Personal key', true, { elapsedMs: login.elapsedMs });
  console.log('\nOpen this link in a browser within 5 minutes and sign in to Alpaca PAPER:\n');
  console.log(link);
  console.log('\nThen run: npm run snaptrade:check -- accounts');
  return true;
}

/** Check 1, second half: the connection exists with trading access and the account is flagged paper. */
async function accounts(client: Client): Promise<boolean> {
  const judged = await listJudgedAccounts(client);
  const allowed = judged.filter((entry) => entry.refusals.length === 0).map((entry) => entry.account.id);
  return report('check 1: Alpaca Paper connected with trading access', allowed.length > 0, {
    accountsOrdersMayGoTo: allowed,
  });
}

/** Check 2: a single-leg option buy is accepted. */
function prepareBuy(flags: Flags): AccountCheck {
  const occSymbol = buildOccSymbol(contractFromFlags(flags));
  const limit = positiveNumber(flags.limit, '--limit');
  console.log(`OCC symbol: "${occSymbol}"`);

  return async (client, accountId) => {
    const form = singleLegForm(occSymbol, 'BUY_TO_OPEN', TEST_CONTRACTS, {
      order_type: 'LIMIT',
      time_in_force: 'Day',
      limit_price: String(limit),
      price_effect: 'DEBIT',
    });
    const attempt = await attemptOrder(client, accountId, 'buy', occSymbol, form);
    return report('check 2: single-leg option buy accepted', attempt.orderId !== null, attempt.evidence);
  };
}

/** Check 3: an option stop is accepted, rests, and can be cancelled. The stop is always cancelled. */
function prepareStop(flags: Flags): AccountCheck {
  const occSymbol = buildOccSymbol(contractFromFlags(flags));
  const stopPrice = positiveNumber(flags.stop, '--stop');
  const tif = timeInForce(flags.tif);
  console.log(`OCC symbol: "${occSymbol}"`);

  return async (client, accountId) => {
    const held = heldContracts(await openPositions(client, accountId), occSymbol);
    if (held < TEST_CONTRACTS) {
      throw new Error(
        `The account holds ${held} of "${occSymbol}". A SELL_TO_CLOSE stop needs the filled position: ` +
          'run buy, then fills, first.'
      );
    }
    const form = singleLegForm(occSymbol, 'SELL_TO_CLOSE', TEST_CONTRACTS, {
      order_type: 'STOP_LOSS_MARKET',
      time_in_force: tif,
      stop_price: String(stopPrice),
    });
    const attempt = await attemptOrder(client, accountId, 'stop', occSymbol, form);
    if (attempt.orderId === null) return report('check 3: option stop order accepted', false, attempt.evidence);
    const cancelRequest = { accountId, brokerage_order_id: attempt.orderId };

    let rests = false;
    const restEvidence: Record<string, unknown> = { ...attempt.evidence, timeInForce: tif };
    try {
      // A stop the broker turns down after accepting it shows up within seconds.
      await sleep(POLL_INTERVAL_MS);
      const resting = findOrder((await recentOrders(client, accountId)).data, attempt.orderId);
      rests = resting !== undefined && isWorking(resting);
      Object.assign(restEvidence, {
        statusAfterWait: resting?.status ?? 'not in recent orders',
        orderType: resting?.order_type,
        stopPrice: resting?.stop_price,
        openQuantity: resting?.open_quantity,
      });
    } finally {
      const cancel = await call('cancel-stop', cancelRequest, () => client.trading.cancelOrder(cancelRequest));
      restEvidence.cancelRequestMs = cancel.elapsedMs;
    }
    const afterCancel = findOrder((await recentOrders(client, accountId)).data, attempt.orderId);
    const cancelled = CANCELLED_STATUSES.has(afterCancel?.status ?? '');

    const restPassed = report('check 3: option stop order accepted and rests', rests, restEvidence);
    const cancelPassed = report('check 3: resting stop cancelled', cancelled, {
      statusAfterCancel: afterCancel?.status ?? 'not in recent orders',
    });
    return restPassed && cancelPassed;
  };
}

/** Check 4: after a fill, recent orders show the quantity and the fill price. */
function prepareFills(flags: Flags): AccountCheck {
  return async (client, accountId) => {
    const lastBuy = readLedger()
      .filter((entry) => entry.kind === 'buy' && entry.accountId === accountId)
      .at(-1);
    const orderId = flags.order ?? lastBuy?.brokerageOrderId;
    if (!orderId) throw new Error('No buy sent by this script is on record. Run buy first, or pass --order <id>.');

    let order: AccountOrderRecord | undefined;
    let readMs = 0;
    let reads = 0;
    while (reads < FILL_POLL_ATTEMPTS) {
      if (reads > 0) await sleep(POLL_INTERVAL_MS);
      const read = await recentOrders(client, accountId);
      reads += 1;
      readMs = read.elapsedMs;
      order = findOrder(read.data, orderId);
      console.log(
        `  read ${reads}: status=${order?.status ?? 'not in recent orders'} filled=${order?.filled_quantity} ` +
          `price=${order?.execution_price} (${readMs} ms)`
      );
      if (order !== undefined && !isWorking(order)) break;
    }

    const filled = Number(order?.filled_quantity);
    const price = Number(order?.execution_price);
    const passed = order?.status === 'EXECUTED' && filled >= TEST_CONTRACTS && price > 0;
    return report('check 4: fill read back from recent orders', passed, {
      brokerageOrderId: orderId,
      status: order?.status ?? 'not in recent orders',
      filledQuantity: order?.filled_quantity,
      executionPricePerShare: order?.execution_price,
      timePlaced: order?.time_placed,
      timeExecuted: order?.time_executed,
      reads,
      lastReadMs: readMs,
      // Counts the time before this command was started, so run it straight after buy.
      msFromBuyRequestToFillSeen:
        flags.order === undefined && lastBuy ? Date.now() - Date.parse(lastBuy.at) : 'unknown for --order',
    });
  };
}

function prepareCleanup(flags: Flags): AccountCheck {
  const limit = flags.limit === undefined ? undefined : positiveNumber(flags.limit, '--limit');

  return async (client, accountId) => {
    const mine = readLedger().filter((entry) => entry.accountId === accountId);
    const orders = (await recentOrders(client, accountId)).data;
    const ownWorking = orders.filter(
      (order) => isWorking(order) && mine.some((entry) => entry.brokerageOrderId === order.brokerage_order_id)
    );
    // Cancels first: a resting stop holds the contract and would block the sell.
    for (const order of ownWorking) {
      const request = { accountId, brokerage_order_id: order.brokerage_order_id ?? '' };
      await call('cancel-order', request, () => client.trading.cancelOrder(request));
      console.log(`Cancelled ${order.brokerage_order_id} ("${orderSymbol(order)}")`);
    }

    let clean = true;
    for (const [occSymbol, units] of unitsToSell(mine, orders, await openPositions(client, accountId))) {
      if (limit === undefined) {
        console.log(`Still holding ${units} x "${occSymbol}" bought by this script. Rerun with --limit <price>.`);
        clean = false;
        continue;
      }
      const form = singleLegForm(occSymbol, 'SELL_TO_CLOSE', units, {
        order_type: 'LIMIT',
        time_in_force: 'Day',
        limit_price: String(limit),
        price_effect: 'CREDIT',
      });
      const attempt = await attemptOrder(client, accountId, 'sell', occSymbol, form);
      clean = report(`cleanup: sell ${units} x "${occSymbol}" accepted`, attempt.orderId !== null, attempt.evidence) && clean;
    }
    return clean;
  };
}

/** Each entry validates its flags (and prints the OCC symbol) when called, before any request is sent. */
const COMMANDS: Record<string, (flags: Flags) => Command> = {
  connect: (flags) => (client) => connect(client, flags['pick-broker'] === true),
  accounts: () => accounts,
  buy: (flags) => onPaperAccount(flags, prepareBuy(flags)),
  stop: (flags) => onPaperAccount(flags, prepareStop(flags)),
  fills: (flags) => onPaperAccount(flags, prepareFills(flags)),
  cleanup: (flags) => onPaperAccount(flags, prepareCleanup(flags)),
  // The closing list of working orders and open positions is the whole command.
  status: (flags) => onPaperAccount(flags, () => Promise.resolve(true)),
};

// ---- Offline self-check ------------------------------------------------------

function selfCheck(): void {
  const spyCall: OptionContract = { underlying: 'spy', expiry: '2026-11-20', strike: 600, optionType: 'call' };
  // SnapTrade's own example of the format, from the SDK's MlegTradingInstrument doc.
  assert.equal(
    buildOccSymbol({ underlying: 'AAPL', expiry: '2025-11-14', strike: 240, optionType: 'call' }),
    'AAPL  251114C00240000'
  );
  assert.equal(buildOccSymbol(spyCall), 'SPY   261120C00600000');
  assert.equal(buildOccSymbol({ ...spyCall, strike: 397.5, optionType: 'put' }), 'SPY   261120P00397500');
  assert.equal(buildOccSymbol({ ...spyCall, underlying: 'GOOGL', strike: 0.5 }), 'GOOGL 261120C00000500');
  assert.equal(buildOccSymbol(spyCall).length, 21);
  assert.throws(() => buildOccSymbol({ ...spyCall, expiry: '2026-02-30' }), /real date/);
  assert.throws(() => buildOccSymbol({ ...spyCall, expiry: '11/20/2026' }), /real date/);
  assert.throws(() => buildOccSymbol({ ...spyCall, strike: 600.1234 }), /at most 3 decimals/);
  assert.throws(() => buildOccSymbol({ ...spyCall, strike: 100_000 }), /at most 3 decimals/);
  assert.throws(() => buildOccSymbol({ ...spyCall, underlying: 'TOOLONG' }), /underlying/);
  assert.ok(sameOcc('SPY261120C00600000', 'SPY   261120C00600000'));
  assert.ok(!sameOcc('SPY261120P00600000', 'SPY   261120C00600000'));
  assert.ok(!sameOcc(undefined, 'SPY   261120C00600000'));

  assert.deepEqual(contractFromFlags({ underlying: 'SPY', expiry: '2026-11-20', strike: '600', type: 'CALL' }), {
    underlying: 'SPY',
    expiry: '2026-11-20',
    strike: 600,
    optionType: 'call',
  });
  assert.throws(() => contractFromFlags({ underlying: 'SPY', expiry: '2026-11-20', strike: '600' }), /--type/);
  assert.throws(() => contractFromFlags({ underlying: 'SPY', expiry: '2026-11-20', strike: '600', type: 'x' }), /--type/);
  assert.throws(() => positiveNumber('0', '--limit'), /--limit/);
  assert.throws(() => positiveNumber('abc', '--limit'), /--limit/);
  assert.throws(() => positiveNumber(undefined, '--limit'), /--limit/);
  assert.equal(timeInForce(undefined), 'GTC');
  assert.equal(timeInForce('day'), 'Day');
  assert.throws(() => timeInForce('ioc'), /--tif/);

  assert.throws(
    () => readSnaptradeEnv({ SNAPTRADE_CLIENT_ID: 'id', SNAPTRADE_CONSUMER_KEY: ' ' }),
    /Missing SNAPTRADE_CONSUMER_KEY, SNAPTRADE_OWNER_EMAIL\./
  );
  assert.throws(() => readSnaptradeEnv({}), /Missing SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY, SNAPTRADE_OWNER_EMAIL\./);
  assert.equal(
    readSnaptradeEnv({ SNAPTRADE_CLIENT_ID: 'id', SNAPTRADE_CONSUMER_KEY: 'key', SNAPTRADE_OWNER_EMAIL: 'a@b.c' }).clientId,
    'id'
  );

  const paperAccount: ConnectionAccount = {
    kind: 'investment',
    id: 'account-paper',
    connection_id: 'connection-paper',
    masked_account_number: '****1234',
    is_paper: true,
    sync_status: {},
  };
  const paperConnection: BrokerageAuthorization = {
    id: 'connection-paper',
    type: 'trade',
    disabled: false,
    brokerage: { slug: 'ALPACA-PAPER', name: 'Alpaca Paper' },
  };
  const liveAccount: ConnectionAccount = { ...paperAccount, id: 'account-live', connection_id: 'connection-live', is_paper: false };
  const liveConnection: BrokerageAuthorization = {
    ...paperConnection,
    id: 'connection-live',
    brokerage: { slug: 'ALPACA', name: 'Alpaca' },
  };
  assert.deepEqual(paperGuardRefusals(paperAccount, paperConnection), []);
  assert.equal(paperGuardRefusals(liveAccount, liveConnection).length, 2);
  assert.match(paperGuardRefusals(paperAccount, liveConnection).join(), /slug is ALPACA, not ALPACA-PAPER/);
  assert.match(paperGuardRefusals(liveAccount, paperConnection).join(), /is_paper/);
  assert.match(paperGuardRefusals(paperAccount, { ...paperConnection, type: 'read' }).join(), /type is read/);
  assert.match(paperGuardRefusals(paperAccount, { ...paperConnection, disabled: true }).join(), /disabled/);
  assert.match(paperGuardRefusals(paperAccount, { ...paperConnection, brokerage: undefined }).join(), /slug is missing/);
  assert.match(paperGuardRefusals(paperAccount, undefined).join(), /no connection/);

  const judged = judgeAccounts([paperAccount, liveAccount], [paperConnection, liveConnection]);
  assert.equal(pickPaperAccount(judged, undefined), 'account-paper');
  assert.equal(pickPaperAccount(judged, 'account-paper'), 'account-paper');
  assert.throws(() => pickPaperAccount(judged, 'account-live'), /Refusing/);
  assert.throws(() => pickPaperAccount(judgeAccounts([liveAccount], [liveConnection]), undefined), /Refusing/);
  assert.throws(() => pickPaperAccount(judgeAccounts([paperAccount], []), undefined), /Refusing/);
  const secondPaper: ConnectionAccount = { ...paperAccount, id: 'account-paper-2' };
  assert.throws(() => pickPaperAccount(judgeAccounts([paperAccount, secondPaper], [paperConnection]), undefined), /--account/);

  const secrets = ['consumer-key-value', 'PA3XYZ123456'];
  assert.deepEqual(
    redact(
      {
        id: 'account-paper',
        number: 'PA3XYZ123456',
        masked_account_number: '****3456',
        display_name: 'Paper PA3XYZ123456',
        redirectURI: 'https://app.snaptrade.com/portal?token=abc',
        nested: [{ userSecret: 'shh', is_paper: true, units: null, institution_account_id: null }],
      },
      secrets
    ),
    {
      id: 'account-paper',
      number: REDACTED,
      masked_account_number: REDACTED,
      display_name: `Paper ${REDACTED}`,
      redirectURI: REDACTED,
      nested: [{ userSecret: REDACTED, is_paper: true, units: null, institution_account_id: null }],
    }
  );
  assert.equal(redact('signed with consumer-key-value', secrets), `signed with ${REDACTED}`);

  assert.ok(isWorking({ status: 'ACCEPTED' }));
  assert.ok(isWorking({}));
  assert.ok(!isWorking({ status: 'EXECUTED' }));
  assert.ok(!isWorking({ status: 'CANCELED' }));

  const occSymbol = buildOccSymbol(spyCall);
  const ledgerEntry = (kind: OrderKind, brokerageOrderId: string): PlacedOrder => ({
    at: '2026-11-12T15:00:00.000Z',
    kind,
    accountId: 'account-paper',
    occSymbol,
    brokerageOrderId,
  });
  const holding = (units: string): HeldPosition[] => [
    { instrument: { kind: 'option', symbol: 'SPY261120C00600000' }, units },
    { instrument: { kind: 'stock', symbol: 'SPY' }, units: '50' },
  ];
  const filledBuy: AccountOrderRecord = { brokerage_order_id: 'buy-1', status: 'EXECUTED', filled_quantity: '1' };
  assert.equal(heldContracts(holding('2'), occSymbol), 2);
  assert.deepEqual([...unitsToSell([ledgerEntry('buy', 'buy-1')], [filledBuy], holding('1'))], [[occSymbol, 1]]);
  // Caps at the script's own fill when the account holds more of the contract.
  assert.deepEqual([...unitsToSell([ledgerEntry('buy', 'buy-1')], [filledBuy], holding('3'))], [[occSymbol, 1]]);
  // Nothing to sell: already sold, never filled, or no longer held.
  const filledSell: AccountOrderRecord = { brokerage_order_id: 'sell-1', status: 'EXECUTED', filled_quantity: '1' };
  assert.equal(
    unitsToSell([ledgerEntry('buy', 'buy-1'), ledgerEntry('sell', 'sell-1')], [filledBuy, filledSell], holding('1')).size,
    0
  );
  assert.equal(unitsToSell([ledgerEntry('buy', 'buy-1')], [{ ...filledBuy, filled_quantity: '0' }], holding('1')).size, 0);
  assert.equal(unitsToSell([ledgerEntry('buy', 'buy-1')], [], holding('1')).size, 0);
  assert.equal(unitsToSell([ledgerEntry('buy', 'buy-1')], [filledBuy], []).size, 0);

  console.log('self-check ok');
}

// ---- Entry -------------------------------------------------------------------

async function main(argv: string[]): Promise<boolean> {
  const { positionals, values: flags } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      underlying: { type: 'string' },
      expiry: { type: 'string' },
      strike: { type: 'string' },
      type: { type: 'string' },
      limit: { type: 'string' },
      stop: { type: 'string' },
      tif: { type: 'string' },
      account: { type: 'string' },
      order: { type: 'string' },
      'pick-broker': { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? '';
  if (command === 'self-check') {
    selfCheck();
    return true;
  }
  const prepare = COMMANDS[command];
  if (prepare === undefined) {
    console.log(USAGE);
    return false;
  }
  const env = readSnaptradeEnv(process.env);
  const run = prepare(flags);
  return run(createClient(env));
}

main(process.argv.slice(2))
  .then((passed) => process.exit(passed ? 0 : 1))
  .catch((err: unknown) => {
    const failure = redact(describeError(err));
    const detail = err instanceof SnaptradeError ? JSON.stringify(failure, null, 2) : String(redact(String(err)));
    console.error(`\nsnaptrade check stopped: ${detail}`);
    if (err instanceof SnaptradeError && err.status === HTTP_TOO_MANY_REQUESTS) {
      console.error('Rate limited (10 requests a minute per account on a Personal key). Wait a minute and rerun.');
    }
    process.exit(1);
  });
