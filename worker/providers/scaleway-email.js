const URL = 'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails'
const fail = (code, retryable = false, ambiguous = false) => Object.assign(new Error(code), { retryable, ambiguous })

export async function sendInvitationEmail(input = {}) {
  const { fetch: fetchImpl, secret, projectId, fromEmail, fromName, appOrigin, jobId, recipient, expiresAt } = input
  if (typeof fetchImpl !== 'function' || !secret || !projectId || !fromEmail || !fromName || !appOrigin || !jobId || !recipient || !expiresAt) fail('EMAIL_PROVIDER_SCHEMA')
  const expiry = new Date(expiresAt)
  if (Number.isNaN(expiry.getTime()) || !/^https:\/\//.test(appOrigin)) fail('EMAIL_PROVIDER_SCHEMA')
  const date = expiry.toLocaleString('pl-PL', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Warsaw' })
  const body = {
    project_id: projectId, from: { email: fromEmail, name: fromName }, to: [{ email: recipient }],
    subject: 'Zaproszenie do panelu Bear with me',
    text: `Bear with me - zaproszenie do panelu. Otwórz ${appOrigin} przed ${date}.`,
    html: `<p>Bear with me - zaproszenie do panelu.</p><p><a href="${appOrigin}">Otwórz panel</a> przed ${date}.</p>`,
    additional_headers: { 'X-BWM-Job-ID': jobId },
  }
  let response
  try { response = await fetchImpl(URL, { method: 'POST', headers: { 'X-Auth-Token': secret, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) } catch { fail('EMAIL_DELIVERY_AMBIGUOUS', false, true) }
  if (!response) fail('EMAIL_DELIVERY_AMBIGUOUS', false, true)
  if (response.status === 429) fail('EMAIL_PROVIDER_HTTP', true)
  if (response.status >= 500) fail('EMAIL_DELIVERY_AMBIGUOUS', false, true)
  if (!response.ok) fail('EMAIL_PROVIDER_HTTP')
  let parsed
  try { parsed = await response.json() } catch { fail('EMAIL_DELIVERY_AMBIGUOUS', false, true) }
  const emails = parsed?.emails
  if (!Array.isArray(emails) || emails.length !== 1 || typeof emails[0]?.id !== 'string' || !emails[0].id) fail('EMAIL_DELIVERY_AMBIGUOUS', false, true)
  return { providerId: emails[0].id }
}
