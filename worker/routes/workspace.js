import { parseWorkspaceQuery, readWorkspace } from '../core/workspace.js'
import { captureAuthorityActor } from '../identity/authority-actor.js'

const invalid = () => { throw new Error('INTERNAL_ERROR') }
const WORKSPACE_CAPABILITIES = Object.freeze([
  'appointment.charge.read',
  'client.operational.read',
  'specialist.directory.read',
])

const captureExact = (value, keys) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid()
    const captured = Object.create(null)
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
      captured[key] = descriptor.value
    }
    return captured
  } catch { invalid() }
}

export async function getWorkspace(input) {
  let descriptors
  try { descriptors = Object.getOwnPropertyDescriptors(input) } catch { invalid() }
  const keys = Reflect.ownKeys(descriptors)
  const expected = keys.includes('read')
    ? ['db', 'actor', 'cryptoContext', 'url', 'read']
    : ['db', 'actor', 'cryptoContext', 'url']
  const captured = captureExact(input, expected)
  if (typeof captured.url !== 'string') invalid()
  const read = captured.read ?? readWorkspace
  if (typeof read !== 'function') invalid()
  const actor = captureAuthorityActor(captured.actor)
  if (!actor || !WORKSPACE_CAPABILITIES.every((capability) => actor.capabilities.includes(capability))) {
    invalid()
  }
  return read({
    db: captured.db,
    actor,
    cryptoContext: captured.cryptoContext,
    window: parseWorkspaceQuery(captured.url),
  })
}
