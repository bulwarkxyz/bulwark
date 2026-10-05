# API contract for the app

The parts of the Bulwark API the app relies on. Field names here are stable. A change to one is versioned and announced before it ships, never made silently.

**Base and auth:**
- **Base:** the app calls `/api/bw/...` (its server proxy), which forwards to the API.
- **Auth:** every `/v1/*` route needs `Authorization: Bearer <session>` from `POST /auth/verify` (SIWE). Without it the answer is `401`.

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

### `POST /v1/onboarding/agent`: create the guard key

| Answer | When |
|---|---|
| `200 { agentAddress }` | A KMS key was created, or the user already has a key |
| `202 { status: 'creating' }` | Encrypted custody (fallback): the signing service creates it. Poll `/v1/me` |
| `409` | The region step isn't done |
| `403` | The guard is off in the user's region |
| `503` | Keys are unavailable; retry later |

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

## `GET /v1/guard/status`

```json
{ "state": "protected", "reason": null, "lastEvaluatedAt": 1791150000000, "updatedAt": 1791150003000 }
```

- **`state`:** `protected`, `acting`, `at_risk`, `paused`, `stopped`, `no_rules` or `alerts_only`.
- **`reason`:** only when `paused`. One of `stale_data`, `exchange_unreachable`, `signer_error` or `agent_expired`.
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
