# Schwab broker — harden the rolling refresh chain

STATUS: PROPOSED
FILED: 2026-05-28 (filed from Lumen TL session — Schwab quotes degraded for ~3 days while the chain was snapped)
PRIORITY: P1 (silent degradation: quotes fall back to yfinance 15-min delayed; the dashboard and advisor flow keep working but staleness compounds during market hours; recovery requires the OAuth re-seed dance until this lands)

## Symptom

Realtime Schwab quotes degrade to the yfinance fallback when the refresh chain snaps:
```
[schwab equity-quote] Failed for symbol: Schwab token refresh failed (400):
  {"error":"unsupported_token_type",
   "error_description":"... Refresh token is invalid, expired or revoked ... invalid_grant"}
[price-router] Schwab quote failed, falling back to yfinance
```
`/api/v1/schwab/health` keeps reporting `connected:true` with a stale `expires_at` (cached state, not live), so it's invisible to ops until someone notices stale prices.

## Latest break — empirical evidence (2026-05-25)

- Last good Schwab quote: `2026-05-25T20:15:01Z`.
- Stored `mintedAt`: `2026-05-25T20:15:00.966Z` (a fresh rotation persisted at the same instant the last good quote went out).
- ~30 min later (next access-token refresh tick): every refresh attempt thereafter returned `invalid_grant`.
- The persisted refresh token was **structurally valid** (string, length 140 — a real Schwab refresh token, not a corrupted/undefined persist).

So Schwab actively rejected a freshly-rotated, structurally-valid token. That rules out plain expiry (only ~30 min old when first rejected) and persistence corruption.

## Root-cause hypothesis — two unsynchronized refresh paths

There are **two code paths** that call `refreshAccessToken` and persist the result, and they do **not** share a lock:

| Path | File | Single-flighted? |
|------|------|-------------------|
| Client on-demand refresh | `src/domain/trading/brokers/schwab/schwab-client.ts:67` (`refreshInFlight`) | ✅ yes |
| Broker eager refresh on init | `src/domain/trading/brokers/schwab/SchwabBroker.ts:137` + persist at `:156` | ❌ no |

If both paths fire near-simultaneously (a quote batch hitting an expired access token while `init()` is also refreshing — possible on startup, on rotation tick, or on concurrent first-quote-after-idle), they each call `refreshAccessToken` with the same currently-persisted refresh token. Schwab rotates and invalidates the old one. The two callers race on `onTokensRefreshed`; the file ends up holding *one* of the rotated tokens, while Schwab considers a different (or already-consumed) token current. Next refresh: `invalid_grant`. Matches the symptom timing exactly.

(There's also a credible interaction with the persistence step itself — a write that's interrupted between the two calls leaves a partial JSON file the next load can't parse cleanly. Atomic-rename fixes that bucket of failure modes at the same time.)

## Fix outline

1. **Unify the refresh path.** Remove the direct `refreshAccessToken` call inside `SchwabBroker.init()` (`:137`) and have init delegate to the client's `refreshInFlight`-guarded `refreshTokens()`. Result: one single-flight covers every code path that can mint or rotate a refresh token. (If there's a reason `init()` *must* refresh outside the client, lift the single-flight up to a broker-level mutex covering both call sites.)
2. **Atomic-rename `schwab-tokens.json` writes.** In `onTokensRefreshed`: write to `schwab-tokens.json.tmp`, `fsync`, then `rename()` over the live file. Eliminates "interrupted write leaves partial JSON" plus "two writers fight for the same file descriptor" race modes.
3. **Surface chain health in `/api/v1/schwab/health`.** Today it only returns `connected` + access-token `expires_at`, which lies for ~30 min after a snap (cached pre-failure state). Add:
   - `lastRefreshAt` — timestamp of the last refresh attempt (success or failure)
   - `lastRefreshError` — short message + Schwab error code if the last attempt failed (null on success)
   - `refreshCount` — running counter (rotation telemetry — should keep ticking)
   So a snapped chain becomes observable in seconds via the existing health endpoint (and DevOps can alert on it).

## Verification — concurrency repro

Add a test that proves the race is closed:

1. Mint a valid refresh token (test seed or mocked Schwab).
2. Force the access token expired (set `expiresAt = 0` in-memory).
3. Fire N concurrent `getQuote` calls (`Promise.all` of 20 quotes).
4. Assertions:
   - Exactly **one** outbound refresh call hit Schwab (per round).
   - The persisted `refreshToken` is non-empty and a single, consistent value across N runs.
   - A subsequent `getQuote` succeeds (the chain held).

Run repeatedly across thousands of iterations under high concurrency; without the fix, the test should be able to reproduce the snap.

## Recovery runbook (until this lands)

Operator side, ~2 min: browser OAuth login → exchange code → write new `schwab-tokens.json` → restart `openalice`. Saved in the Lumen-side memory `reference_schwab_api_recovery.md` (script-driven end-to-end except the browser login itself). Worked cleanly on 2026-05-28.

## References

- `src/domain/trading/brokers/schwab/schwab-auth.ts:21,22` — `SCHWAB_AUTH_URL`, `SCHWAB_TOKEN_URL`
- `src/domain/trading/brokers/schwab/schwab-auth.ts:111-139` — `refreshAccessToken` (correct on its own; the bug is at the callers)
- `src/domain/trading/brokers/schwab/schwab-client.ts:47-82` — existing `refreshInFlight` single-flight (the model to extend)
- `src/domain/trading/brokers/schwab/SchwabBroker.ts:137-156` — the un-guarded refresh + persist path to unify
- `scripts/schwab-oauth.ts` — the re-seed entry point (recovery, not normal operation)
- Lumen-side: `docs/reviews/done/openalice-schwab-integration.spec.md` — original integration design and `onTokensRefreshed` contract; the "re-auth UI banner" was deferred "until empirical data on whether the token rolls" — empirical data is now in (it rolls until the race snaps it).
