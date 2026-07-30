import { describe, expect, it, vi } from 'vitest'
import { reconcileAccessGroup } from '../../worker/providers/cloudflare-access.js'

describe('Cloudflare Access provider', () => {
  it('GETs, PUTs the full sorted email set, and verifies the configured group', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: 'group_1', name: 'Staff', include: [], require: [{ email_domain: { domain: 'example.test' } }], exclude: [] } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: 'group_1', name: 'Staff', include: [], require: [{ email_domain: { domain: 'example.test' } }], exclude: [] } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: 'group_1', name: 'Staff', include: [{ email: { email: 'anna@example.test' } }, { email: { email: 'zoe@example.test' } }], require: [{ email_domain: { domain: 'example.test' } }], exclude: [] } }))
    await reconcileAccessGroup({
      fetch, token: 'secret', accountId: 'account_1', groupId: 'group_1', groupName: 'Staff',
      emails: ['zoe@example.test', 'anna@example.test', 'anna@example.test'],
    })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetch.mock.calls[1][1].body).include).toEqual([
      { email: { email: 'anna@example.test' } }, { email: { email: 'zoe@example.test' } },
    ])
  })
})
