import { Hono } from 'hono'
import { apiError } from './http/errors.js'
import { safeLog } from './logging/safe-log.js'

export function createApp(deps = {}) {
  const app = new Hono()
  app.use('/api/*', async (c, next) => {
    const correlationId = c.req.header('x-correlation-id') || crypto.randomUUID()
    c.set('correlationId', correlationId)
    await next()
    c.header('cache-control', 'no-store')
    c.header('x-content-type-options', 'nosniff')
    c.header('x-correlation-id', correlationId)
    c.header('referrer-policy', 'no-referrer')
  })
  app.get('/api/v1/health/live', (c) => c.json({ data: { status: 'ok' } }))
  app.notFound((c) => apiError('NOT_FOUND', 404, c.get('correlationId') || crypto.randomUUID()))
  app.onError((error, c) => {
    const log = deps.safeLog || safeLog
    log('error', {
      event: 'request.failed',
      correlationId: c.get('correlationId'),
      errorCode: error.code || 'INTERNAL_ERROR',
    })
    return apiError(
      error.code || 'INTERNAL_ERROR',
      error.status || 500,
      c.get('correlationId') || crypto.randomUUID()
    )
  })
  return app
}
