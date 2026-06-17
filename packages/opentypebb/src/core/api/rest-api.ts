/**
 * REST API setup using Hono.
 * Maps to: openbb_core/api/rest_api.py + platform_api/main.py
 *
 * Creates the Hono app with:
 * - CORS middleware
 * - Default credential injection middleware
 * - Error handling
 * - Health check endpoint
 * - /widgets.json endpoint (for OpenBB Workspace frontend)
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import type { Credentials } from '../app/model/credentials.js'
import { getSchwabBroker } from '../../providers/schwab/schwab-singleton.js'

const OBB_HEADERS = { 'X-Backend-Type': 'OpenBB Platform' }

/**
 * Create the Hono app with middleware configured.
 * Maps to: the FastAPI app creation in rest_api.py
 *
 * @param defaultCredentials - Default credentials injected into every request
 *                             (can be overridden per-request via X-OpenBB-Credentials header)
 */
export function createApp(
  defaultCredentials: Credentials = {},
): Hono {
  const app = new Hono()

  // CORS middleware (allow all origins by default, matching OpenBB defaults)
  app.use(cors())

  // Health check
  app.get('/api/v1/health', (c) => c.json({ status: 'ok' }))

  // Schwab-specific health: surfaces whether the OAuth singleton has booted
  // and the access token's expiry (~30 min from last refresh).
  app.get('/api/v1/schwab/health', async (c) => {
    try {
      const broker = await getSchwabBroker()
      const tokens = broker.meta.getCurrentTokens()
      const expiresAt = new Date(tokens.expiresAt).toISOString()
      return c.json({ connected: true, expires_at: expiresAt })
    } catch {
      return c.json({ connected: false, expires_at: null })
    }
  })

  // Schwab accounts — account-number → hash mapping for the authorized login.
  // NB: returns real (PII) account numbers. Needs the "Accounts and Trading
  // Production" product + account scope on the token.
  app.get('/api/v1/schwab/accounts', async (c) => {
    try {
      const broker = await getSchwabBroker()
      return c.json({ accounts: await broker.getAccountNumbers() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 502)
    }
  })

  // Schwab transaction history (raw pass-through dump).
  // Required query params: startDate, endDate (ISO-8601 w/ ms+tz, e.g.
  // 2026-01-01T00:00:00.000Z; Schwab caps the span at ~1 year).
  // Optional: account (number or hash; omit = all authorized accounts), types, symbol.
  app.get('/api/v1/schwab/transactions', async (c) => {
    const startDate = c.req.query('startDate')
    const endDate = c.req.query('endDate')
    if (!startDate || !endDate) {
      return c.json(
        { error: 'startDate and endDate are required (ISO-8601 with ms+tz, e.g. 2026-01-01T00:00:00.000Z)' },
        400,
      )
    }
    try {
      const broker = await getSchwabBroker()
      const transactions = await broker.getTransactions({
        account: c.req.query('account'),
        startDate,
        endDate,
        types: c.req.query('types'),
        symbol: c.req.query('symbol'),
      })
      return c.json({ transactions })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 502)
    }
  })

  return app
}

/**
 * Mount the /widgets.json endpoint on the app.
 * Maps to: @app.get("/widgets.json") in platform_api/main.py
 *
 * The widgets config is generated once at startup and cached.
 * This is the endpoint that the OpenBB Workspace frontend fetches
 * to discover available data widgets.
 *
 * @param app - The Hono app
 * @param widgetsJson - Pre-built widgets configuration
 */
export function mountWidgetsEndpoint(
  app: Hono,
  widgetsJson: Record<string, unknown>,
): void {
  app.get('/widgets.json', (c) => {
    return c.json(widgetsJson, 200, OBB_HEADERS)
  })
}

/**
 * Start the HTTP server.
 * Maps to: uvicorn.run() in rest_api.py
 */
export function startServer(app: Hono, port = 6900): void {
  serve({ fetch: app.fetch, port })
  console.log(`OpenTypeBB listening on http://localhost:${port}`)
}
