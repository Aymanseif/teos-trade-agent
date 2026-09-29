# TEOS Trade Agent — Phase 1 Security

What this system defends against, how, and — more importantly — what it does not
defend against. Every claim below is traceable to a file in this repository. Where
a source comment disagrees with the code, the code is what is documented here.

Document status: accurate to `configVersion: 1`, profile `phase1-paper-defaults`.

---

## 0. Read this first

> **PHASE 1 HOLDS NO MONEY AND CANNOT REACH A NETWORK.**
>
> There is no component in this repository that can place an order at a real
> venue, sign an HTTP request to an exchange, or read a credential. The only
> broker is an in-process simulator (`src/broker/mock/`). The only socket in the
> system is a read-only HTTP listener bound to the loopback interface
> (`src/dashboard/server.js`).

The three terms used throughout this document are not interchangeable.

| Term | Meaning |
|------|---------|
| **PAPER** | Simulated execution against the in-process market simulator. A real process, a real SQLite file, a real order lifecycle — no real money, no external venue. Mode string `PAPER`. |
| **BACKTEST** | Replay of a generated historical price path through the same worker loop and the same pipeline, into a separate database. Mode string `BACKTEST`. |
| **LIVE** | Real capital at a real venue. **Not implemented.** No adapter, no credential path, no network call. Mode string `LIVE` is refused at startup. |

EGP 500 is a **configured paper-account ceiling**
(`account.startingCapitalEgp` and `risk.maxStartingCapitalEgp` in
`config/default.json`), not deployed capital. It is simulated. No real EGP
exists anywhere in this system on either side of a trade.

---

## 1. The threat model, and its limits

### 1.1 What collapses away

The classical financial-systems threat model is built around a component that
holds value and talks to a counterparty. Neither is present. Therefore the
following classes are not in scope for Phase 1, and no control in this repository
should be credited with addressing them:

- Credential theft, key exfiltration, key reuse, session hijack of an exchange account.
- Exchange API compromise, IP allow-listing failures, signature/replay attacks.
- Order manipulation or spoofing against a real order book.
- Counterparty default, settlement failure, clearing-house risk.
- Custody risk, private-key compromise, withdrawal fraud.
- Adverse selection and real market impact.

None of these are "mitigated" here. They are **absent**, because there is
nothing to steal, no counterparty, and no key.

### 1.2 What that does not protect against

Removing the money and the network removes the attack surface, but it also
removes most of the reasons to be paranoid. What is left is a local process
holding a local file on a local machine, and that has its own threats:

- **Any local user or process that can read `data/teos-paper.db`.** There is no
  authentication, no encryption, no row-level access control, and no file
  permissions are set by the code. The account is readable by every account on
  the host.
- **Any local process that can write it.** That includes editing the audit chains
  (section 9), latching or clearing an emergency stop at the table level, and
  rewriting balances.
- **A malicious or careless configuration edit.** `config/default.json` is not
  integrity-protected. `validateConfig` bounds some things tightly (section 6)
  and is silent about others.
- **A trusted-but-wrong operator.** The CLI can clear a latched stop
  unconditionally. There is no second-person control and no reason capture.
- **Resource exhaustion.** The audit tables are append-only with no retention
  policy and no size bound.
- **Misreading a simulated result as a real one.** This is the largest
  "decision" risk in the system, and no control in this repository defends
  against it. See section 12.

An honest threat model is more useful than a comprehensive one. The one-sentence
version: *the only realistic adversary is somebody who already has access to
this machine's filesystem or this machine's loopback interface, and the
controls below mostly raise the cost of a quiet edit rather than prevent it.*

---

## 2. Credential policy

**There are no credentials.** Not "credentials are handled carefully" — there
is no code path in Phase 1 that reads, stores, transports or needs a secret.

### 2.1 The startup refusal

`loadConfig()` calls `assertNoCredentialsPresent(env)` as its first statement
(`src/core/config.js:227`), before it resolves a config path, reads a file, or
opens a database. The check is in `src/core/env.js:83`.

It tests these six variables, taken verbatim from `FORBIDDEN_NON_EMPTY`
(`src/core/env.js:40`, which is `CREDENTIAL_VARS` at `src/core/env.js:19-25`
plus one):

| Variable | Namespace |
|----------|-----------|
| `TEOS_MARKET_DATA_API_KEY` | read-only market data |
| `TEOS_MARKET_DATA_API_SECRET` | read-only market data |
| `TEOS_TRADING_API_KEY` | trading (disabled in Phase 1) |
| `TEOS_TRADING_API_SECRET` | trading (disabled in Phase 1) |
| `TEOS_TRADING_API_PASSPHRASE` | trading (disabled in Phase 1) |
| `TEOS_DASHBOARD_TOKEN` | dashboard |

A variable counts as present when `typeof v === 'string' && v.trim() !== ''`
(`src/core/env.js:85-87`).

**"Absent" and "set but empty" are the same thing.** `TEOS_TRADING_API_KEY=`,
`TEOS_TRADING_API_KEY=""` and `TEOS_TRADING_API_KEY="   "` all pass the guard.
Only a non-blank value refuses to start. There is no third state, and the error
message never needs to distinguish one.

On a hit, the process throws `SecurityError` — error code **`SECURITY_ERROR`**
(`src/core/errors.js:45-48`) — with the message:

```
Phase 1 must run without credentials. The following credential variables are set:
<comma-separated list>. Unset them. Phase 1 never contacts an exchange.
```

`details.present` carries the same list. `src/cli.js:388-393` catches it, prints
`<command> failed: <message>`, and exits 1. The stack is withheld unless
`TEOS_DEBUG=1` is set, so an error page or terminal cannot pick up internal
detail by accident.

Two related refusals fire from the same place:

- `assertLiveTradingDisabled(env)` (`src/core/env.js:116`) throws
  `LiveTradingDisabledError` — code **`LIVE_TRADING_DISABLED`** — when
  `TEOS_LIVE_TRADING_ENABLED` is `true`, `1` or `yes` (case-insensitive).
- `readMode(env)` (`src/core/env.js:99`) throws `LiveTradingDisabledError` when
  `TEOS_MODE=LIVE`, and `ConfigError` for any other unrecognised mode.

### 2.2 No credentials in the repository

- `package.json` declares `"dependencies": {}` and `"devDependencies": {}`. There
  is nothing to audit transitively and no lockfile to disagree with it.
- `.gitignore:6-16` ignores `.env`, `.env.*` (with `!.env.example`), `*.pem`,
  `*.key`, `*.p12`, `*.pfx`, `secrets/`, `credentials/` and `*.secret`. The
  tracked `.env.example` has every credential entry deliberately empty.
- No source file contains a literal secret, a token, or a key.

### 2.3 No credentials in the database

`src/database/schema.sql` defines no column that holds a credential. The tables
are: runs, system_events, market_snapshots, agent_decisions, risk_decisions,
sentinel_decisions, orders, fills, positions, balances, pnl_events, equity_curve,
emergency_stops, control_flags, worker_heartbeats, restarts, backtest_runs,
backtest_trades, agent_state_log, schema_migrations.

### 2.4 No credentials in the logs

`src/core/logger.js` passes both the message and the structured fields through
`redact()` before writing (`logger.js:59-60`, `logger.js:79-80`), to the file at
`logs/teos.jsonl` and to stdout. `redact()` (`src/core/env.js:49-73`) applies:

- a `KEY|SECRET|TOKEN|PASSPHRASE|PASSWORD|CREDENTIAL`-shaped assignment
  (`apiKey: abc123` becomes `apiKey=***REDACTED***`),
- a provider-style token shape (`sk-`, `pk-`, `api_`, `key-`, `token-`, `secret-`
  followed by 12 or more alphanumerics),
- a complete PEM private-key block.

Objects are walked recursively, and any key matching `isSecretKey()` is replaced
wholesale. `Error` instances are coerced to `{name, message}` so a stack frame
cannot carry an unexpected field out.

`describeEnv()` (`src/core/env.js:146-153`) is the **only** function permitted to
surface environment state, and it returns an allow-list: eight safe variables
verbatim, plus the five credential variables as `SET(redacted)` or `null`. It is
served by the dashboard at `GET /api/env`.

### 2.5 Why "refuse to boot on an unused credential" is the policy

An unused credential in the environment is a latent leak with no upside: it
cannot make Phase 1 safer, because there is nothing to authenticate to, and it
can be captured by a crash dump, a child process, a `/proc`-equivalent read, or a
support bundle. So the loader treats its presence as a configuration error rather
than tolerating it.

---

## 3. `.env` handling

**No `.env` file is read by this code.** There is no dotenv loader, no
`process.loadEnvFile()`, and no parser anywhere in `src/` or `scripts/`
(verified by search across the repository). The only environment the system reads
is `process.env`, plus the explicit `env` object the tests inject.

Consequences, stated plainly:

- Creating a `.env` has **no effect**. Values in it are not seen by any command.
  This includes `TEOS_DASHBOARD_HOST` and `TEOS_DASHBOARD_PORT`, which
  `.env.example:24-25` lists as if they configured the dashboard. They do not:
  `loadConfig` reads only `TEOS_CONFIG`, `TEOS_DATA_DIR`, `TEOS_LOG_DIR` and
  `TEOS_MODE` (`src/core/config.js:230-251`), plus `TEOS_LOG_LEVEL` in
  `src/core/logger.js:96`. The dashboard's host and port come from
  `config/default.json` (`dashboard.host`, `dashboard.port`). Setting
  `TEOS_DASHBOARD_PORT` is a no-op in this build.
- `.env.example:5-6` says "Copy to `.env` for local use". That instruction
  describes an intent, not behaviour. Treat `.env.example` as a catalogue of
  variable names, not as an operational step.
- `.gitignore:7-9` does cover it: `.env` and `.env.*` are ignored, with
  `!.env.example` so the template stays tracked. The ignore is correct even
  though nothing reads the file — it prevents an operator from committing a
  secret they added out of habit.
- `TEOS_DASHBOARD_TOKEN` is the one `.env` variable with teeth: it is in
  `FORBIDDEN_NON_EMPTY`, so a populated value refuses to boot (section 2.1).

**Why no `.env` is needed:** there is nothing to put in one. The configuration
that matters — capital ceiling, risk limits, Sentinel thresholds, instruments,
dashboard bind address — lives in `config/default.json`, which is validated at
load. The only things Phase 1 accepts from the environment are the mode, the data
and log directories, the config path, the log level, and the guards that refuse
live trading and credentials.

---

## 4. Secret separation

There is no secret to separate, so the separation is declared rather than
implemented. `src/core/env.js:1-15` states the invariant and backs it with three
namespaces that are never merged:

| Accessor | Namespace | Phase 1 behaviour |
|----------|-----------|-------------------|
| `loadMarketDataCredentials()` (`env.js:127`) | read-only market data | Returns `{provider: 'local-simulator', readOnly: true, apiKey: null, apiSecret: null}`. Throws `SecurityError` if either variable is non-blank. |
| `loadTradingCredentials()` (`env.js:140`) | trading | Throws `LiveTradingDisabledError` unconditionally. There is no branch. |
| `describeEnv()` (`env.js:146`) | neither | Allow-listed, redacted, the only thing allowed to leave the process. |

Neither credential accessor is called from any Phase 1 execution path. They are
API surface, not a dependency.

If this system ever held a real credential, the separation would have to be
structural rather than a naming convention, because a process that can read the
whole environment can read every namespace in it. The minimum would be: the
credential never enters this process at all; a separate, minimal, non-trading
process holds it and exposes only a narrow signed capability; the trading process
has no filesystem access to the credential and no environment variable for it;
and the credential is rotated on a schedule and on every operator change. None of
that exists here and none of it is needed here.

---

## 5. Loopback binding and the refusal of non-loopback

### 5.1 The allow-list as the code defines it

`isLoopbackHost(host)` (`src/dashboard/server.js:45-51`) is the actual gate. It
returns true for:

- `::1`, `[::1]`, `0:0:0:0:0:0:0:1`
- any address matching `/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` — the whole of
  `127.0.0.0/8`, not only `127.0.0.1`

It returns false for `0.0.0.0` explicitly, with the reason in the source comment:
it means "every interface", which is the mistake the check exists to catch.

The module also exports a named constant `LOOPBACK_HOSTS`
(`server.js:43`) = `['127.0.0.1', '::1', 'localhost', '[::1]']`. **`isLoopbackHost`
does not use it**, and it is wider in one direction (all of `127/8`) and narrower
in another (it does not accept the string `localhost`). Treat `isLoopbackHost` as
the policy; the constant is documentation.

### 5.2 Two checks, in this order

1. **Before `listen()`.** The constructor refuses to construct at all
   (`server.js:83-93`). It checks `config.dashboard.allowNonLoopbackBind` first,
   then the resolved host. An operator who tries anything else sees:

   ```
   Refusing to bind the dashboard to "0.0.0.0". Loopback only in Phase 1; set dashboard.host to 127.0.0.1.
   ```

   and, if they got that far by editing the JSON to re-enable the flag:

   ```
   Refusing to start: dashboard.allowNonLoopbackBind is not false.
   ```

   Both messages are thrown before any socket exists. `loadConfig` also refuses
   the flag earlier still, at `src/core/config.js:183-185`:
   `dashboard.allowNonLoopbackBind must be false in Phase 1.`

2. **After `listen()`.** The address the OS actually bound is re-read and
   re-tested (`server.js:136-143`). If it is not loopback the server closes
   immediately and throws:

   ```
   Refusing to serve: the socket bound to non-loopback address <addr>.
   ```

   **This second check exists because the first one is not sufficient.** A host
   string that passes the allow-list can still resolve to something else — a
   `localhost` entry in a hosts file pointing at a LAN address, a name service
   that answers differently, or a future refactor that binds through an options
   object constructed elsewhere. The pre-check validates the *request*; the
   post-check validates the *result*. The exposure between the two is one bind
   syscall with no listener accepted yet, and the post-check closes it.

### 5.3 The flag that must remain `false`

`dashboard.allowNonLoopbackBind` is `false` in `config/default.json:103`. It is
validated in two places (`src/core/config.js:183-185` and
`src/dashboard/server.js:83-85`), so setting it to `true` stops the process
whether or not the dashboard is ever started. Treat it as untouchable: there is
no Phase 1 configuration in which it should be anything else.

### 5.4 Other transport limits on the same listener

- `headersTimeout` 10 s, `requestTimeout` 15 s (`server.js:124-125`), so a slow
  client cannot hold a socket open indefinitely.
- URLs longer than 2048 characters are refused with 414 before routing
  (`server.js:64`, `server.js:161-163`).

---

## 6. Live trading is disabled

Ordered by how early each layer refuses. Each one is independent; defeating any
one of them does not reach the next.

### 6.1 The environment refuses, before any file is read

`loadConfig` (`src/core/config.js:226-228`) calls, in order:

1. `assertNoCredentialsPresent(env)` — `SECURITY_ERROR` if a credential variable
   is populated (section 2.1).
2. `assertLiveTradingDisabled(env)` — `LIVE_TRADING_DISABLED` if
   `TEOS_LIVE_TRADING_ENABLED` is true-ish.
3. `readMode(env)` — `LIVE_TRADING_DISABLED` for `TEOS_MODE=LIVE`, `CONFIG_ERROR`
   for anything that is not `PAPER` or `BACKTEST`.

These fire before the config path is even resolved, so there is no filesystem
state in which the process has half-started.

### 6.2 The configuration refuses

`validateConfig` accepts `mode` only from `MODES = ['BACKTEST', 'PAPER']`
(`src/core/config.js:24`, `:48`). A config file whose `mode` is `"LIVE"` cannot
be loaded. `risk.maxStartingCapitalEgp` may never exceed 500
(`config.js:58-61`), `account.startingCapitalEgp` is capped at 500
(`config.js:51`), and `account.allowNegativeCash` must be exactly `false`
(`config.js:53-55`).

### 6.3 The schema refuses

Every table that belongs to an account carries
`mode TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER'))`, and
`backtest_runs` carries the tighter `CHECK (mode = 'BACKTEST')`. There is no
`LIVE` value any INSERT can satisfy. This holds even if every guard above were
bypassed, because the constraint is in the database, not the application.

### 6.4 The Sentinel refuses

`MODE_GUARD` is the first rule in `SENTINEL_RULES`
(`src/execution/sentinel.js:41-52`) and returns `BLOCK` for `LIVE` or for any
unrecognised mode. The rule is evaluated for every order
(`sentinel.js:333-345`) and the highest-ranked verdict wins, so no other rule can
outvote it. The test suite asserts that no reordering can move it out of
position.

### 6.5 There is no live execution adapter

`ExecutionAdapter` is the only caller of `broker.placeOrder()`
(`src/execution/execution-adapter.js:175`), and the only broker implementation
is `MockBroker` (`src/broker/mock/mock-broker.js`), which runs in-process against
a seeded RNG. There is no HTTP client, no WebSocket, no `fetch`, and no exchange
SDK in the dependency list — there is no dependency list.

At the adapter, orders are constructed with `leverageRequested: false`,
`borrowRequested: false`, `marginRequested: false`, `shortRequested: false`,
`instrumentType: 'SPOT'` hard-coded (`execution-adapter.js:86-90`). Only Sentinel
verdicts `ALLOW` or `WARN` are submittable (`execution-adapter.js:24`, `:53-58`).
`MockBroker.placeOrder` independently rejects any order whose leverage or borrow
flag is not literally `false` (`mock-broker.js:463-467`).

### 6.6 There is no credential to authenticate with

Even if an adapter were written, `loadTradingCredentials()` throws
`LiveTradingDisabledError` unconditionally (`env.js:140-144`), and there is no
code path that obtains a key, a signature, or a session from anywhere.

### 6.7 The statement to make plainly

A reader looking for a way to enable live trading will not find one. It is not a
setting, a flag, a config key, a mode string, or a build variant. Enabling it
would require writing new code — a network client, a credential path, a schema
change and an operational approval process — and every guard in 6.1 to 6.6 is
positioned to make that a deliberate act rather than an accident.

---

## 7. The read-only surface

The dashboard is the only network surface in the system, and it is read-only in
two independent ways.

### 7.1 The database is opened read-only

`DashboardServer` opens the database with `{ readonly: true }`
(`server.js:98`), which becomes `new DatabaseSync(path, { readOnly: true })`
(`src/database/db.js:53`). SQLite itself then rejects a write on that
connection. This is a second line of defence behind the routing, deliberately:
neither a routing bug nor a config change can turn the dashboard into a write
path, because the storage layer would refuse regardless.

`src/dashboard/api.js` is pure with respect to storage — it calls only query
methods on `Repos` and never a mutating one. To write, code in that file would
have to call an `INSERT`/`UPDATE` repository method, and no such call exists.

### 7.2 Only GET and HEAD are routed

`server.js:167-174`. Every other method is refused before routing with `405` and
`Allow: GET, HEAD`. There is no POST handler to enable, and the error body points
the operator at the CLI:

```json
{
  "error": "The dashboard is read-only.",
  "detail": "This server exposes no write operation. Control the agent from the CLI: `node src/cli.js hold`, `kill-switch`, `reset-stop`."
}
```

Verified against a running server: `POST /api/snapshot` returns 405.

### 7.3 Static assets are an allow-list, not a filter

`STATIC_FILES` (`server.js:57-62`) is a frozen map of four routes to **three
filenames**: `index.html` (for `/` and `/index.html`), `app.js`, `style.css`.
Anything not in the map is a 404. No request-supplied string is ever joined to a
filesystem path, so `../../.env` is not a request that can be made — it is a
string that fails to match. A `startsWith(PUBLIC_DIR)` re-check
(`server.js:239`) is belt-and-braces in case `PUBLIC_DIR` is ever repointed.

Verified against a running server: `GET /../../.env` returns 404.

### 7.4 Response hygiene

Every JSON response carries `cache-control: no-store`,
`x-content-type-options: nosniff`, `referrer-policy: no-referrer` and a
`content-security-policy` of
`default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:`
(`server.js:219-231`). Static responses add `form-action 'none'; base-uri 'none'`
(`server.js:253`). The unhandled-error path logs the message server-side and
returns `{ error: 'internal error', detail: redact(err.message) }` — never a
stack (`server.js:196-201`).

Every payload is additionally passed through `scrub()` (that is, `redact()`)
before it leaves the process (`src/dashboard/api.js:91-93`).

### 7.5 Endpoints

| Route | Returns |
|-------|---------|
| `GET /` , `/index.html`, `/app.js`, `/style.css` | the three local files |
| `GET /healthz` | status, mode, `readOnly: true`, `loopbackOnly: true`, `auth`, whether a stop is engaged, equity, the four audit stream names |
| `GET /api/snapshot` | the whole envelope (account, agent, risk, audit) |
| `GET /api/section/{account\|agent\|risk\|audit}` | one section; anything else is 404 and lists the real names |
| `GET /api/env` | `describeEnv()` — the allow-listed, redacted view |
| `GET /api/audit/chains` | verification result for all four chains |

---

## 8. No authentication, and why that is acceptable here

There is no authentication on the dashboard. Not a weak scheme, not a default
password, not a token: none. `/healthz` says so itself —
`"auth": "none (loopback-only by design; see SECURITY.md)"` (`server.js:212`).

That is acceptable **only** because of two properties that are enforced rather
than promised:

1. The listener is loopback-only (section 5), so it is not reachable from
   another host.
2. The surface is read-only (section 7), so the worst case is disclosure of
   simulated account state, never a change to it.

Both are structural. Remove either one and the design is wrong immediately.

What "no auth" actually means on a loopback listener, stated without softening:
**every process and every user account on that machine can read the account.**
A loopback bind is a reachability restriction, not an identity check. It does not
distinguish the operator from a background service, a cron job, a container
process, or another user on a shared host.

### 8.1 What would have to change if it were ever exposed

If this listener were bound to a routable address, or tunnelled (SSH `-L` is
fine; `ngrok`, a reverse proxy, a container port publish and a cloudflared
tunnel are not), the current design becomes wrong. The minimum set of changes:

- **Authentication on every route**, before any handler runs, with a credential
  that is not an environment variable this process can be handed casually.
- **Authorisation**, not just authentication: which operations may be read, and
  whether a write-capable control surface is introduced at all.
- **Transport security**: TLS termination, or a tunnel that provides it.
- **A `Host` header allow-list** (see section 12, risk 2 — this is missing today).
- **An audit trail of who read what**, which the current read-only design has no
  reason to keep.
- **A decision about CORS**: today the absence of CORS headers is a mitigation;
  with authentication it becomes a policy that must be stated.

Until all of that exists, "loopback only" is the whole security model for the
dashboard, and it should be treated as a hard constraint rather than a default.

---

## 9. Audit integrity

### 9.1 What is chained

Four streams, declared in `src/database/audit-chain.js:27-32` and consumed by
`verify`, the CLI, the dashboard and `scripts/verify.js`:

| Stream | Table | Hashed columns |
|--------|-------|----------------|
| `decision` | `agent_decisions` | 23 |
| `risk` | `risk_decisions` | 16 |
| `sentinel` | `sentinel_decisions` | 15 |
| `order` | `orders` | 19 |

A chain is scoped to one `(mode, stream)`. PAPER and BACKTEST never share a
chain, and a BACKTEST chain is further scoped per run by convention at the
repository layer.

### 9.2 How it is computed

`seal()` (`audit-chain.js:121-130`) projects the record through
`STREAM_COLUMNS[stream]` (`audit-chain.js:54-74`) — in that declared order,
missing columns are a hard error — adds `prev_hash`, and computes:

```
record_hash = sha256(`${stream}|${mode}|${prev_hash ?? 'GENESIS'}|${canonicalJson(body)}`)
```

`canonicalJson` (`audit-chain.js:19-25`) is deterministic: keys sorted, no
whitespace, `undefined` members dropped, arrays order-preserved. The same record
therefore hashes identically twice — which is the property the whole scheme rests
on, and which the suite asserts directly.

`verify()` (`audit-chain.js:140-167`) walks the rows in `rowid` order, re-projects
each one through the same column list, and recomputes the hash. It reports the
first of either failure:

- `prev_hash mismatch (record removed or reordered)` — a record was deleted or
  moved.
- `record_hash mismatch (record modified)` — a record was edited in place.

Both the location (`brokenAt`) and the count of records checked before the break
are returned, so the operator is told *where*, not just that something is wrong.

### 9.3 Which columns are excluded, and why

Only the `order` stream has mutable columns. Its lifecycle — `status`,
`filled_quantity`, `avg_fill_price`, `updated_at`, `terminal_at`,
`rejection_reason` — is deliberately **excluded** from the hash
(`audit-chain.js:69-73`). Hashing a column that legitimately changes would make
`verify()` report tampering on every normal fill, and a chain that always reports
"broken" is worse than no chain, because it trains the operator to ignore it.

Those columns are protected three other ways instead:

- The order state machine rejects illegal transitions.
- `status_at_submit` is immutable **and hashed**, so what the order was submitted
  as can still be proven after the fact.
- `Repos.auditOrderFills` reconciles `filled_quantity` against the append-only
  `fills` table, and that reconciliation is surfaced on the dashboard and
  re-checked by `scripts/verify.js`.

So the chain proves the **intent** — which decision, which side, symbol, quantity
and price was asked for — and the reconciliation proves the **outcome**. Neither
proves the other alone.

Worth stating plainly, because it is easy to assume otherwise: **the `fills`,
`balances`, `equity_curve`, `pnl_events`, `positions`, `system_events`,
`emergency_stops` and `control_flags` tables are not in any chain.** A hash chain
that covers only four streams does not cover the emergency stop table, and
therefore does not cover clearing one.

### 9.4 Tamper-evident, not tamper-proof

This is the honest limit, and it should be quoted wherever the chain is
mentioned:

- **Anyone with write access to the database file can truncate the tail of a
  chain.** `verify()` walks the rows that exist. Delete the last N records and
  the remaining chain still verifies, because nothing outside the file records
  that those rows were ever there.
- **An attacker who can rewrite every record can rebuild a chain that verifies.**
  The chain is a hash chain, not a signature chain. There is no key, no
  signature, and no external anchor: nothing outside the database fixes a point
  in time. Recomputing the whole chain after a rewrite is straightforward.
- **A quiet edit in the middle is caught.** This is what the scheme is for, and
  it works: the record's own hash no longer matches, or the successor's
  `prev_hash` no longer points at it, and the break is located.
- **Reconstruction is expensive and visible.** Rewriting a chain means reading
  every record, recomputing 19 to 23 hashes per record, and writing the file
  back — and the result is a different set of hashes from any copy of the chain
  that was exported earlier (a `verify` report, a `/api/audit/chains` response,
  a database backup). The cost is the deterrent, not the impossibility.

`scripts/verify.js` is the independent checker: it re-derives quantities from raw
rows rather than asking the agent whether it agrees with itself, and runs ten
checks (equity invariant, cash reconstruction from the fill log, order/fill
agreement, position reconciliation, orphan fills, all four chains, duplicate
`client_order_id`, the capital and negative-cash invariants, ERROR/FATAL
reporting, and full decision→risk→Sentinel→order linkage).

---

## 10. The emergency stop, from a security angle

### 10.1 Durable, not in memory

The emergency stop is a row in `emergency_stops` (`src/database/schema.sql:281`),
not a process variable. It therefore survives a crash, a `SIGKILL`, a power
loss and a restart. A resumed PAPER run keeps its `run_id` and the stop is still
there on the next tick.

Scoping is decided in exactly one place, `Repos.sessionStop()`
(`repositories/index.js:653-655`): in PAPER, a stop is scoped to the mode; in
BACKTEST, to the run. A stop latched by one backtest cannot halt the next one,
and a stop latched by a PAPER run applies to the whole PAPER account.

### 10.2 What engages it

**Automatically** — any risk rule that returns BLOCK with `latchesStop: true`
latches a stop inside the same transaction as the audit record
(`risk-engine.js:327-337`), using the rule id as the trigger. Those rules are
`NO_LEVERAGE`, `AGENT_STATE` (undefined state), `CONNECTION`, `DATA_FRESHNESS`,
`PRICE_SANITY`, `MAX_CAPITAL`, `NO_NEGATIVE_CASH`, `DAILY_LOSS`, `EXPOSURE`,
`ORDER_RATE`, `ORDER_VALID` and `STOP_CONDITION`, plus any rule that throws
(rules fail closed and a throwing rule latches its own id).

Also automatic, outside the risk engine:

| Trigger | Where | Severity |
|---------|-------|----------|
| `STOP_EXIT_BLOCKED` | `worker/worker.js:435-439` — a breached stop that could not be executed | CATASTROPHIC |
| `UNHANDLED_ERROR` | `worker/worker.js:508-511` — a throw in the tick loop | CATASTROPHIC |
| `STRATEGY_ERROR` | `agent/engine.js:257-261` — a strategy threw | CATASTROPHIC |

**By an operator:** `node src/cli.js kill-switch`, which latches
`OPERATOR_KILL_SWITCH` with severity `CRITICAL` and scope `NEW_ORDERS`
(`cli.js:282-303`).

### 10.3 It is latching, and it is wider than its name

A stop is written with `active = 1` and stays there. Nothing in the agent, the
worker, or a restart clears it. Only `clearStop()` does, and only an operator
calls that.

**The stop blocks risk-reducing exits as well as new entries.** This is
deliberate, not an oversight, and the test suite asserts it ("the emergency stop
blocks every order, including a risk-reducing exit"). The reason is structural:
the `KILL_SWITCH` risk rule (`rules/index.js:61-71`) and the Sentinel
`KILL_SWITCH` rule (`sentinel.js:54-62`) have no reduce-only exemption, and every
order — including a stop-loss exit — goes through the same firewall. The stop
row's `scope` column says `NEW_ORDERS`, which understates the effect. Read the
effect, not the label.

**Operational consequence:** with a stop engaged, the agent cannot exit an open
position. If a stop is breached during that window, the worker attempts the exit,
the firewall blocks it, and the worker latches a further `STOP_EXIT_BLOCKED`
CATASTROPHIC stop plus a `FATAL` event (`worker/worker.js:428-440`). The
position remains open and unmanaged until an operator acts. Plan for that before
you engage one.

### 10.4 Clearing is an explicit, recorded operator action

`node src/cli.js reset-stop` calls `Repos.clearStop(stop.stop_id, 'cli-operator', systemClock)`
(`cli.js:305-324`, `repositories/index.js:617-623`):

- the row is **not deleted** — `active` goes to 0 and `cleared_at` / `cleared_by`
  are written, so the stop and its clearance remain on the record;
- if other stops are still active, the command reports how many;
- a `WARN` event is logged with the stop id and trigger;
- the CLI prints `NOTE: clearing a stop does not resolve its cause.`

Nothing checks the cause. That is deliberate — the operator is the one who knows
— and it is also the most obvious abuse path in the system (section 12, risk 3).

### 10.5 The trading hold, and how it differs

| | Emergency stop | Trading hold |
|---|---|---|
| Storage | `emergency_stops` row, `active` flag | `control_flags` row, key `TRADING_HOLD` |
| Set by | risk rules, the worker, the agent, or `kill-switch` | `node src/cli.js hold` only — never automatically |
| Severity | `CRITICAL` or `CATASTROPHIC` | none; it is a control flag, not a stop |
| Enforcement | risk `KILL_SWITCH` + Sentinel `KILL_SWITCH` + a pre-submit check in the adapter | Sentinel `MANUAL_HOLD` (`sentinel.js:94-111`) |
| Blocks | every order, including risk-reducing exits | every order the Sentinel sees, including risk-reducing exits |
| Agent | stops evaluating entirely (`AGENT_STATE` / `EMERGENCY_STOP_ACTIVE` in `agent/engine.js:200-210`) | keeps running, keeps writing heartbeats and decisions |
| Cleared by | `reset-stop`, recorded with actor and timestamp | `resume` |
| Restart | survives | survives (it is a row) |

Both are durable and both are per-mode. The practical difference is intent: a
stop means something went wrong and needs diagnosing; a hold means an operator
wants the agent to keep observing but not open anything.

**A documentation discrepancy worth knowing about:** the CLI's own output and
help text say the hold "blocks entries, allows exits"
(`cli.js:81`, `cli.js:337`), and the dashboard repeats the claim
(`dashboard/api.js:287`). The code does not do that. The only enforcement point is
the Sentinel's `MANUAL_HOLD` rule, which returns `BLOCK` unconditionally, with no
reduce-only exemption, and the highest-ranked verdict wins. The test suite
confirms it: "a manual hold blocks every order the Sentinel sees". Trust the
code and the tests, not the message.

---

## 11. Assumptions about attacks and failure

A document that only lists what is defended invites over-trust. These are the
assumptions the design rests on. If any of them is false, parts of this document
stop being true.

1. **The machine is not already compromised.** No control here defends against a
   root or Administrator-level attacker, a malicious kernel driver, or a
   rootkit. The process runs with the privileges of whoever started it.
2. **The operator running the CLI is trusted.** They can `reset-stop`
   unconditionally, `resume` a hold, start the worker with `--strategy`, point
   `TEOS_CONFIG` at a different file, and open `data/*.db` in any SQLite client
   to edit any row — including the audit chains. There is no second-person
   control anywhere.
3. **The repository is trusted.** All of the security boundary is the code in
   this tree. There are no dependencies, so there is no supply chain to poison —
   but that also means the whole boundary rests on code that gets exactly the
   review it gets.
4. **The clock is roughly right.** Three controls are wall-clock comparisons and
   silently depend on it: market-data staleness (`risk.maxDataStalenessMs`,
   15000 ms), heartbeat staleness (`worker.heartbeatStaleAfterMs`, 30000 ms) and
   lock staleness (`worker.lockStaleAfterMs`, 30000 ms). A clock that jumps
   forward can make a healthy worker look dead and a dead lock look reclaimable; a
   clock that jumps backward can pin a stale lock forever. None of these are
   detected.
5. **A determined local user can do anything, including rewriting the audit
   trail.** This is the direct consequence of assumptions 1 and 2 and of the fact
   that the database is an unencrypted file. The chain will not stop them. It
   will make a *quiet* rewrite expensive and, if they make a mistake, locatable.
6. **`data/` and `logs/` permissions are whatever the filesystem gives them.**
   The code creates the directories (`mkdirSync`, recursive) and never restricts
   them. On a multi-user host, assume they are world-readable.
7. **`node:sqlite` enforces what it claims.** The read-only guarantee of the
   dashboard is the binding's, not the application's; it is only as good as the
   runtime.
8. **No authentication means no identity.** The dashboard cannot tell the
   operator from a stray process. Confidentiality of simulated account state is
   a property of the network namespace, not of the code.

---

## 12. Residual risks, most damaging first

1. **Local read/write access to `data/*.db` and `logs/teos.jsonl`.** Any user or
   process on the host can read the account and rewrite the history, and the
   audit chain does not stop them. This is the only realistic adversary in the
   entire threat model, and it is undefended at the data layer.
2. **No authentication, and no `Host` header validation, on the dashboard.** The
   request handler (`server.js:156-195`) never inspects `Host`. A page in a
   browser on the same machine can therefore attempt a DNS-rebinding attack
   against `127.0.0.1:8787` and read the JSON, because after rebinding the
   browser treats the origin as same-origin. No writes are exposed, so the damage
   is disclosure of simulated account state — but it is disclosure, and it is
   unmitigated.
3. **A trusted operator can clear a stop for any reason, and clearing does not
   check the cause.** `clearStop` is unconditional. The most likely way this
   system gets hurt is not an attack at all: someone clears the stop, the cause is
   still present, and the agent re-latches within a tick, having briefly resumed
   trading on a known-bad state.
4. **The emergency stop blocks risk-reducing exits.** Engaging one leaves open
   positions unmanaged by the agent, and a breach during that window latches a
   further CATASTROPHIC stop. The `scope` value of `NEW_ORDERS` understates this.
5. **Configuration is a security surface and is not integrity-protected.**
   `validateConfig` bounds the capital ceiling at EGP 500, refuses
   `allowNegativeCash: true`, refuses a weakened Sentinel boolean, and refuses a
   Sentinel threshold below the risk cap. It does **not** bound risk limits
   against an absolute policy — a hostile edit that raises
   `maxPortfolioExposureEgp` or lowers `maxLossPerTradePct` within the
   validator's numeric ranges is accepted silently.
6. **The hash chain has no external anchor.** Tail truncation verifies; a full
   rewrite can be made to verify. Stops, holds, balances, fills and events are
   outside the chain entirely. Its value is detection of a quiet middle edit and
   the cost of reconstruction — not tamper-proofing.
7. **Unbounded growth.** The audit tables are append-only with no retention
   policy and no size cap. On a 24/7 worker the database will eventually fill the
   disk. The logger swallows write errors (`logger.js:73-75`), so a full disk
   loses logs silently rather than loudly.
8. **`TEOS_DEBUG=1` prints stack traces to stderr** (`cli.js:391`). That is
   correct for local debugging and a small disclosure risk if the terminal is
   captured by anything.
9. **Readiness of the simulated result to be over-read.** A backtest report or a
   paper equity curve is a description of one synthetic price path. Nothing in
   this system measures future behaviour, and the reports say so. The risk is not
   in the code; it is in what a reader does with the output.
