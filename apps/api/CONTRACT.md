# API contract for the app

The parts of the Bulwark API the app relies on. Field names here are stable. A change to one is versioned and announced before it ships, never made silently.

**Base and auth:**
- **Base:** the app calls `/api/bw/...` (its server proxy), which forwards to the API.
- **Auth:** every `/v1/*` route needs `Authorization: Bearer <session>` from `POST /auth/verify` (SIWE). Without it the answer is `401`.

## Signatures (for any wallet library)

**What the API checks:** the same three signatures, however the wallet is connected (injected, WalletConnect, hardware):
- **Sign-in:** an EIP-4361 (SIWE) message. The domain must be `bulwark.0xo.in`. The message's chain id can be any chain.
- **Policies:** EIP-712 `BulwarkPolicy { account: address, network: string, version: uint256, policyHash: bytes32 }`, in the domain `{ name: 'Bulwark', version: '1', chainId }`.
- **Commands:** EIP-712 `BulwarkCommand { account: address, network: string, command: string, minutes: uint256, issuedAt: uint256 }`, in the same domain.
- **`network`** is `'testnet'` or `'mainnet'`, the API's own network (8 Oct 2026, security review F5). A signature for the other network, or without `network`, answers `401`. The types are `POLICY_CONFIRMATION_TYPES` and `COMMAND_TYPES` in `@bulwarkxyz/guard-core`.
- **Each signed command is accepted once.** Sending the same signature again answers `409 { error }`: sign it again.
- **Sessions name their network** (JWT audience `bulwark:<network>`). A session from before 8 Oct 2026, or from the other network, answers `401`: sign in again.

**For policies and commands:**
- Send the `chainId` the wallet actually signed with; any chain works.
- A mismatch between the signed chain id and the one sent answers `401`.

**Encodings accepted:**
- `v` as 27/28 or 0/1;
- EIP-2098 compact (64-byte) signatures.

All three are tested in `test/signatures.test.ts`.

**Smart-contract wallets are not supported.**
- A Hyperliquid account signs with an ordinary key (EOA): approving an agent, deposits and orders are all ECDSA signatures by the account itself. So a Safe, passkey or other smart wallet can't hold a Hyperliquid account directly.
- **What the API answers instead of "bad signature":** `400 { code: 'contract_wallet', error }` for:
  - an ERC-6492 signature;
  - a signature that isn't 64 or 65 bytes;
  - a failed signature from an address with contract code on Arbitrum.
- **EIP-7702 delegated EOAs** still sign with their key and are accepted.
- **Show `error` as it is.** It says to connect the wallet that holds the Hyperliquid account.

## Markets

### `GET /markets/activity?coins=xyz:CL,xyz:GOLD,…`: which markets have recent data on this network

**Public:** no session needed, because the trade screen works before sign-in. Call it through the proxy: `/api/bw/markets/activity?coins=…`.

**Request:**
- `coins`: 1 to 20 xyz markets, comma-separated, in the form `xyz:TICKER`.
- The app sends its own curated list, so the list stays in one place.
- Anything else answers `400`.

**Use it for two things:**
- **The default market:** open the trade screen on the first market in the curated order whose `hasRecentData` is true.
- **The selector order:** sort by `hasRecentData`, then `trades24h`, then `dayNtlVlm`.

```json
{
  "network": "testnet",
  "checkedAt": 1791200000000,
  "markets": [
    { "coin": "xyz:GOLD", "listed": true, "delisted": false, "hasRecentData": true, "lastTradeAt": 1791190000000, "trades24h": 31, "candles24h": 24, "dayNtlVlm": 2348.5 }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `network` | `'mainnet' \| 'testnet'` | The network the API reads |
| `checkedAt` | ms | When this answer was made |
| `markets[]` | | In the order requested |
| `listed` | boolean | The market exists on this network's xyz dex |
| `delisted` | boolean | Listed but delisted. On testnet on 5 Oct 2026: BRENTOIL and SP500 |
| `hasRecentData` | boolean | Traded at least once in the last 24 h, and not delisted |
| `lastTradeAt` | ms \| null | Start of the latest hourly candle with a trade, looking back 7 days |
| `trades24h` | number | Trades in the last 24 h, the sum of the hourly candles' trade counts |
| `candles24h` | number | Hourly candles in the last 24 h: what a 1 h chart would draw |
| `dayNtlVlm` | number | Hyperliquid's 24 h notional volume in USD |

**Where the data comes from:**
- Hyperliquid's public info endpoint:
  - `metaAndAssetCtxs` for the xyz dex;
  - one hourly `candleSnapshot` per market.
- Each answer is cached for 2 minutes, so the API makes at most one round of requests per 2 minutes, whatever the number of visitors.
- If Hyperliquid is unreachable, the answer is `503`. The app should then keep its static default.

**On testnet on 5 Oct 2026, only three markets had candles:**
- GOLD and NVDA, traded within the last few hours;
- XYZ100, last traded 28 h earlier.

CL, the old default, had none.

## Guard key

### `GET /v1/me`: who the user is and where their key lives

| Field | Type | Meaning |
|---|---|---|
| `keyCustody` | `'kms' \| 'sealed'` | Where **this user's** key lives. Before they have a key, it is where a new key would be created |
| `newKeyCustody` | `'kms' \| 'sealed'` | Where new keys are created now (`kms`) |
| `keyStatus` | `'none' \| 'creating' \| 'ready' \| 'wiped'` | |
| `agent` | `{ address, approved, validUntil } \| null` | The active guard key, and whether Hyperliquid lists it as approved |
| `pendingAgent` | `{ address } \| null` | A replacement waiting for the user's approval on Hyperliquid |
| `policy.needsRepeatChoice` | `string[]` | Rule ids that still need the once/every-time choice. Empty when none |
| `policy.needsResign` | boolean | The whole policy must be signed again (it was signed before signatures named the network, or for another network). The guard does not act on it meanwhile; its status is `paused` with reason `resign_required`. Per policy, not per rule. To re-sign, send the same rules as version current + 1 to `POST /v1/policy` |
| `regionNow` | `'allowed' \| 'alerts_only' \| 'blocked' \| null` | The strictest of the user's declarations and the latest country their connection came from; what the guard uses |

### `POST /v1/onboarding/agent`: create the guard key

| Answer | When |
|---|---|
| `200 { agentAddress }` | A KMS key was created, or the user already has a key |
| `202 { status: 'creating' }` | Encrypted custody (fallback): the signing service creates it. Poll `/v1/me` |
| `409` | The region step isn't done |
| `403` | The guard is off in the user's region |
| `429 { error, limit, retryAfter }` | A cost cap: `limit` is `keys_account` (3 per account per 24 h) or `keys_all` (50 across all accounts per 24 h). `retryAfter` is in seconds, also sent as the `Retry-After` header. Show `error` |
| `503` | Keys are unavailable; retry later |

Two requests at once create one key.

The user then approves `agentAddress` on Hyperliquid as the named agent `bulwark-guard`.

### `POST /v1/guard-key/rotate`: replace the guard key (final)

**Answer, one shape for both custodies:**
- `200 { status: 'pending', pendingAgent: { address } }` for a KMS key, created at once;
- `202 { status: 'creating', pendingAgent: null }` for an encrypted key; poll `/v1/me` for `pendingAgent`.

Asking again while a replacement is pending returns the same pending key. Errors: `409` (no key yet), `503`.

**What happens, in order:**
1. **Until the user approves:** the old key keeps signing. Nothing changes for the guard.
2. **The user approves** `pendingAgent.address` on Hyperliquid under the same name, `bulwark-guard`. Hyperliquid then replaces the old agent with the new one.
3. **The worker promotes the new key.** It checks every 30 s, and at once if the exchange rejects the old key. The audit log records `key: Guard key replaced…`.
4. **The old key is retired:**
   - a KMS key is disabled and scheduled for deletion by the API's provisioner role (audit: `AWS KMS key for 0x… disabled; AWS deletes it after 7 days`);
   - an encrypted key is destroyed.

**Resting guard orders during a replace:** nothing is cancelled. The backstops belong to the account, not the key. After the switch the guard re-prices, cancels and places them with the new key. There is no gap: the old key signs until Hyperliquid has the new one.

### `POST /v1/commands` with `command: 'wipe'`: wipe the guard key (final)

**Request:** `{ command: 'wipe', issuedAt: <ms>, signature, chainId }`. The signature is EIP-712 `BulwarkCommand { account, command: 'wipe', minutes: 0, issuedAt }` in the domain `{ name: 'Bulwark', version: '1', chainId }`. It must reach the API within 60 s of `issuedAt`.

**Answer:** `200 { id, command: 'wipe' }`. Errors: `400` (expired or unknown command), `401` (bad signature).

**What happens, in order:**
1. **At once:** the kill switch is on (`/v1/guard/status` shows `stopped`). The guard sends nothing new.
2. **Within about 2 s:** the worker cancels the guard's own resting orders while the key can still sign (audit: `command: Cancelled N guard order(s)`). The user's own orders are never touched.
3. **The key is wiped:**
   - the worker stops signing with it (audit: `key: Guard key wiped (…)`);
   - for KMS, the API then disables the key and schedules its deletion within about 15 s (audit: `key: AWS KMS key … disabled; AWS deletes it after 7 days`);
   - an encrypted key is destroyed.
4. **Afterwards:**
   - `/v1/me` shows `keyStatus: 'wiped'` and `agent: null`.
   - Hyperliquid still lists the old approval until it expires or another key is approved under the same name.
   - To guard again, the user creates a new key (`POST /v1/onboarding/agent`), approves it, and signs `resume`.

**Resting guard orders during a wipe:** they are cancelled in step 2. If cancelling fails, for example because the exchange is unreachable, the audit entry says so. Those orders stay on Hyperliquid as reduce-only stops until the user cancels them in their own trading view.

### `GET /v1/commands/:id`: a command's result

Returns `{ id, command, minutes, issuedAt, createdAt, doneAt, result }` for one of the user's own commands. `doneAt` is `null` until the worker has carried the command out, about 2 s later. Another account's id, or an unknown one, returns `404`.

**`result` by command:**

| Command | `result` |
|---|---|
| `stop` (kill switch) | `{ cancelled: N, error: string \| null }` |
| `wipe` | `{ cancelled: { cancelled: N, error }, wiped: N }`: the keys wiped. For KMS keys, the AWS step follows within about 15 s and is in the audit log |
| `unwind` | `{ steps: [{ coin, type, ok, error }] }` |
| `resume` | Takes effect at once and isn't queued: its answer has `id: null` |

A replace (`/v1/guard-key/rotate`) isn't a command. Its progress shows in `/v1/me` (`pendingAgent`, then the new `agent`) and in the audit log.

## Alerts

- **`GET /v1/settings/alerts`** → `{ inApp: boolean, telegram: { linked: boolean } }`. `inApp` is `true` until the user turns it off.
- **`PUT /v1/settings/alerts`** with `{ inApp: boolean }` → `{ inApp }`. Answers `400` for anything other than a boolean, and `409` before onboarding.
- **`GET /v1/alerts?since=<ms>&limit=<n>`:**
  - returns the user's recent alerts, newest first, with at most 200;
  - these are audit entries of kind `alert` (the guard telling the user something) and `degraded` (the guard holding off on stale data);
  - Telegram gets the same messages when linked;
  - the setting only controls whether the app shows them.

**Alert entries:** each entry in `GET /v1/alerts` is an audit entry, with fields that stay stable:
- `seq`: the audit sequence number. Use it to link to the entry in the audit log.
- `at`, `kind` (`alert` or `degraded`), `why`, `what`, `hash`.
- `proof`, which varies by kind.

Added for links (new; `null` when unknown):
- `ruleId`: the stage the alert is about. Taken from `proof.ruleId`, or the first of `proof.ruleIds` for the "needs your choice" notice.
- `coin`: the market. Taken from `proof.coin` or `proof.fill.coin` (liquidations).
- Stage alerts carry `ruleId`. Liquidations carry `coin`. Stale-data holds (`degraded`) carry neither.

**Read state, on the server (follows the user across devices):**
- **`GET /v1/alerts/seen`** → `{ upTo, unread }`.
  - `upTo` is the newest alert `seq` the user has seen (0 if none).
  - `unread` counts the alerts after it among the latest 500 audit entries.
- **`POST /v1/alerts/seen`** with `{ upTo: <seq> }` → `{ upTo }`.
  - The marker only moves forward: a lower value leaves it unchanged.
  - Answers `400` for anything other than a whole number, and `409` before onboarding.
  - Send the newest `seq` shown when the user opens the panel.

**`POST /v1/telegram/code`** → `{ code, expiresInMinutes: 15, bot: '@BulwarkGuardBot', link: 'https://t.me/BulwarkGuardBot?start=<code>' }`.
- Show `link` as the one-tap way to link; the bot also accepts `/link <code>`.
- `bot` and `link` are new and additive. They're `null` if no bot is configured.

**`DELETE /v1/telegram`** → `{ linked: false }`: unlinks Telegram and removes the chat id. Answers `409` before onboarding.

**The bot (`@BulwarkGuardBot`):**
- `/link <code>` (or the deep link) links the chat.
- `/stop` (also `/disarm`) replies with the kill-switch link. Stopping the guard always needs the wallet's signed command, never a chat message.
- `/unlink` forgets the chat.
- `/help` lists the commands.

## Translator: `POST /v1/rules/draft`

- **Body:** `{ text, maxSlippagePct? }`.
- **With a signed policy:** the draft adds one rule to it.
- **Without one (a first policy):** `maxSlippagePct` is required, typed by the user (above 0, at most 10), and the draft is version 1 with that slippage limit. Without it the answer is `400`.
- **Answers:**
  - `{ kind: 'draft', rule, description, provenance, policy }`;
  - `{ kind: 'clarify', question }`, including when the sentence doesn't say "once" or "every time";
  - `{ kind: 'refuse', reason }`;
  - `{ kind: 'rejected', violations }`;
  - `503` when the translator is off; `429` past 30 a hour.
- **Nothing is saved until the user signs the returned `policy`** with `POST /v1/policy`.
- **Provider:** `GET /v1/me` → `translator: { enabled, provider }`, for example `{ enabled: true, provider: 'OpenAI (GPT-6.1 Sol)' }`. Show the provider next to the translator, with what is sent: the sentence, the market list and the user's current rules.

## The user's own take-profit and stop-loss orders

The user places TP/SL and other orders with their own trading key in the browser. They never pass through the API. The guard's own orders are only the ones in `/v1/guard-orders`. To tell them apart, the app compares Hyperliquid's open orders with that list by `oid`.

**What the guard does with the user's orders:**
- **Never cancels a reduce-only order of the user's,** so their TP/SL stays. Invariant I2 enforces this before every signature.
- **"Cancel orders that would add to a position"** (a stage action) cancels only non-reduce-only orders: resting buys or sells, or stop-entries, that would grow a position.
- **The kill switch and wipe** cancel only the guard's own orders.

**A user's stop and the guard's backstop on the same position:**
- **Both rest on Hyperliquid and both fire on the mark price.** Whichever triggers first fires.
- **Both are reduce-only,** so together they can never close more than the position or flip it. Hyperliquid cancels a reduce-only order that would no longer reduce a position (status `reduceOnlyCanceled`, [info endpoint docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)).
- **If the user's stop fires first**, the position shrinks or closes. On its next run the guard re-prices the backstop for what is left, or removes it.
- **If the backstop fires first**, the user's stop has nothing left to reduce.
- **The guard doesn't move its backstop to match the user's stop.** The backstop sits at the user's lowest buffer line; the user's stop sits wherever they put it.

**Limits:** Hyperliquid allows 1,000 open orders per account by default and rejects new reduce-only and trigger orders above that. The user's orders and the guard's count together. The guard keeps one backstop per position.

## `GET /v1/guard/status`

```json
{ "state": "protected", "reason": null, "lastEvaluatedAt": 1791150000000, "updatedAt": 1791150003000 }
```

- **`state`:** `protected`, `acting`, `at_risk`, `paused`, `stopped`, `no_rules` or `alerts_only`.
- **`reason`:** only when `paused`. One of `stale_data`, `exchange_unreachable`, `signer_error`, `agent_expired`, `resign_required` (sign the policy again; see `/v1/me` `policy.needsResign`) or `operator_stop` (Bulwark paused the guard for everyone; backstops stay).
- **Behaviour:** see the B7 report and `app.ts`.

## `GET /v1/guard-orders`: orders the guard left resting on Hyperliquid

`GuardOrder[]`:

| Field | Type | Meaning |
|---|---|---|
| `oid` | number | Hyperliquid order id |
| `coin` | string | e.g. `xyz:CL` |
| `kind` | `'backstop' \| 'stage'` | `backstop` today. `stage` is reserved for stages placed on the exchange; not used, and not the default |
| `triggerPx`, `size` | number | |
| `placedAt` | ms | |
| `ruleId` | string \| null | The rule the order belongs to |
| `line` | number \| null | The buffer line the order belongs to |
| `pricing` | `'single' \| 'together' \| null` | How a backstop was priced: that position alone, or every position in its pool moving against the user at once |

Orders placed before these fields existed have `null` for them.

## `GET /v1/region`: may this user trade here, now (for the trade ticket)

```json
{ "verdict": "allowed", "trading": true, "guard": true, "country": "SG" }
```

- **`verdict`:** the strictest of where this request comes from now and the user's declarations: `allowed`, `alerts_only` or `blocked`.
- **`trading`:** `false` when `blocked`. The ticket should not place orders then.
- **`guard`:** `true` only when `allowed`.
- **`country`:** from the request, or `null` when unknown.
- Ask it when the ticket opens and before each order; it records the country for the guard too.

## Translator caps

`POST /v1/rules/draft` needs a user who finished the region step (`409` otherwise) and is not blocked (`403`). Caps answer `429 { error, limit, retryAfter }` with `Retry-After`: `drafts_account` (per account per hour) or `drafts_all` (300 per hour across all accounts).

## `GET /v1/audit?limit=&before=`: the audit log, newest first

- **`limit`:** at most 500; a missing or bad value means the default.
- **`before`:** a `seq`; returns entries older than it. A non-positive value answers `400`.
- To check the whole chain, page with `before` = the oldest `seq` received until entry `1` arrives (`apps/app/lib/audit.ts` `fetchAudit`).

## `GET /health/guard` (no auth)

`200 { ok: true, … }` while the worker's heartbeat is under 60 s old, its newest mark under 30 s old and it runs on this API's network; otherwise `503 { ok: false, problems: [...] }`.

## `POST /v1/policy`: sign a policy version

- **The repeat choice is required:** every rule must carry `repeat: { mode: 'oncePerBreach' | 'everyCrossing', limit?: { times, perHours } }`.
- **Without it:** `400 { error, needsChoice: [ruleIds] }`.
- **Limit:** `times` is a positive whole number and `perHours` is above 0, both typed by the user. No value is pre-filled.

## Audit log proof fields (stable)

The app reads these from `GET /v1/audit` entries' `proof`.

| Entry | Fields |
|---|---|
| Guard order attempts (`kind: 'guard_action'`) | `attempt` (1 = first try, 2+ = retries), `filled` (size filled), `limitPx`, `keys` (the stages that wanted it), `ruleId`, `failedAt` (`'sign' \| 'send'`, only on failures), `statuses`, `nonce`, `cloid`, `latencyMs`, `builderRetried` |
| Backstops (`kind: 'backstop'`) | `coin`, `triggerPx`, `limitPx`, `size`, `line`, `pricing` |
| Cancels | `coin`, `oid` |
| Key events (`kind: 'key'`) | `address`, `kmsKeyId` (KMS only) |

Any change to a field name here comes as a new name next to the old one, announced first. The old name stays until the app has moved.
