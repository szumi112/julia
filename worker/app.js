import { Hono } from 'hono'
import { AppError, apiError } from './http/errors.js'
import { isCorrelationId, safeLog } from './logging/safe-log.js'

export function createApp(deps = {}) {
  const app = new Hono()
  app.use('/api/*', async (c, next) => {
    const requestedCorrelationId = c.req.header('x-correlation-id')
    const correlationId = isCorrelationId(requestedCorrelationId) ? requestedCorrelationId : crypto.randomUUID()
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
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 500)
    log('error', {
      event: 'request.failed',
      correlationId: c.get('correlationId'),
      errorCode: appError.code,
    })
    return apiError(
      appError.code,
      appError.status,
      c.get('correlationId') || crypto.randomUUID()
    )
  })
  return app
}
