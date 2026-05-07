# Schwab broker

OpenAlice integration for the [Charles Schwab Trader API](https://developer.schwab.com).

## Scope (v1)

| Capability | Status |
|-----------|--------|
| Realtime equity quotes | ✅ `getQuote()` |
| Option chains with greeks | ✅ `getOptionChain()` |
| Contract search (equities) | ✅ |
| Market clock (approximate) | ✅ |
| Order placement / modify / cancel | ❌ Stubbed — returns `success: false` |
| Account info / positions / orders | ❌ Stubbed — returns empty or throws |
| Research reports | ❌ Schwab doesn't expose these via API |

Trading support is intentionally deferred until the market-data path is validated against a real account. The broker registers with `marketDataOnly: true` by default; flip it in `accounts.json` once trading ships.

## Setup

### 1. Register a developer app

Go to <https://developer.schwab.com> and create an Individual Developer app. You'll pick:

- **App Name** — whatever you like (e.g., "OpenAlice").
- **Callback URL** — use `https://127.0.0.1` unless you're wiring a real callback server. Schwab requires an exact match for the string in the config, including trailing slash.
- **API product** — pick "Accounts and Trading Production" and "Market Data Production" to get both surfaces.

Approval typically takes 1–3 business days.

### 2. Run the one-time OAuth helper

```bash
pnpm tsx scripts/schwab-oauth.ts \
  --client-id YOURID \
  --client-secret YOURSECRET \
  --redirect-uri https://127.0.0.1
```

It prints an authorization URL. Open it in your browser, log in to Schwab, and authorize the app. Your browser will try to load `https://127.0.0.1/?code=...` — that fails to render (nothing is listening), but the URL in the address bar is what you want. Copy the whole URL back into the helper.

The helper prints a **refresh token**. Save it — you'll paste it into the account config in step 3.

### 3. Add a Schwab account in OpenAlice

In the UI **New Account** wizard, pick **Charles Schwab**. Fill in:

- **App Client ID** — same as in the helper
- **App Client Secret** — same as in the helper
- **Callback URL** — same as in the helper
- **Refresh Token** — the token the helper printed
- **Market Data Only** — leave on (recommended until trading ships)

If you prefer editing `data/config/accounts.json` directly:

```json
{
  "id": "schwab-main",
  "label": "Schwab",
  "provider": { "type": "schwab" },
  "brokerConfig": {
    "clientId": "...",
    "clientSecret": "...",
    "redirectUri": "https://127.0.0.1",
    "refreshToken": "...",
    "marketDataOnly": true
  }
}
```

### 4. Token lifecycle

Schwab refresh tokens are valid for **7 days from issue**. OpenAlice rotates the refresh token on every successful refresh, so as long as the broker is run at least weekly the token stays alive indefinitely.

If the token does expire (7-day silence), the broker surfaces `BrokerError('AUTH', ...)` on init and the account is disabled. Re-run the OAuth helper and paste in a fresh token to recover.

## Design notes

### Thin direct client, no third-party SDK

Unlike IBKR (which hand-ports the TWS socket protocol) this package wraps `fetch` directly. Schwab's API is plain REST + OAuth 2.0 and there's no mature first-party JS SDK, so adding a community dependency for a real-money trading path doesn't pass the supply-chain bar that IBKR's DESIGN.md laid out.

### Options chain as a non-IBroker method

`getOptionChain()` is Schwab-specific in v1. IBroker doesn't have an options-chain method — adding one is a cross-broker decision that should happen when a second broker (IBKR, Alpaca) ships chain support. Until then, consumers that need a chain should type-check:

```ts
if (broker instanceof SchwabBroker) {
  const chain = await broker.getOptionChain({ symbol })
}
```

### No research reports

Schwab's research (Morningstar, Argus, Market Edge PDFs) is gated inside `client.schwab.com` with no API. Scraping the authenticated site is a separate feature and isn't in this package.

## Testing without credentials

`SchwabBroker.spec.ts` uses a mocked `fetch` that returns recorded fixture shapes. It exercises the parsing paths, OAuth refresh, 401 retry, and chain flattening end-to-end without hitting Schwab. Run:

```bash
pnpm test src/domain/trading/brokers/schwab
```

Live integration tests would go in `src/domain/trading/__test__/e2e/schwab-live.e2e.spec.ts` once credentials land — match the Alpaca e2e pattern.
