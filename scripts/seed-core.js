import {
  blindEmailIndex,
  createWrappedDataKey,
  decryptForScope,
  encryptForScope,
} from '../worker/security/envelope.js'

const EMPTY_FINGERPRINT = 'BYDlKyUUBNO-3cX7_bRPY-TkArudTPGjIdbwtAdLSCw'
const RELEASED_LEASE = '{"expiresAt":null,"nonce":null,"owner":null}'
const CORRELATION_ID = 'local_seed_v1'
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export const LOCAL_SEED_MANIFEST = deepFreeze({
  createdAt: '2026-07-30T00:00:00.000Z',
  dataKeyId: 'key_local_staff_directory_v1',
  scope: {
    id: 'centre_1',
    purpose: 'identity',
    type: 'staff_directory',
  },
  staff: [
    {
      displayName: 'Celina Testowa',
      email: 'coordinator@example.test',
      id: 'stf_local_coordinator',
      role: 'coordinator',
      snapshotId: 'ver_local_coordinator_v1',
      specialistId: null,
    },
    {
      displayName: 'Alicja Testowa',
      email: 'owner@example.test',
      id: 'stf_local_owner',
      role: 'owner',
      snapshotId: 'ver_local_owner_v1',
      specialistId: null,
    },
    {
      displayName: 'Zofia Fikcyjna',
      email: 'specialist@example.test',
      id: 'stf_local_specialist',
      role: 'specialist',
      snapshotId: 'ver_local_specialist_v1',
      specialistId: 'sp_local_specialist',
      specialistSnapshotId: 'ver_local_specialist_profile_v1',
    },
  ],
})

const DATA_KEY_COLUMNS = Object.freeze([
  'id',
  'scope_type',
  'scope_id',
  'purpose',
  'dek_version',
  'wrapped_key_b64',
  'wrap_nonce_b64',
  'kek_version',
  'created_at',
  'retired_at',
])
const STAFF_COLUMNS = Object.freeze([
  'id',
  'email_lookup',
  'email_envelope',
  'display_name_envelope',
  'role',
  'status',
  'access_subject',
  'specialist_id',
  'version',
  'activated_at',
  'disabled_at',
  'created_at',
  'updated_at',
])
const VERSION_COLUMNS = Object.freeze([
  'id',
  'entity_type',
  'entity_id',
  'version',
  'snapshot_envelope',
  'changed_by_staff_id',
  'changed_at',
  'correlation_id',
])
const SPECIALIST_COLUMNS = Object.freeze([
  'id',
  'staff_user_id',
  'standard_rate_grosze',
  'status',
  'version',
  'archived_at',
  'created_at',
  'updated_at',
])
const EMPTY_TABLES = Object.freeze([
  'audit_events',
  'backup_runs',
  'client_assignments',
  'clients',
  'delivery_attempts',
  'idempotency_records',
  'operational_actions',
  'outbox_attempts',
  'outbox_jobs',
  'scheduler_runs',
  'staff_invitations',
])
export const LOCAL_SEED_SNAPSHOT_QUERIES = deepFreeze([
  'SELECT * FROM data_keys ORDER BY id',
  `SELECT
     id,email_lookup,email_envelope,display_name_envelope,role,status,
     hex(access_subject) AS access_subject_hex,specialist_id,version,activated_at,
     disabled_at,created_at,updated_at
   FROM staff_users ORDER BY id`,
  'SELECT * FROM record_versions ORDER BY entity_type,entity_id,version,id',
  'SELECT * FROM system_state ORDER BY key',
  'SELECT * FROM specialists ORDER BY id',
  ...EMPTY_TABLES.map((table) => `SELECT * FROM ${table} ORDER BY rowid`),
])
const GENESIS_STATES = Object.freeze([
  Object.freeze({
    key: 'access.applied_generation',
    updated_at: '2026-07-30T00:00:00.000Z',
    value_json: JSON.stringify({
      fingerprint: EMPTY_FINGERPRINT,
      generation: 0,
    }),
    version: 1,
  }),
  Object.freeze({
    key: 'access.desired_generation',
    updated_at: '2026-07-30T00:00:00.000Z',
    value_json: '{"generation":0}',
    version: 1,
  }),
  Object.freeze({
    key: 'access.reconcile.lease',
    updated_at: '2026-07-30T00:00:00.000Z',
    value_json: RELEASED_LEASE,
    version: 1,
  }),
])
const OUTBOX_DRAIN_HEARTBEAT = Object.freeze({
  key: 'outbox.drain.last_success',
  value_json: '{"completedAt":null}',
  version: 1,
})
const CORE_DIRECTORY_UPGRADE = Object.freeze({
  key: 'core_directory_specialist_backfill_v1',
  value_json: '{"afterStaffId":null,"createdCount":0,"processedCount":0,"status":"pending"}',
  version: 1,
})
const SYSTEM_STATE_COUNT = GENESIS_STATES.length + 2

const ownObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const sameRow = (actual, expected) => ownObject(actual)
  && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => Object.is(actual[key], value))
const validInstant = (value) => {
  try {
    return typeof value === 'string'
      && INSTANT.test(value)
      && !Number.isNaN(Date.parse(value))
      && new Date(value).toISOString() === value
  } catch {
    return false
  }
}
const exactGenesisStates = (states) => Array.isArray(states)
  && states.length === SYSTEM_STATE_COUNT
  && GENESIS_STATES.every((row, index) => sameRow(states[index], row))
  && exactKeys(states[GENESIS_STATES.length], ['key', 'value_json', 'version', 'updated_at'])
  && states[GENESIS_STATES.length].key === CORE_DIRECTORY_UPGRADE.key
  && states[GENESIS_STATES.length].value_json === CORE_DIRECTORY_UPGRADE.value_json
  && states[GENESIS_STATES.length].version === CORE_DIRECTORY_UPGRADE.version
  && validInstant(states[GENESIS_STATES.length].updated_at)
  && exactKeys(states[GENESIS_STATES.length + 1], ['key', 'value_json', 'version', 'updated_at'])
  && states[GENESIS_STATES.length + 1].key === OUTBOX_DRAIN_HEARTBEAT.key
  && states[GENESIS_STATES.length + 1].value_json === OUTBOX_DRAIN_HEARTBEAT.value_json
  && states[GENESIS_STATES.length + 1].version === OUTBOX_DRAIN_HEARTBEAT.version
  && validInstant(states[GENESIS_STATES.length + 1].updated_at)
const statement = (sql, params = []) => Object.freeze({
  params: Object.freeze([...params]),
  sql: sql.trim(),
})
const encrypted = async (keyring, dataKey, recordId, field, plaintext) => JSON.stringify(
  await encryptForScope(
    keyring,
    dataKey,
    {
      expectedScope: LOCAL_SEED_MANIFEST.scope,
      field,
      plaintext,
      recordId,
    },
  ),
)

export async function buildLocalSeedBatch({ keyring, keyringConfig } = {}) {
  if (!keyring
    || !exactKeys(keyringConfig, [
      'activeBackupKekVersion',
      'activeDataKekVersion',
      'activeLookupKeyVersion',
    ])
    || Object.values(keyringConfig).some((version) => version !== 1)) {
    throw new Error('SEED_LOCAL_BUILD_INVALID')
  }
  const dataKey = await createWrappedDataKey(keyring, {
    createdAt: LOCAL_SEED_MANIFEST.createdAt,
    dekVersion: 1,
    id: LOCAL_SEED_MANIFEST.dataKeyId,
    scope: LOCAL_SEED_MANIFEST.scope,
  })
  const staffRows = []
  const versionRows = []
  let specialistRow = null
  for (const staff of LOCAL_SEED_MANIFEST.staff) {
    const row = {
      access_subject: `local:${staff.email}`,
      activated_at: LOCAL_SEED_MANIFEST.createdAt,
      created_at: LOCAL_SEED_MANIFEST.createdAt,
      disabled_at: null,
      display_name_envelope: await encrypted(
        keyring,
        dataKey,
        staff.id,
        'display_name',
        staff.displayName,
      ),
      email_envelope: await encrypted(
        keyring,
        dataKey,
        staff.id,
        'email',
        staff.email,
      ),
      email_lookup: await blindEmailIndex(staff.email, keyring, 1),
      id: staff.id,
      role: staff.role,
      specialist_id: staff.specialistId,
      status: 'active',
      updated_at: LOCAL_SEED_MANIFEST.createdAt,
      version: 1,
    }
    staffRows.push(row)
    versionRows.push({
      changed_at: LOCAL_SEED_MANIFEST.createdAt,
      changed_by_staff_id: null,
      correlation_id: CORRELATION_ID,
      entity_id: row.id,
      entity_type: 'staff_user',
      id: staff.snapshotId,
      snapshot_envelope: await encrypted(
        keyring,
        dataKey,
        row.id,
        'record_version',
        JSON.stringify(row),
      ),
      version: 1,
    })
    if (staff.specialistId !== null) {
      specialistRow = {
        archived_at: null,
        created_at: LOCAL_SEED_MANIFEST.createdAt,
        id: staff.specialistId,
        staff_user_id: staff.id,
        standard_rate_grosze: 18000,
        status: 'active',
        updated_at: LOCAL_SEED_MANIFEST.createdAt,
        version: 1,
      }
      versionRows.push({
        changed_at: LOCAL_SEED_MANIFEST.createdAt,
        changed_by_staff_id: null,
        correlation_id: CORRELATION_ID,
        entity_id: specialistRow.id,
        entity_type: 'specialist',
        id: staff.specialistSnapshotId,
        snapshot_envelope: await encrypted(
          keyring,
          dataKey,
          specialistRow.id,
          'record_version',
          JSON.stringify({
            archivedAt: null,
            createdAt: specialistRow.created_at,
            id: specialistRow.id,
            schema: 'specialist.v1',
            staffUserId: specialistRow.staff_user_id,
            standardRateGrosze: specialistRow.standard_rate_grosze,
            status: specialistRow.status,
            updatedAt: specialistRow.updated_at,
            version: specialistRow.version,
          }),
        ),
        version: 1,
      })
    }
  }
  if (!specialistRow) throw new Error('SEED_LOCAL_BUILD_INVALID')

  const emptyPredicates = [
    'data_keys',
    'staff_users',
    'specialists',
    'record_versions',
    ...EMPTY_TABLES,
  ].map((table) => `NOT EXISTS (SELECT 1 FROM ${table})`).join('\n         AND ')
  const batch = [
    statement(
      `INSERT INTO data_keys
       (id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
        kek_version,created_at,retired_at)
       SELECT ?,?,?,?,1,?,?,1,?,NULL
       WHERE ${emptyPredicates}`,
      [
        dataKey.id,
        dataKey.scope_type,
        dataKey.scope_id,
        dataKey.purpose,
        dataKey.wrapped_key_b64,
        dataKey.wrap_nonce_b64,
        dataKey.created_at,
      ],
    ),
    statement(
      `INSERT INTO specialists
       (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
       SELECT ?,?,18000,'active',1,NULL,?,?
       WHERE changes()=1`,
      [
        specialistRow.id,
        specialistRow.staff_user_id,
        specialistRow.created_at,
        specialistRow.updated_at,
      ],
    ),
  ]
  for (const row of staffRows) {
    const specialistSql = row.specialist_id === null ? 'NULL' : '?'
    batch.push(statement(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,
        access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at)
       SELECT ?,?,?,?,?,'active',?,${specialistSql},1,?,NULL,?,?
       WHERE changes()=1
         AND EXISTS (
           SELECT 1 FROM data_keys
           WHERE id=? AND scope_type='staff_directory' AND scope_id='centre_1'
             AND purpose='identity' AND dek_version=1 AND kek_version=1
         )`,
      [
        row.id,
        row.email_lookup,
        row.email_envelope,
        row.display_name_envelope,
        row.role,
        row.access_subject,
        ...(row.specialist_id === null ? [] : [row.specialist_id]),
        row.activated_at,
        row.created_at,
        row.updated_at,
        dataKey.id,
      ],
    ))
  }
  for (const row of versionRows) {
    const table = row.entity_type === 'specialist' ? 'specialists' : 'staff_users'
    batch.push(statement(
      `INSERT INTO record_versions
       (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
        changed_at,correlation_id)
       SELECT ?,?,?,1,?,NULL,?,?
       WHERE changes()=1
         AND EXISTS (
           SELECT 1 FROM ${table}
           WHERE id=? AND status='active' AND version=1
         )`,
      [
        row.id,
        row.entity_type,
        row.entity_id,
        row.snapshot_envelope,
        row.changed_at,
        row.correlation_id,
        row.entity_id,
      ],
    ))
  }

  const guardPredicates = [
    'changes()=1',
    '(SELECT count(*) FROM data_keys)=1',
    `(SELECT count(*) FROM staff_users)=${staffRows.length}`,
    `(SELECT count(*) FROM record_versions)=${versionRows.length}`,
    '(SELECT count(*) FROM specialists)=1',
    `(SELECT count(*) FROM system_state)=${SYSTEM_STATE_COUNT}`,
    ...EMPTY_TABLES.map((table) => `(SELECT count(*) FROM ${table})=0`),
    `EXISTS (
       SELECT 1 FROM data_keys
       WHERE id=? AND scope_type=? AND scope_id=? AND purpose=?
         AND dek_version=1 AND wrapped_key_b64=? AND wrap_nonce_b64=?
         AND kek_version=1 AND created_at=? AND retired_at IS NULL
     )`,
    ...staffRows.map((row) => `EXISTS (
       SELECT 1 FROM staff_users
       WHERE id=? AND email_lookup=? AND email_envelope=? AND display_name_envelope=?
         AND role=? AND status='active' AND access_subject=?
         AND specialist_id IS ${row.specialist_id === null ? 'NULL' : '?'}
         AND version=1 AND activated_at=? AND disabled_at IS NULL
         AND created_at=? AND updated_at=?
     )`),
    `EXISTS (
       SELECT 1 FROM specialists
       WHERE id=? AND staff_user_id=? AND standard_rate_grosze=18000
         AND status='active' AND version=1 AND archived_at IS NULL
         AND created_at=? AND updated_at=?
     )`,
    ...versionRows.map(() => `EXISTS (
       SELECT 1 FROM record_versions
       WHERE id=? AND entity_type=? AND entity_id=? AND version=1
         AND snapshot_envelope=? AND changed_by_staff_id IS NULL
         AND changed_at=? AND correlation_id=?
     )`),
    ...GENESIS_STATES.map(() => `EXISTS (
       SELECT 1 FROM system_state
       WHERE key=? AND value_json=? AND version=1 AND updated_at=?
     )`),
    `EXISTS (
       SELECT 1 FROM system_state
       WHERE key=? AND value_json=? AND version=1
         AND updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at))
     )`,
    `EXISTS (
       SELECT 1 FROM system_state
       WHERE key=? AND value_json=? AND version=1
         AND updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at))
     )`,
  ]
  const guardParams = [
    dataKey.id,
    dataKey.scope_type,
    dataKey.scope_id,
    dataKey.purpose,
    dataKey.wrapped_key_b64,
    dataKey.wrap_nonce_b64,
    dataKey.created_at,
    ...staffRows.flatMap((row) => [
      row.id,
      row.email_lookup,
      row.email_envelope,
      row.display_name_envelope,
      row.role,
      row.access_subject,
      ...(row.specialist_id === null ? [] : [row.specialist_id]),
      row.activated_at,
      row.created_at,
      row.updated_at,
    ]),
    specialistRow.id,
    specialistRow.staff_user_id,
    specialistRow.created_at,
    specialistRow.updated_at,
    ...versionRows.flatMap((row) => [
      row.id,
      row.entity_type,
      row.entity_id,
      row.snapshot_envelope,
      row.changed_at,
      row.correlation_id,
    ]),
    ...GENESIS_STATES.flatMap((row) => [
      row.key,
      row.value_json,
      row.updated_at,
    ]),
    CORE_DIRECTORY_UPGRADE.key,
    CORE_DIRECTORY_UPGRADE.value_json,
    OUTBOX_DRAIN_HEARTBEAT.key,
    OUTBOX_DRAIN_HEARTBEAT.value_json,
  ]
  batch.push(statement(
    `INSERT INTO outbox_operation_guard_failures (operation_id)
     SELECT 'local_seed_guard'
     WHERE NOT (
       ${guardPredicates.join('\n       AND ')}
     )`,
    guardParams,
  ))
  if (batch.length !== 10
    || batch.some(({ params }) => params.some((value) => typeof value !== 'string'))) {
    throw new Error('SEED_LOCAL_BUILD_INVALID')
  }
  return Object.freeze({
    batch: Object.freeze(batch),
  })
}

const snapshot = async (db) => {
  const results = await db.batch(LOCAL_SEED_SNAPSHOT_QUERIES.map((sql) => (
    db.prepare(sql)
  )))
  if (!Array.isArray(results)
    || results.length !== LOCAL_SEED_SNAPSHOT_QUERIES.length
    || results.some((result) => !Array.isArray(result?.results))) {
    throw new Error('SEED_LOCAL_STATE_INVALID')
  }
  return results.map(({ results: rows }, index) => index === 1
    ? rows.map((row) => {
        if (!exactKeys(row, [
          ...STAFF_COLUMNS.filter((column) => column !== 'access_subject'),
          'access_subject_hex',
        ]) || typeof row.access_subject_hex !== 'string'
          || row.access_subject_hex.length % 2 !== 0
          || !/^[0-9A-F]*$/.test(row.access_subject_hex)) {
          throw new Error('SEED_LOCAL_STATE_INVALID')
        }
        const bytes = new Uint8Array(row.access_subject_hex.length / 2)
        try {
          for (let offset = 0; offset < bytes.length; offset += 1) {
            bytes[offset] = Number.parseInt(
              row.access_subject_hex.slice(offset * 2, (offset * 2) + 2),
              16,
            )
          }
          const { access_subject_hex: ignored, ...rest } = row
          return { ...rest, access_subject: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        } finally {
          bytes.fill(0)
        }
      })
    : rows)
}

const decrypt = (keyring, dataKey, recordId, field, serialized) => decryptForScope(
  keyring,
  dataKey,
  {
    expectedScope: LOCAL_SEED_MANIFEST.scope,
    envelope: JSON.parse(serialized),
    field,
    recordId,
  },
)

export async function inspectLocalSeedState({ db, keyring } = {}) {
  if (!db?.prepare || !db?.batch || !keyring) {
    return Object.freeze({ kind: 'refused' })
  }
  try {
    const [dataKeys, staffRows, versions, states, specialistRows, ...emptyTables] = await snapshot(db)
    const genesis = exactGenesisStates(states)
    if (dataKeys.length === 0
      && staffRows.length === 0
      && versions.length === 0
      && specialistRows.length === 0
      && emptyTables.every((rows) => rows.length === 0)
      && genesis) return Object.freeze({ kind: 'empty' })
    if (dataKeys.length !== 1
      || staffRows.length !== LOCAL_SEED_MANIFEST.staff.length
      || versions.length !== LOCAL_SEED_MANIFEST.staff.length + 1
      || specialistRows.length !== 1
      || emptyTables.some((rows) => rows.length !== 0)
      || !genesis) return Object.freeze({ kind: 'refused' })
    const dataKey = dataKeys[0]
    if (!exactKeys(dataKey, DATA_KEY_COLUMNS)
      || dataKey.id !== LOCAL_SEED_MANIFEST.dataKeyId
      || dataKey.scope_type !== LOCAL_SEED_MANIFEST.scope.type
      || dataKey.scope_id !== LOCAL_SEED_MANIFEST.scope.id
      || dataKey.purpose !== LOCAL_SEED_MANIFEST.scope.purpose
      || dataKey.dek_version !== 1
      || dataKey.kek_version !== 1
      || dataKey.created_at !== LOCAL_SEED_MANIFEST.createdAt
      || dataKey.retired_at !== null) return Object.freeze({ kind: 'refused' })
    for (const manifest of LOCAL_SEED_MANIFEST.staff) {
      const row = staffRows.find(({ id }) => id === manifest.id)
      const version = versions.find(({ id }) => id === manifest.snapshotId)
      if (!exactKeys(row, STAFF_COLUMNS)
        || !exactKeys(version, VERSION_COLUMNS)
        || row.email_lookup !== await blindEmailIndex(manifest.email, keyring, 1)
        || row.role !== manifest.role
        || row.status !== 'active'
        || row.access_subject !== `local:${manifest.email}`
        || row.specialist_id !== manifest.specialistId
        || row.version !== 1
        || row.activated_at !== LOCAL_SEED_MANIFEST.createdAt
        || row.disabled_at !== null
        || row.created_at !== LOCAL_SEED_MANIFEST.createdAt
        || row.updated_at !== LOCAL_SEED_MANIFEST.createdAt
        || version.entity_type !== 'staff_user'
        || version.entity_id !== row.id
        || version.version !== 1
        || version.changed_by_staff_id !== null
        || version.changed_at !== LOCAL_SEED_MANIFEST.createdAt
        || version.correlation_id !== CORRELATION_ID
        || await decrypt(keyring, dataKey, row.id, 'email', row.email_envelope)
          !== manifest.email
        || await decrypt(
          keyring,
          dataKey,
          row.id,
          'display_name',
          row.display_name_envelope,
        ) !== manifest.displayName
        || !sameRow(
          JSON.parse(await decrypt(
            keyring,
            dataKey,
            row.id,
            'record_version',
            version.snapshot_envelope,
          )),
          row,
        )) return Object.freeze({ kind: 'refused' })
    }
    const specialistManifest = LOCAL_SEED_MANIFEST.staff.find(
      ({ specialistId }) => specialistId !== null,
    )
    const specialist = specialistRows[0]
    const specialistVersion = versions.find(
      ({ id }) => id === specialistManifest?.specialistSnapshotId,
    )
    if (!specialistManifest
      || !exactKeys(specialist, SPECIALIST_COLUMNS)
      || !exactKeys(specialistVersion, VERSION_COLUMNS)
      || specialist.id !== specialistManifest.specialistId
      || specialist.staff_user_id !== specialistManifest.id
      || specialist.standard_rate_grosze !== 18000
      || specialist.status !== 'active'
      || specialist.version !== 1
      || specialist.archived_at !== null
      || specialist.created_at !== LOCAL_SEED_MANIFEST.createdAt
      || specialist.updated_at !== LOCAL_SEED_MANIFEST.createdAt
      || specialistVersion.entity_type !== 'specialist'
      || specialistVersion.entity_id !== specialist.id
      || specialistVersion.version !== 1
      || specialistVersion.changed_by_staff_id !== null
      || specialistVersion.changed_at !== LOCAL_SEED_MANIFEST.createdAt
      || specialistVersion.correlation_id !== CORRELATION_ID
      || !sameRow(
        JSON.parse(await decrypt(
          keyring,
          dataKey,
          specialist.id,
          'record_version',
          specialistVersion.snapshot_envelope,
        )),
        {
          archivedAt: null,
          createdAt: specialist.created_at,
          id: specialist.id,
          schema: 'specialist.v1',
          staffUserId: specialist.staff_user_id,
          standardRateGrosze: specialist.standard_rate_grosze,
          status: specialist.status,
          updatedAt: specialist.updated_at,
          version: specialist.version,
        },
      )) return Object.freeze({ kind: 'refused' })
    return Object.freeze({ kind: 'seeded' })
  } catch {
    return Object.freeze({ kind: 'refused' })
  }
}

const sqlText = (value) => {
  const bytes = new TextEncoder().encode(value)
  try {
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    return `CAST(X'${hex}' AS TEXT)`
  } finally {
    bytes.fill(0)
  }
}

export function serializeLocalSeedBatch(batch) {
  if (!Array.isArray(batch) || batch.length !== 10) {
    throw new Error('SEED_LOCAL_BUILD_INVALID')
  }
  return `${batch.map((descriptor) => {
    if (!exactKeys(descriptor, ['params', 'sql'])
      || typeof descriptor.sql !== 'string'
      || !Array.isArray(descriptor.params)
      || descriptor.params.some((value) => typeof value !== 'string')) {
      throw new Error('SEED_LOCAL_BUILD_INVALID')
    }
    let index = 0
    const sql = descriptor.sql.replaceAll('?', () => {
      if (index >= descriptor.params.length) throw new Error('SEED_LOCAL_BUILD_INVALID')
      const literal = sqlText(descriptor.params[index])
      index += 1
      return literal
    })
    if (index !== descriptor.params.length) throw new Error('SEED_LOCAL_BUILD_INVALID')
    return `${sql};`
  }).join('\n')}\n`
}
