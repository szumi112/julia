import {
  createSpecialistProfile,
  updateSpecialistProfile,
} from '../core/specialist-profiles.js'
import { linkSpecialistAccount } from '../core/specialist-account-links.js'
import { decryptForScope } from '../security/envelope.js'
import { isWellFormedUnicode } from '../../src/core-records.js'

const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const INPUT_KEYS = Object.freeze([
  'appEnv', 'dataMode', 'db', 'recoveryDb', 'keyring', 'nowMs',
])
const DEPENDENCY_KEYS = Object.freeze(['createProfile', 'updateProfile', 'linkAccount'])
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const STAFF_CAP = 128
const PROFILE_CAP = 128
const PROFESSIONAL_TITLE = 'Specjalistka'
const failure = () => { throw new Error('STAGING_SEED_INVALID') }
const emptyResult = () => Object.freeze({ created: 0, updated: 0, linked: 0, confirmed: 0 })

export const STAGING_SPECIALIST_DESIRED_STATE = Object.freeze([
  Object.freeze({
    displayName: 'Anna Janowska',
    id: 'sp_staging_workbook_anna_janowska',
    professionalTitle: PROFESSIONAL_TITLE,
    standardRateGrosze: 18000,
    linkSelector: null,
  }),
  Object.freeze({
    displayName: 'Julia Wolanin',
    id: 'sp_staging_workbook_julia_wolanin',
    professionalTitle: PROFESSIONAL_TITLE,
    standardRateGrosze: 18000,
    linkSelector: Object.freeze({ displayName: 'Julia Wolanin', role: 'owner' }),
  }),
  Object.freeze({
    displayName: 'Justyna J-J',
    id: 'sp_staging_workbook_justyna_j_j',
    professionalTitle: PROFESSIONAL_TITLE,
    standardRateGrosze: 18000,
    linkSelector: null,
  }),
])

const captureExact = (value, keys) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) failure()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) failure()
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) failure()
      captured[key] = descriptor.value
    }
    return Object.freeze(captured)
  } catch (error) {
    if (error?.message === 'STAGING_SEED_INVALID') throw error
    failure()
  }
}

const modeInput = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) failure()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of ['appEnv', 'dataMode']) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) failure()
    }
    return Object.freeze({
      appEnv: descriptors.appEnv.value,
      dataMode: descriptors.dataMode.value,
    })
  } catch (error) {
    if (error?.message === 'STAGING_SEED_INVALID') throw error
    failure()
  }
}

const canonicalName = (value) => {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)
    || /[\p{Cc}\p{Cf}]/u.test(value)) failure()
  const canonical = value.trim().normalize('NFC')
  const encoded = new TextEncoder().encode(canonical)
  const valid = encoded.byteLength >= 1 && encoded.byteLength <= 120
  encoded.fill(0)
  if (!valid) failure()
  return canonical
}

const exactTitle = (value) => {
  if (typeof value !== 'string' || value !== value.trim()
    || value !== value.normalize('NFC') || !isWellFormedUnicode(value)
    || /[\p{Cc}\p{Cf}]/u.test(value)) failure()
  const encoded = new TextEncoder().encode(value)
  const valid = encoded.byteLength >= 1 && encoded.byteLength <= 120
  encoded.fill(0)
  if (!valid) failure()
  return value
}

const loadContext = async (db, keyring) => {
  const dataKey = await db.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
            kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1
       AND retired_at IS NULL`,
  ).bind(SCOPE.type, SCOPE.id, SCOPE.purpose).first()
  if (!dataKey) failure()
  return Object.freeze({ keyring, dataKey })
}

const decrypt = async (context, recordId, field, serialized) => {
  try {
    return await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: SCOPE,
      recordId,
      field,
      envelope: JSON.parse(serialized),
    })
  } catch {
    failure()
  }
}

const loadDirectory = async (db, context) => {
  const [staffResult, profileResult] = await Promise.all([
    db.prepare(
      `SELECT id,display_name_envelope,role,status,specialist_id,version
       FROM staff_users ORDER BY id LIMIT ?`,
    ).bind(STAFF_CAP + 1).all(),
    db.prepare(
      `SELECT id,staff_user_id,display_name_envelope,professional_title_envelope,
              standard_rate_grosze,status,version,archived_at,created_at,updated_at
       FROM specialists ORDER BY id LIMIT ?`,
    ).bind(PROFILE_CAP + 1).all(),
  ])
  const staffRows = staffResult?.results
  const profileRows = profileResult?.results
  if (!Array.isArray(staffRows) || staffRows.length > STAFF_CAP
    || !Array.isArray(profileRows) || profileRows.length > PROFILE_CAP) failure()

  const staff = []
  for (const row of staffRows) {
    if (!STAFF_ID.test(row.id ?? '')
      || !['owner', 'coordinator', 'specialist'].includes(row.role)
      || !['pending', 'active', 'disabled'].includes(row.status)
      || (row.specialist_id !== null && !SPECIALIST_ID.test(row.specialist_id ?? ''))
      || !Number.isSafeInteger(row.version) || row.version < 1
      || typeof row.display_name_envelope !== 'string'
      || row.display_name_envelope.length < 1) failure()
    const displayName = await decrypt(
      context,
      row.id,
      'display_name',
      row.display_name_envelope,
    )
    staff.push(Object.freeze({
      id: row.id,
      displayName,
      canonicalName: canonicalName(displayName),
      role: row.role,
      status: row.status,
      specialistId: row.specialist_id,
      version: row.version,
    }))
  }

  const profiles = []
  for (const row of profileRows) {
    if (!SPECIALIST_ID.test(row.id ?? '')
      || (row.staff_user_id !== null && !STAFF_ID.test(row.staff_user_id ?? ''))
      || typeof row.display_name_envelope !== 'string'
      || row.display_name_envelope.length < 1
      || (row.professional_title_envelope !== null
        && (typeof row.professional_title_envelope !== 'string'
          || row.professional_title_envelope.length < 1))
      || !Number.isSafeInteger(row.standard_rate_grosze)
      || row.standard_rate_grosze < 1 || row.standard_rate_grosze > 1_000_000
      || !['pending', 'active', 'archived'].includes(row.status)
      || !Number.isSafeInteger(row.version) || row.version < 1
      || (row.status === 'archived') !== (row.archived_at !== null)) failure()
    const displayName = await decrypt(
      context,
      row.id,
      'display_name',
      row.display_name_envelope,
    )
    const legacyTitle = row.professional_title_envelope === null
    const professionalTitle = legacyTitle
      ? PROFESSIONAL_TITLE
      : exactTitle(await decrypt(
          context,
          row.id,
          'professional_title',
          row.professional_title_envelope,
        ))
    profiles.push(Object.freeze({
      id: row.id,
      staffUserId: row.staff_user_id,
      displayName,
      canonicalName: canonicalName(displayName),
      professionalTitle,
      legacyTitle,
      standardRateGrosze: row.standard_rate_grosze,
      status: row.status,
      version: row.version,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }
  return Object.freeze({ staff: Object.freeze(staff), profiles: Object.freeze(profiles) })
}

const linkedDesiredProfile = () => {
  const linked = STAGING_SPECIALIST_DESIRED_STATE.filter((desired) => (
    desired.linkSelector !== null
  ))
  if (linked.length !== 1) failure()
  return linked[0]
}

const exactManagedAccount = (directory, desired) => {
  const selector = desired.linkSelector
  if (!selector) failure()
  const candidates = directory.staff.filter((staff) => (
    staff.role === selector.role
    && staff.status === 'active'
    && staff.canonicalName === selector.displayName
  ))
  if (candidates.length !== 1) failure()
  return candidates[0]
}

const resolveProfile = (directory, desired) => {
  const byId = directory.profiles.find((profile) => profile.id === desired.id) ?? null
  const byName = directory.profiles.filter((profile) => (
    profile.canonicalName === desired.displayName
  ))
  if (byName.length > 1
    || (byId && byId.canonicalName !== desired.displayName)
    || (byId && byName[0] && byId.id !== byName[0].id)) failure()
  const profile = byId ?? byName[0] ?? null
  if (profile && (profile.status === 'archived' || profile.archivedAt !== null)) failure()
  return profile
}

const currentClaim = (directory, profile) => {
  const pointingStaff = directory.staff.filter((staff) => staff.specialistId === profile.id)
  if (profile.staffUserId === null) {
    if (pointingStaff.length !== 0 || profile.status !== 'active') failure()
    return null
  }
  if (pointingStaff.length !== 1 || pointingStaff[0].id !== profile.staffUserId) failure()
  const staff = pointingStaff[0]
  const statusesMatch = (profile.status === 'pending' && staff.status === 'pending')
    || (profile.status === 'active' && staff.status === 'active')
  if (!statusesMatch) failure()
  return staff
}

const ownerActor = (staff) => Object.freeze({
  id: staff.id,
  role: staff.role,
  specialistId: staff.specialistId,
  version: staff.version,
})

const idFactoryForCreate = (profileId) => {
  let first = true
  return () => {
    if (first) {
      first = false
      return profileId.slice(3)
    }
    return crypto.randomUUID().replaceAll('-', '')
  }
}

const randomIdFactory = () => crypto.randomUUID().replaceAll('-', '')

const finalVerification = async (db, context) => {
  const directory = await loadDirectory(db, context)
  const juliaDesired = linkedDesiredProfile()
  const julia = exactManagedAccount(directory, juliaDesired)
  let juliaProfile = null
  for (const desired of STAGING_SPECIALIST_DESIRED_STATE) {
    const profile = resolveProfile(directory, desired)
    if (!profile || profile.displayName !== desired.displayName
      || profile.legacyTitle || profile.professionalTitle !== desired.professionalTitle
      || profile.standardRateGrosze !== desired.standardRateGrosze) failure()
    const claim = currentClaim(directory, profile)
    if (desired.linkSelector) {
      if (profile.status !== 'active' || claim?.id !== julia.id
        || julia.specialistId !== profile.id) failure()
      juliaProfile = profile
    }
  }
  if (!juliaProfile) failure()
}

export function createStagingSpecialistMaterializer(value) {
  const dependencies = captureExact(value, DEPENDENCY_KEYS)
  if (DEPENDENCY_KEYS.some((key) => typeof dependencies[key] !== 'function')) failure()

  return async (rawInput) => {
    const mode = modeInput(rawInput)
    if (mode.appEnv !== 'staging' || mode.dataMode !== 'fictional') return emptyResult()
    const input = captureExact(rawInput, INPUT_KEYS)
    if (!input.db?.prepare || !input.db?.batch || !input.recoveryDb?.prepare
      || !input.keyring || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) failure()
    const context = await loadContext(input.db, input.keyring)
    const directory = await loadDirectory(input.db, context)
    const juliaDesired = linkedDesiredProfile()
    const julia = exactManagedAccount(directory, juliaDesired)
    const actor = ownerActor(julia)
    const counts = { created: 0, updated: 0, linked: 0, confirmed: 0 }
    const resolved = new Map()
    const initialProfiles = new Map()

    for (const desired of STAGING_SPECIALIST_DESIRED_STATE) {
      const profile = resolveProfile(directory, desired)
      if (profile) currentClaim(directory, profile)
      initialProfiles.set(desired.id, profile)
    }
    const initialJuliaProfile = initialProfiles.get(juliaDesired.id)
    const initialJuliaClaim = initialJuliaProfile
      ? currentClaim(directory, initialJuliaProfile)
      : null
    if ((initialJuliaClaim && (initialJuliaClaim.id !== julia.id
      || julia.specialistId !== initialJuliaProfile.id))
      || (!initialJuliaClaim && julia.specialistId !== null)) failure()

    for (const [index, desired] of STAGING_SPECIALIST_DESIRED_STATE.entries()) {
      let profile = initialProfiles.get(desired.id)
      if (!profile) {
        await dependencies.createProfile({
          db: input.db,
          recoveryDb: input.recoveryDb,
          actor,
          keyring: input.keyring,
          nowMs: input.nowMs,
          correlationId: crypto.randomUUID(),
          idFactory: idFactoryForCreate(desired.id),
          body: {
            displayName: desired.displayName,
            professionalTitle: desired.professionalTitle,
            standardRateGrosze: desired.standardRateGrosze,
          },
          idempotencyKey: `staging-specialist-create-${index + 1}-v1`,
        })
        counts.created += 1
        profile = Object.freeze({
          id: desired.id,
          staffUserId: null,
          displayName: desired.displayName,
          canonicalName: desired.displayName,
          professionalTitle: desired.professionalTitle,
          legacyTitle: false,
          standardRateGrosze: desired.standardRateGrosze,
          status: 'active',
          version: 1,
          archivedAt: null,
        })
      } else {
        const needsUpdate = profile.displayName !== desired.displayName
          || profile.legacyTitle
          || profile.professionalTitle !== desired.professionalTitle
          || profile.standardRateGrosze !== desired.standardRateGrosze
        if (needsUpdate) {
          await dependencies.updateProfile({
            db: input.db,
            recoveryDb: input.recoveryDb,
            actor,
            keyring: input.keyring,
            nowMs: input.nowMs,
            correlationId: crypto.randomUUID(),
            idFactory: randomIdFactory,
            specialistId: profile.id,
            body: {
              expectedVersion: profile.version,
              displayName: desired.displayName,
              professionalTitle: desired.professionalTitle,
              standardRateGrosze: desired.standardRateGrosze,
            },
            idempotencyKey: `staging-specialist-update-${index + 1}-v${profile.version}`,
          })
          counts.updated += 1
          profile = Object.freeze({
            ...profile,
            displayName: desired.displayName,
            canonicalName: desired.displayName,
            professionalTitle: desired.professionalTitle,
            legacyTitle: false,
            standardRateGrosze: desired.standardRateGrosze,
            version: profile.version + 1,
          })
        } else {
          counts.confirmed += 1
        }
      }
      resolved.set(desired.id, profile)
    }

    const juliaProfile = resolved.get(juliaDesired.id)
    if (initialJuliaClaim) {
      counts.confirmed += 1
    } else {
      if (julia.specialistId !== null || juliaProfile.status !== 'active') failure()
      await dependencies.linkAccount({
        db: input.db,
        recoveryDb: input.recoveryDb,
        actor,
        keyring: input.keyring,
        nowMs: input.nowMs,
        correlationId: crypto.randomUUID(),
        idFactory: randomIdFactory,
        specialistId: juliaProfile.id,
        body: {
          staffId: julia.id,
          expectedSpecialistVersion: juliaProfile.version,
          expectedStaffVersion: julia.version,
        },
        idempotencyKey: `staging-specialist-link-2-s${juliaProfile.version}-u${julia.version}`,
      })
      counts.linked += 1
    }
    await finalVerification(input.db, context)
    return Object.freeze(counts)
  }
}

export const materializeStagingSpecialists = createStagingSpecialistMaterializer({
  createProfile: createSpecialistProfile,
  updateProfile: updateSpecialistProfile,
  linkAccount: linkSpecialistAccount,
})
