import { describe, expect, it, vi } from 'vitest'
import { sendInvitationEmail } from '../../worker/providers/scaleway-email.js'

describe('Scaleway invitation email provider', () => {
  it('sends one recipient with an opaque job header in the body', async () => {
    const fetch = vi.fn(async () => Response.json({ emails: [{ id: 'tem_1' }] }))
    await expect(sendInvitationEmail({ fetch, secret: 'secret', projectId: 'project_1', fromEmail: 'noreply@example.test', fromName: 'Bear with me', appOrigin: 'https://panel.bearwithme.pl', jobId: 'job_1', recipient: 'anna@example.test', expiresAt: '2026-08-01T10:00:00.000Z' }))
      .resolves.toEqual({ providerId: 'tem_1' })
    expect(fetch.mock.calls[0][0]).toBe('https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails')
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.to).toEqual([{ email: 'anna@example.test' }])
    expect(body.additional_headers).toEqual({ 'X-BWM-Job-ID': 'job_1' })
  })
})
