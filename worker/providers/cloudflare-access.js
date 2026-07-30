const endpoint = ({ accountId, groupId }) => `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/groups/${groupId}`
const retryable = (status) => status === 429 || status >= 500
const fail = (code, retry = false) => Object.assign(new Error(code), { retryable: retry })

function exactGroup(body, input) {
  const group = body?.result
  if (!body?.success || !group || group.id !== input.groupId || group.name !== input.groupName
    || !Array.isArray(group.include) || !Array.isArray(group.require) || !Array.isArray(group.exclude)) fail('ACCESS_PROVIDER_SCHEMA')
  if (group.include.some((rule) => !rule?.email || typeof rule.email.email !== 'string' || Object.keys(rule).length !== 1)) fail('ACCESS_PROVIDER_SCHEMA')
  return group
}

async function responseJson(response) {
  if (!response) fail('ACCESS_PROVIDER_TRANSPORT', true)
  if (!response.ok) fail('ACCESS_PROVIDER_HTTP', retryable(response.status))
  try { return await response.json() } catch { fail('ACCESS_PROVIDER_SCHEMA') }
}

export async function reconcileAccessGroup(input = {}) {
  const { fetch: fetchImpl, token, accountId, groupId, groupName } = input
  if (typeof fetchImpl !== 'function' || typeof token !== 'string' || !token || !accountId || !groupId || !groupName || !Array.isArray(input.emails)) fail('ACCESS_PROVIDER_SCHEMA')
  const url = endpoint({ accountId, groupId })
  let current
  try {
    current = exactGroup(await responseJson(await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } })), input)
  } catch (error) { throw error }
  const emails = [...new Set(input.emails)].sort((left, right) => left.localeCompare(right))
  if (!emails.every((email) => typeof email === 'string' && /^[^@\s]+@example\.test$/.test(email))) fail('ACCESS_PROVIDER_SCHEMA')
  const payload = { ...current, include: emails.map((email) => ({ email: { email } })) }
  delete payload.id
  delete payload.name
  try {
    await responseJson(await fetchImpl(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }))
    const verified = exactGroup(await responseJson(await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } })), input)
    const actual = verified.include.map((rule) => rule.email.email).sort((a, b) => a.localeCompare(b))
    if (JSON.stringify(actual) !== JSON.stringify(emails)) fail('ACCESS_PROVIDER_SCHEMA')
    return { emails }
  } catch (error) { throw error }
}
