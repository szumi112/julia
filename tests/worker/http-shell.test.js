import { describe, expect, it } from 'vitest'
import { createApp } from '../../worker/app.js'

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
})
