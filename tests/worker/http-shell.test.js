import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import { safeLog } from '../../worker/logging/safe-log.js'

describe('API shell', () => {
  it('returns a stable envelope and correlation id for unknown API routes', async () => {
    const response = await createApp().request('/api/v1/not-present')

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    })
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('never lets the API route fall through to the SPA', async () => {
    const response = await createApp().request('/api/not-present')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('regenerates an untrusted correlation id and keeps arbitrary error codes generic', async () => {
    const log = vi.fn()
    const app = createApp({ safeLog: log })
    app.get('/api/v1/test-error', () => {
      const error = new Error('provider failure')
      error.code = 'PROVIDER_SECRET_FAILURE'
      error.status = 418
      error.body = 'parent@example.test'
      throw error
    })

    const response = await app.request('/api/v1/test-error', {
      headers: { 'x-correlation-id': 'parent@example.test' },
    })
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(body)).not.toContain('parent@example.test')
    expect(log).toHaveBeenCalledWith('error', {
      event: 'request.failed',
      correlationId: response.headers.get('x-correlation-id'),
      errorCode: 'INTERNAL_ERROR',
    })
  })
})

describe('safeLog', () => {
  it('keeps valid PII-free fields', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    safeLog('info', {
      actorId: 'staff_42',
      correlationId: '11111111-1111-4111-8111-111111111111',
      durationMs: 18,
      entityId: 'session_42',
      entityType: 'session',
      event: 'request.completed',
      jobId: 'job_42',
      result: 'success',
    })

    expect(output).toHaveBeenCalledWith(JSON.stringify({
      actorId: 'staff_42',
      correlationId: '11111111-1111-4111-8111-111111111111',
      durationMs: 18,
      entityId: 'session_42',
      entityType: 'session',
      event: 'request.completed',
      jobId: 'job_42',
      result: 'success',
    }))
  })

  it('drops emails, JWT-like values, provider objects, and bodies', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    const email = 'parent@example.test'
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InBhcmVudEBleGFtcGxlLnRlc3QifQ.signature'
    safeLog('error', {
      actorId: email,
      correlationId: 'invalid',
      durationMs: -1,
      entityId: jwt,
      entityType: { provider: 'access' },
      errorCode: 'INTERNAL_ERROR',
      event: 'request.failed',
      jobId: { body: email },
      result: ['failed'],
      body: email,
    })

    const line = output.mock.calls[0][0]
    expect(line).toBe(JSON.stringify({ errorCode: 'INTERNAL_ERROR', event: 'request.failed' }))
    expect(line).not.toContain(email)
    expect(line).not.toContain(jwt)
    expect(line).not.toContain('provider')
    expect(line).not.toContain('body')
  })

  it('does not log unknown levels', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    safeLog('log', { event: 'request.completed' })
    expect(output).not.toHaveBeenCalled()
  })
})
