import { isSpecialistId } from '../../src/core-records.js'
import { acceptEffectiveCapabilities } from '../../src/capabilities.js'

const ACTOR_KEYS = Object.freeze([
  'id',
  'role',
  'specialistId',
  'version',
  'authorityRevision',
  'capabilities',
])
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ROLES = new Set(['owner', 'coordinator', 'specialist'])

export function captureAuthorityActor(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null

    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== ACTOR_KEYS.length
      || actual.some((key) => typeof key !== 'string' || !ACTOR_KEYS.includes(key))) {
      return null
    }

    const actor = {}
    for (const key of ACTOR_KEYS) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      actor[key] = descriptor.value
    }

    const capabilities = acceptEffectiveCapabilities(actor.role, actor.capabilities)
    if (!STAFF_ID.test(actor.id) || !ROLES.has(actor.role)
      || !Number.isSafeInteger(actor.version) || actor.version < 1
      || !Number.isSafeInteger(actor.authorityRevision) || actor.authorityRevision < 1
      || !capabilities
      || (actor.role === 'specialist'
        ? !isSpecialistId(actor.specialistId)
        : actor.specialistId !== null && !isSpecialistId(actor.specialistId))) return null

    return Object.freeze({
      id: actor.id,
      role: actor.role,
      specialistId: actor.specialistId,
      version: actor.version,
      authorityRevision: actor.authorityRevision,
      capabilities,
    })
  } catch {
    return null
  }
}
