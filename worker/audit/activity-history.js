import { captureActivityChanges } from '../../src/activity-history.js'
import { decryptForScope, encryptForScope } from '../security/envelope.js'

const AUDIT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const APPOINTMENT_ACTIONS = new Set([
  'appointment.created', 'appointment.updated',
  'appointment.cancelled', 'appointment.restored',
])
const PAYMENT_ACTIONS = new Set(['payment.recorded', 'payment.corrected'])
const FINANCE_ACTIONS = new Set([
  'finance.entry.created', 'finance.entry.adjusted', 'finance.entry.voided',
])
const fail = () => { throw new Error('ACTIVITY_DETAILS_INVALID') }
const exact = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))

function capture(input, keys) {
  if (!exact(input, keys) || typeof input.auditId !== 'string'
    || !AUDIT_ID.test(input.auditId) || !exact(input.scope, ['type', 'id', 'purpose'])) fail()
  const action = input.action
  const clientAction = APPOINTMENT_ACTIONS.has(action) || PAYMENT_ACTIONS.has(action)
  const financeAction = FINANCE_ACTIONS.has(action)
  if (!clientAction && !financeAction) fail()
  if (clientAction && (input.scope.type !== 'client'
    || typeof input.scope.id !== 'string' || !CLIENT_ID.test(input.scope.id)
    || input.scope.purpose !== 'identity')) fail()
  if (financeAction && (input.scope.type !== 'centre_finance'
    || input.scope.id !== 'centre_1' || input.scope.purpose !== 'ledger')) fail()
  return { clientAction, financeAction }
}

function checkedChanges(action, value) {
  const changes = captureActivityChanges(value)
  if (!changes || changes.length < 1 || (!APPOINTMENT_ACTIONS.has(action)
    && changes.some(({ field }) => field !== 'amount'))) fail()
  return changes
}

export async function activityDetailStatement(db, input) {
  if (!db?.prepare) fail()
  capture(input, ['auditId', 'action', 'keyring', 'dataKey', 'scope', 'changes'])
  const changes = checkedChanges(input.action, input.changes)
  const envelope = JSON.stringify(await encryptForScope(input.keyring, input.dataKey, {
    expectedScope: input.scope,
    recordId: input.auditId,
    field: 'activity_details',
    plaintext: JSON.stringify({ version: 1, changes }),
  }))
  return db.prepare(
    `INSERT INTO activity_history_details
     (audit_id,scope_type,scope_id,scope_purpose,details_envelope)
     VALUES (?,?,?,?,?)`,
  ).bind(input.auditId, input.scope.type, input.scope.id, input.scope.purpose, envelope)
}

export async function decryptActivityDetails(input) {
  capture(input, ['keyring', 'dataKey', 'scope', 'auditId', 'action', 'envelope'])
  let parsedEnvelope
  try { parsedEnvelope = JSON.parse(input.envelope) } catch { fail() }
  const plaintext = await decryptForScope(input.keyring, input.dataKey, {
    expectedScope: input.scope,
    recordId: input.auditId,
    field: 'activity_details',
    envelope: parsedEnvelope,
  })
  let parsed
  try { parsed = JSON.parse(plaintext) } catch { fail() }
  if (!exact(parsed, ['version', 'changes']) || parsed.version !== 1) fail()
  return checkedChanges(input.action, parsed.changes)
}
