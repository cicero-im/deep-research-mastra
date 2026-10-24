import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

interface Bindings {
  ASSETS: Fetcher
  // Service binding to the Mastra Worker (deep-research-mastra-api).
  // Optional so local `vite preview` without a binding still boots — at
  // runtime the proxy returns 503 if the binding is missing.
  MASTRA?: Fetcher
}

const api = new Hono<{ Bindings: Bindings }>()

api.use('*', logger())
api.use('*', cors())

api.get('/health', (c) =>
  c.json({ status: 'ok', service: 'deep-research-mastra', time: new Date().toISOString() }),
)

const STRIPPED_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'host',
  'connection',
  'content-length',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])

const sanitizeHeaders = (incoming: Headers): Headers => {
  const out = new Headers()
  incoming.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (STRIPPED_HEADERS.has(lower)) return
    if (lower.startsWith('cf-')) return
    out.set(key, value)
  })
  return out
}

const proxyToMastra = async (
  c: { env: Bindings; req: { method: string; url: string; raw: Request } },
  prefixToStrip: string,
): Promise<Response> => {
  const mastra = c.env.MASTRA
  if (!mastra) {
    return new Response(
      JSON.stringify({
        error: 'MASTRA service binding not configured.',
      }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )
  }
  const reqUrl = new URL(c.req.url)
  const suffix = reqUrl.pathname.slice(prefixToStrip.length)
  const upstreamPath = '/api' + (suffix.startsWith('/') ? suffix : '/' + suffix)
  // Service bindings ignore the host portion; we use a placeholder origin.
  const upstreamUrl = new URL(upstreamPath + reqUrl.search, 'https://mastra.internal')

  const init: RequestInit = {
    method: c.req.method,
    headers: sanitizeHeaders(c.req.raw.headers),
  }
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    init.body = await c.req.raw.arrayBuffer()
  }

  try {
    return await mastra.fetch(upstreamUrl.toString(), init)
  } catch {
    return new Response(
      JSON.stringify({ error: 'Upstream Mastra service unreachable' }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }
}

api.get('/agents', (c) => proxyToMastra(c, '/api'))
api.get('/workflows', (c) => proxyToMastra(c, '/api'))
api.all('/mastra/*', (c) => proxyToMastra(c, '/api/mastra'))

const app = new Hono<{ Bindings: Bindings }>()

app.route('/api', api)

app.notFound(async (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app
