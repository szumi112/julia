import {
  createWrappedDataKey,
  decryptForScope,
  encryptForScope,
  loadDataKey,
} from '../security/envelope.js'
import {
  assertClientIdentity,
  assertCorrectionReason,
  isCorrectionId,
} from '../../src/core-records.js'

const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const DATA_KEY_KEYS = Object.freeze([
  'id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64',
  'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at',
])

const fail = () => { throw new Error('CRYPTO_FAILURE') }

const captureExact = (value, keys) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length || !keys.every((key) => actual.includes(key))) fail()
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail()
      captured[key] = descriptor.value
    }
    return Object.freeze(captured)
  } catch { fail() }
}

export function clientKeyScope(clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) fail()
  return Object.freeze({ type: 'client', id: clientId, purpose: 'identity' })
}

export function assertClientKeyScope(scope) {
  const captured = captureExact(scope, ['type', 'id', 'purpose'])
  if (captured.type !== 'client'
    || typeof captured.id !== 'string' || !CLIENT_ID.test(captured.id)
    || captured.purpose !== 'identity') fail()
  return captured
}

class OwnershipConsumer {
  #verifyCharge
  #verifyPayment

  constructor(verifyCharge, verifyPayment) {
    this.#verifyCharge = verifyCharge
    this.#verifyPayment = verifyPayment
    Object.freeze(this)
  }

  verifyCharge(value) {
    try { return this.#verifyCharge(value) } catch { fail() }
  }

  verifyPayment(value) {
    try { return this.#verifyPayment(value) } catch { fail() }
  }
}

const requireConsumer = (value) => {
  try {
    if (!(value instanceof OwnershipConsumer)) fail()
    return value
  } catch { fail() }
}

export function assertOwnershipConsumer(value) {
  try { return requireConsumer(value) } catch { fail() }
}

export function verifyChargeOwnership(consumer, value) {
  try { return requireConsumer(consumer).verifyCharge(value) } catch { fail() }
}

export function verifyPaymentOwnership(consumer, value) {
  try { return requireConsumer(consumer).verifyPayment(value) } catch { fail() }
}

// The composition root must inject `issuer` only into the repository that has just
// authorized a joined ownership row, and inject `consumer` only into command/build
// code. Issuance is deliberately pure here; this Task-8 boundary performs no D1 read.
export function createOwnershipCapabilityBoundary(...args) {
  try {
    if (args.length !== 0) fail()
    const chargeFacts = new WeakSet()
    const paymentFacts = new WeakSet()
    const issueCharge = (input) => {
      try {
        const fact = captureExact(input, ['clientId', 'appointmentId'])
        if (typeof fact.clientId !== 'string' || !CLIENT_ID.test(fact.clientId)
          || typeof fact.appointmentId !== 'string'
          || !APPOINTMENT_ID.test(fact.appointmentId)) fail()
        chargeFacts.add(fact)
        return fact
      } catch { fail() }
    }
    const issuePayment = (input) => {
      try {
        const fact = captureExact(input, ['clientId', 'appointmentId', 'paymentId'])
        if (typeof fact.clientId !== 'string' || !CLIENT_ID.test(fact.clientId)
          || typeof fact.appointmentId !== 'string'
          || !APPOINTMENT_ID.test(fact.appointmentId)
          || typeof fact.paymentId !== 'string' || !PAYMENT_ID.test(fact.paymentId)) fail()
        paymentFacts.add(fact)
        return fact
      } catch { fail() }
    }
    const verifyCharge = (value) => {
      if (!chargeFacts.has(value)) fail()
      const fact = captureExact(value, ['clientId', 'appointmentId'])
      if (typeof fact.clientId !== 'string' || !CLIENT_ID.test(fact.clientId)
        || typeof fact.appointmentId !== 'string'
        || !APPOINTMENT_ID.test(fact.appointmentId)) fail()
      return fact
    }
    const verifyPayment = (value) => {
      if (!paymentFacts.has(value)) fail()
      const fact = captureExact(value, ['clientId', 'appointmentId', 'paymentId'])
      if (typeof fact.clientId !== 'string' || !CLIENT_ID.test(fact.clientId)
        || typeof fact.appointmentId !== 'string'
        || !APPOINTMENT_ID.test(fact.appointmentId)
        || typeof fact.paymentId !== 'string' || !PAYMENT_ID.test(fact.paymentId)) fail()
      return fact
    }
    return Object.freeze({
      issuer: Object.freeze({ issueCharge, issuePayment }),
      consumer: new OwnershipConsumer(verifyCharge, verifyPayment),
    })
  } catch { fail() }
}

const canonicalInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

export async function buildClientDataKey(db, keyring, input) {
  try {
    if (!db?.prepare) fail()
    const captured = captureExact(input, ['clientId', 'dataKeyId', 'createdAt'])
    if (typeof captured.dataKeyId !== 'string' || !OPAQUE_ID.test(captured.dataKeyId)
      || !canonicalInstant(captured.createdAt)) fail()
    const scope = clientKeyScope(captured.clientId)
    const row = captureExact(await createWrappedDataKey(keyring, {
      scope, id: captured.dataKeyId, createdAt: captured.createdAt,
    }), DATA_KEY_KEYS)
    const statement = db.prepare(
      `INSERT INTO data_keys
       (id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64,
        wrap_nonce_b64, kek_version, created_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id, row.scope_type, row.scope_id, row.purpose, row.dek_version,
      row.wrapped_key_b64, row.wrap_nonce_b64, row.kek_version, row.created_at,
      row.retired_at,
    )
    return Object.freeze({ row, scope, statement })
  } catch { fail() }
}

const parseEnvelope = (value) => {
  if (typeof value !== 'string') fail()
  try { return JSON.parse(value) } catch { fail() }
}

const cryptoContext = (context) => {
  const captured = captureExact(context, ['keyring', 'dataKey', 'scope'])
  if (!captured.keyring || !captured.dataKey) fail()
  const scope = assertClientKeyScope(captured.scope)
  const dataKey = captureExact(captured.dataKey, DATA_KEY_KEYS)
  if (dataKey.scope_type !== scope.type
    || dataKey.scope_id !== scope.id
    || dataKey.purpose !== scope.purpose) fail()
  return Object.freeze({ keyring: captured.keyring, dataKey, scope })
}

const serializedEnvelope = async (operation) => JSON.stringify(await operation)

export async function loadClientCryptoContext(db, keyring, input) {
  try {
    if (!db?.prepare || !keyring) fail()
    const captured = captureExact(input, ['clientId', 'envelope'])
    const scope = clientKeyScope(captured.clientId)
    const dataKey = captureExact(await loadDataKey(db, {
      envelope: parseEnvelope(captured.envelope), expectedScope: scope,
    }), DATA_KEY_KEYS)
    return Object.freeze({ keyring, dataKey, scope })
  } catch { fail() }
}

export async function encryptClientIdentity(context, input) {
  try {
    const current = cryptoContext(context)
    const captured = captureExact(input, ['clientId', 'name', 'age'])
    if (captured.clientId !== current.scope.id) fail()
    const identity = assertClientIdentity({ name: captured.name, age: captured.age })
    const plaintext = JSON.stringify({
      schema: 'client.identity.v1', name: identity.name, age: identity.age,
    })
    return await serializedEnvelope(encryptForScope(
      current.keyring,
      current.dataKey,
      {
        expectedScope: current.scope,
        recordId: captured.clientId,
        field: 'identity',
        plaintext,
      },
    ))
  } catch { fail() }
}

export async function decryptClientIdentity(context, input) {
  try {
    const current = cryptoContext(context)
    const captured = captureExact(input, ['clientId', 'envelope'])
    if (captured.clientId !== current.scope.id) fail()
    const plaintext = await decryptForScope(
      current.keyring,
      current.dataKey,
      {
        expectedScope: current.scope,
        recordId: captured.clientId,
        field: 'identity',
        envelope: parseEnvelope(captured.envelope),
      },
    )
    const parsed = JSON.parse(plaintext)
    const identity = captureExact(parsed, ['schema', 'name', 'age'])
    if (identity.schema !== 'client.identity.v1') fail()
    return Object.freeze(assertClientIdentity({ name: identity.name, age: identity.age }))
  } catch { fail() }
}

export async function encryptClientCorrectionReason(context, consumer, input) {
  try {
    const current = cryptoContext(context)
    const captured = captureExact(input, [
      'correctionId', 'appointmentId', 'paymentId', 'reason', 'ownerFact',
    ])
    const owner = verifyPaymentOwnership(consumer, captured.ownerFact)
    if (!isCorrectionId(captured.correctionId)
      || typeof captured.appointmentId !== 'string'
      || !APPOINTMENT_ID.test(captured.appointmentId)
      || typeof captured.paymentId !== 'string'
      || !PAYMENT_ID.test(captured.paymentId)
      || owner.clientId !== current.scope.id
      || owner.appointmentId !== captured.appointmentId
      || owner.paymentId !== captured.paymentId) fail()
    const reason = assertCorrectionReason(captured.reason)
    return await serializedEnvelope(encryptForScope(
      current.keyring,
      current.dataKey,
      {
        expectedScope: current.scope,
        recordId: captured.correctionId,
        field: 'reason',
        plaintext: reason,
      },
    ))
  } catch { fail() }
}

export async function decryptClientCorrectionReason(context, consumer, input) {
  try {
    const current = cryptoContext(context)
    const captured = captureExact(input, [
      'correctionId', 'appointmentId', 'paymentId', 'envelope', 'ownerFact',
    ])
    const owner = verifyPaymentOwnership(consumer, captured.ownerFact)
    if (!isCorrectionId(captured.correctionId)
      || typeof captured.appointmentId !== 'string'
      || !APPOINTMENT_ID.test(captured.appointmentId)
      || typeof captured.paymentId !== 'string'
      || !PAYMENT_ID.test(captured.paymentId)
      || owner.clientId !== current.scope.id
      || owner.appointmentId !== captured.appointmentId
      || owner.paymentId !== captured.paymentId) fail()
    const reason = await decryptForScope(
      current.keyring,
      current.dataKey,
      {
        expectedScope: current.scope,
        recordId: captured.correctionId,
        field: 'reason',
        envelope: parseEnvelope(captured.envelope),
      },
    )
    return assertCorrectionReason(reason)
  } catch { fail() }
}
