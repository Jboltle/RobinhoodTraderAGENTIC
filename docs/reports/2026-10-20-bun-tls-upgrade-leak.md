# Bun keeps every byte received after `tls.connect({ socket })`: postgres.js over TLS grows without bound

**Suggested issue title (oven-sh/bun):** `node:tls`: after `tls.connect({ socket })`, the original `net.Socket` keeps buffering every received byte (unbounded memory growth with postgres.js over TLS)

## Summary

When an existing `net.Socket` is upgraded with `tls.connect({ socket })`, Bun keeps pushing every byte the peer sends into the **original** socket's readable buffer. TLS itself works, and the application reads decrypted data from the `TLSSocket` as expected, but that second copy is never consumed and never freed. Memory grows by the size of everything received.

postgres.js upgrades its connection exactly this way: it sends Postgres's plaintext `SSLRequest`, gets `S`, calls `socket.removeAllListeners()`, then `tls.connect({ socket })`. So with `ssl: 'require'`, every query result stays in memory. Each 500-row read leaked roughly the size of its result, 235–265 KB in these runs.

The same code on Node 24 does not grow. On Bun the growth stops if anything reads the original socket after the upgrade (a no-op `'data'` listener), and queries keep working. So the buffered bytes are a pure duplicate that Node never hands to the original socket.

## Environment

| | |
| --- | --- |
| Bun | 1.2.18 and 1.3.14 (both reproduce) |
| Node (comparison) | 24.19.0 (does not reproduce) |
| postgres.js | 3.4.9 |
| PostgreSQL | 17 (local, self-signed cert); also Supabase's session pooler in production |
| OS | Linux x64 (WSL2, kernel 6.18); production is Railway's `oven/bun:1.2.18-slim` image |

## The code path in postgres.js 3.4.9

`src/connection.js`, after the server answers `S` to the `SSLRequest`:

```js
const options = {
  socket,
  servername: net.isIP(socket.host) ? undefined : socket.host
}
// ...
if (ssl === 'require' || ssl === 'allow' || ssl === 'prefer')
  options.rejectUnauthorized = false
else if (typeof ssl === 'object')
  Object.assign(options, ssl)

socket.removeAllListeners()
socket = tls.connect(options)
socket.on('secureConnect', connected)
socket.on('error', error)
socket.on('close', closed)
socket.on('drain', drain)
```

This is the documented Node API. Node's docs for the `socket` option of `tls.connect()` say it will "establish secure connection on a given socket rather than creating a new socket."

## Reproduction

### 1. A local Postgres with TLS, and a table to read

```bash
initdb -D pgtls -U postgres -A trust
openssl req -new -x509 -days 1 -nodes -subj /CN=localhost \
  -keyout pgtls/server.key -out pgtls/server.crt
chmod 600 pgtls/server.key
printf "ssl = on\nssl_cert_file = 'server.crt'\nssl_key_file = 'server.key'\n" >> pgtls/postgresql.conf
pg_ctl -D pgtls -o "-p 55443 -k /tmp" -l pgtls.log start
```

```sql
-- psql -h localhost -p 55443 -U postgres
create table trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  message_id text not null,
  kind text not null,
  code text,
  reason text not null,
  ticker text,
  action text,
  order_payload jsonb,
  "timestamp" timestamptz not null default now(),
  approved_at timestamptz
);

insert into trades (user_id, message_id, kind, reason, ticker, action, order_payload, "timestamp")
select '11111111-1111-4111-8111-111111111111',
       (1400000000000000000 + g)::text,
       'submitted',
       'Approved — BUY 3 NBIS 10/24 $52 call @ $1.59 limit (Demon Alerts); sized from 2.5% of buying power',
       'NBIS', 'buy',
       jsonb_build_object('symbol','NBIS','side','buy','assetType','option','quantity',3,
         'orderType','limit','limitPrice',1.59,
         'option', jsonb_build_object('optionType','call','strike',52,'expiration','2026-10-24'),
         'orderId', gen_random_uuid()::text, 'status','queued'),
       now() - (g || ' minutes')::interval
from generate_series(1, 600) g;
```

With this seed, one 500-row result is roughly 260 KB: the 2,000-read run below grew by about 263 KB per read.

### 2. Bun: watch the original socket while reading over TLS

`leak.ts`. This wraps `tls.connect` only to capture the socket postgres.js passes in, so its buffer can be printed. With `drain`, it also attaches a no-op `'data'` listener to that socket after the upgrade.

```ts
// bun add postgres@3.4.9
// bun leak.ts 2000          as postgres.js does it
// bun leak.ts 2000 drain    same, but something reads the original socket
import tls from 'node:tls';
import { heapStats } from 'bun:jsc';
import postgres from 'postgres';

const [countArg = '2000', drainArg] = process.argv.slice(2);
const total = Number(countArg);
const drain = drainArg === 'drain';

let plain: import('node:net').Socket | undefined;
const connect = tls.connect;
(tls as { connect: typeof tls.connect }).connect = ((options: tls.ConnectionOptions) => {
  plain = options.socket as import('node:net').Socket;
  const secure = connect(options);
  if (drain) plain.on('data', () => {});
  return secure;
}) as typeof tls.connect;

const sql = postgres('postgres://postgres@localhost:55443/postgres', { prepare: false, ssl: 'require' });
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1).padStart(6);
const report = (done: number) => {
  Bun.gc(true);
  const stats = heapStats();
  const types = stats.objectTypeCounts as Record<string, number>;
  const buffers = (types.Uint8Array ?? 0) + (types.ArrayBuffer ?? 0) + (types.Buffer ?? 0);
  console.log(
    `queries=${String(done).padStart(5)}  heap=${mb(stats.heapSize)} MB` +
      `  original socket: unread=${mb(plain?.readableLength ?? 0)} MB, flowing=${plain?.readableFlowing}, data listeners=${plain?.listenerCount('data') ?? 0}` +
      `  byte buffers on heap=${buffers}`
  );
};

report(0);
for (let i = 1; i <= total; i++) {
  const rows = await sql`select * from trades order by "timestamp" desc limit 500`;
  if (rows.length !== 500) throw new Error('short read');
  if (i % (total / 4) === 0) report(i);
}
await sql.end();
```

### 3. Node: the same reads

`leak-node.mjs`:

```js
// node --expose-gc leak-node.mjs 3000
import postgres from 'postgres';

const total = Number(process.argv[2] ?? 3000);
const sql = postgres('postgres://postgres@localhost:55443/postgres', { prepare: false, ssl: 'require' });
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(0).padStart(5);
const report = (done) => {
  global.gc();
  const { rss, heapUsed, arrayBuffers } = process.memoryUsage();
  console.log(`queries=${String(done).padStart(5)}  rss=${mb(rss)} MB  heap=${mb(heapUsed)} MB  buffers=${mb(arrayBuffers)} MB`);
};

report(0);
for (let i = 1; i <= total; i++) {
  const rows = await sql`select * from trades order by "timestamp" desc limit 500`;
  if (rows.length !== 500) throw new Error('short read');
  if (i % (total / 5) === 0) report(i);
}
await sql.end();
```

## Results

### Bun 1.2.18, `bun leak.ts 2000`

```
queries=    0  heap=   1.9 MB  original socket: unread=   0.0 MB, flowing=undefined, data listeners=0  byte buffers on heap=25
queries=  500  heap= 134.6 MB  original socket: unread= 130.9 MB, flowing=null, data listeners=0  byte buffers on heap=1199
queries= 1000  heap= 265.9 MB  original socket: unread= 261.9 MB, flowing=null, data listeners=0  byte buffers on heap=3495
queries= 1500  heap= 396.0 MB  original socket: unread= 392.8 MB, flowing=null, data listeners=0  byte buffers on heap=5771
queries= 2000  heap= 527.4 MB  original socket: unread= 523.7 MB, flowing=null, data listeners=0  byte buffers on heap=8030
```

The original socket's unread buffer accounts for almost the entire heap.

### Bun 1.2.18, `bun leak.ts 2000 drain`

```
queries=    0  heap=   1.9 MB  original socket: unread=   0.0 MB, flowing=undefined, data listeners=0  byte buffers on heap=25
queries=  500  heap=   3.5 MB  original socket: unread=   0.0 MB, flowing=true, data listeners=1  byte buffers on heap=27
queries= 1000  heap=   3.7 MB  original socket: unread=   0.0 MB, flowing=true, data listeners=1  byte buffers on heap=28
queries= 1500  heap=   3.6 MB  original socket: unread=   0.0 MB, flowing=true, data listeners=1  byte buffers on heap=29
queries= 2000  heap=   2.9 MB  original socket: unread=   0.0 MB, flowing=true, data listeners=1  byte buffers on heap=29
```

All 2,000 queries return their 500 rows, so TLS keeps working while the duplicate is discarded.

### Same 3,000 reads of 500 rows on each runtime

Heap measured after a forced full GC. These runs used an earlier seed of the same table with a mix of `kind` values, about 480 bytes per row, and the scripts above minus the socket instrumentation.

| Runtime | Connection | Heap at start | Heap after 3,000 reads | RSS after |
| --- | --- | --- | --- | --- |
| Bun 1.2.18 | `ssl: 'require'` | 2 MB | 704 MB | 845 MB |
| Bun 1.3.14 | `ssl: 'require'` | 2 MB | 704 MB | 820 MB |
| Bun 1.2.18 | `ssl: false` | 2 MB | 3 MB | 92 MB |
| Node 24.19.0 | `ssl: 'require'` | 5 MB | 6 MB | 250 MB (flat after the first 600) |

Bun 1.2.18 grew linearly at every checkpoint: 144, 284, 425, 564 and 704 MB after 600, 1,200, 1,800, 2,400 and 3,000 reads. That is about 235 KB per read, the size of one result.

### Control: Bun's own TLS client is not affected

10,000 sequential `fetch()` calls to a local HTTPS server, each returning 27 KB, on Bun 1.2.18 with a shared `AbortSignal`: RSS went from 33 MB to 57 MB and stayed there, with a flat heap. The growth is specific to upgrading an existing socket through `node:tls`.

## Expected and actual behavior

- **Expected (Node's behavior):** once `tls.connect({ socket })` takes over a socket, received bytes go to the TLS layer and the original socket does not queue them for JavaScript readers. A program that stops listening to the original socket, as postgres.js does, holds no extra memory.
- **Actual (Bun 1.2.18 and 1.3.14):** every received byte is also appended to the original socket's readable buffer. With no reader, the buffer grows by the size of all traffic for the life of the connection.
- **Not checked:** whether the buffer is released when the connection closes. In production, memory kept growing for days without a restart.

## Workarounds

1. **Read the original socket after the upgrade** (`socket.on('data', () => {})`), as in the `drain` run. This needs a hook in the driver or a wrapper around `tls.connect`.
2. **Don't add TLS where the network already encrypts.** What we shipped: on Railway's private network, which is encrypted with WireGuard, the app connects without TLS, and memory stays flat (3–8 MB over 2,000 reads through the same code).
3. **Use Node.js** for the process that holds the database connection.

## Impact in our app

- **Who holds the memory:** in the production container (Bun 1.2.18), `bun src/trader/index.ts` was at 1.59 GB RSS, 1.57 GB of it anonymous memory. The Python Discord listener in the same container was at 65 MB and the supervisor at 54 MB. The trader had 32 open file descriptors, so this isn't a pile of open connections.
- **When it grows:** about 0.2 GB per trading day, starting at the 9:30 AM ET market open and flat at night and on weekends. During market hours a max-loss monitor reads up to 500 trade rows over TLS every 15 seconds.
- **Consequence:** on Oct 13 at 11:24 AM ET the trader reached its 2 GB memory limit, was killed, and restarted at 0.48 GB, mid-session.
- **Cost:** the previous billing period on Railway came to $16.99, almost all of it memory. Memory peaked at 5–6 GB under an 8 GB limit before the limit was lowered to 2 GB.

## Related upstream work

- [oven-sh/bun#29870](https://github.com/oven-sh/bun/pull/29870), "Free DuplexUpgradeContext after duplex TLS upgrade closes": a different leak in the same `tls.connect({ socket })` upgrade path, where an internal context object was allocated per upgrade and never freed. The per-byte buffering described here is a separate symptom, and we didn't find an existing report of it.

## Not yet included

A reproduction without Postgres, using `node:net` and `node:tls` only (a TLS server, a plain `net.connect`, then `tls.connect({ socket })` while the server streams data), would be the smallest possible report. It hasn't been run yet, so it's left out rather than guessed.
