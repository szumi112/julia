import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createDemandBackupStore,
  createPinnedSourceRunner,
  createS3BackupArchive,
  createStagingBackup,
  migrationEvidence,
  statusStagingBackup,
  stagingMigrationStatus,
  validateStagingBackupConfig,
} from '../../scripts/backup-staging-lib.mjs'

const config = JSON.parse(readFileSync(new URL('../../wrangler.json', import.meta.url), 'utf8'))
const environment = Object.freeze({ APP_ENV: 'staging', DATA_MODE: 'fictional' })

test('staging backup configuration derives one non-production D1/R2 source identity without target flags', () => {
  const selected = validateStagingBackupConfig({ config, environment })
  assert.deepEqual(selected.source, {
    accountId: config.env.staging.vars.CF_ACCOUNT_ID,
    appEnv: 'staging',
    dataMode: 'fictional',
    databaseId: config.env.staging.d1_databases[0].database_id,
  })
  assert.deepEqual(selected.database, {
    id: config.env.staging.d1_databases[0].database_id,
    name: config.env.staging.d1_databases[0].database_name,
  })
  assert.deepEqual(selected.archive, {
    bucket: config.env.staging.r2_buckets[0].bucket_name,
    jurisdiction: 'eu',
  })
  assert.equal(selected.activeBackupKekVersion, 1)

  const cases = [
    { config, environment: { ...environment, APP_ENV: 'production' } },
    { config, environment: { ...environment, DATA_MODE: 'real' } },
    { config, environment: { ...environment, CLOUDFLARE_ENV: 'production' } },
    { config, environment: { ...environment, BWM_CONFIRM_PRODUCTION_DATABASE: 'anything' } },
    { config: { ...config, env: { ...config.env, staging: { ...config.env.staging, d1_databases: config.env.production.d1_databases } } }, environment },
  ]
  for (const value of cases) assert.throws(() => validateStagingBackupConfig(value), /^Error: BACKUP_STAGING_REFUSED$/)
})

test('migration evidence accepts only a bounded, strictly ordered exact set', async () => {
  const rows = [{ id: 1, name: '0001_security_primitives.sql' }, { id: 2, name: '0002_identity_operations.sql' }]
  const evidence = await migrationEvidence(rows)
  assert.equal(evidence.migrationCount, 2)
  assert.match(evidence.migrationSetSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(evidence.migrations, rows)
  for (const invalid of [
    [],
    [{ id: 2, name: '0002_ok.sql' }, { id: 1, name: '0001_bad.sql' }],
    [{ id: 1, name: '0001_same.sql' }, { id: 2, name: '0001_same.sql' }],
    [{ id: 1, name: `0001_${'a'.repeat(247)}.sql` }],
    Array.from({ length: 257 }, (_, index) => ({ id: index + 1, name: `${String(index + 1).padStart(4, '0')}_migration.sql` })),
  ]) await assert.rejects(migrationEvidence(invalid), /^Error: BACKUP_STAGING_FAILED$/)
})

function successfulSetup(overrides = {}) {
  const source = validateStagingBackupConfig({ config, environment }).source
  const now = Date.parse('2026-08-27T12:34:56.789Z')
  const backupId = 'bkp_demand_public_20260827'
  const owner = 'lease_owner_public_20260827'
  const exporting = {
    id: backupId,
    localDay: '2026-08-27',
    localMonth: '2026-08',
    retentionClass: 'daily',
    status: 'exporting',
    version: 2,
    createdAt: new Date(now).toISOString(),
  }
  const migrations = [{ id: 1, name: '0001_security_primitives.sql' }, { id: 2, name: '0002_identity_operations.sql' }]
  const events = []
  let leaseVersion = 2
  const store = {
    async acquireLease() { events.push('acquire'); return { backupId, owner, version: leaseVersion, stale: null } },
    async readDayFacts() { events.push('day'); return { liveDayCount: 0, liveMonthlyCount: 1, storedMonthlyCount: 1 } },
    async insertQueued() { events.push('queued'); return { ...exporting, status: 'queued', version: 1 } },
    async markExporting() { events.push('exporting'); return exporting },
    async readMigrations() { events.push('migrations'); return migrations },
    async renewLease({ phase }) { events.push(`renew:${phase}`); leaseVersion += 1; return { backupId, owner, version: leaseVersion } },
    async rereadLease() { events.push('reread'); return { backupId, owner, version: leaseVersion } },
    async markStored() { events.push('stored'); return { status: 'stored', version: 3 } },
    async readBackup() { events.push('read-backup'); return null },
    async markFailed({ errorCode, expectedVersion }) { events.push(`failed:${errorCode}`); return { status: 'failed', version: expectedVersion + 1 } },
    async markStaleFailed({ errorCode }) { events.push(`stale-failed:${errorCode}`); return { status: 'failed' } },
    async releaseLease() { events.push('release'); return { phase: 'idle' } },
  }
  const archive = {
    async putSql({ body }) { events.push('put-sql'); await body.pipeTo(new WritableStream({ write() {} })); return { etag: 'etag-demand-public', size: 4 } },
    async putManifest({ bytes }) { events.push('put-manifest'); return { etag: 'manifest-etag-public', size: bytes.byteLength } },
    async headSql() {
      events.push('head-sql')
      return {
        etag: 'etag-demand-public',
        size: 4,
        customMetadata: {
          backupId,
          format: 'bwm-d1-sql-v2',
          retentionClass: 'daily',
          sourceAppEnv: source.appEnv,
          sourceDatabaseId: source.databaseId,
        },
      }
    },
    async headManifest({ bytes }) { events.push('head-manifest'); return { etag: 'manifest-etag-public', size: bytes.byteLength } },
    async deleteObject({ key, signal }) { assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false); events.push(`delete:${key}`) },
    async objectAbsent({ signal }) { assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false); events.push('absent'); return true },
    async abortMultipart({ signal }) { assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false); events.push('abort') },
  }
  const keyring = {
    activeBackupKekVersion: 1,
    getBackupKek: async () => crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  }
  const input = {
    source,
    store,
    archive,
    keyring,
    now: () => now,
    backupIdFactory: () => backupId,
    leaseOwnerFactory: () => owner,
    nonceFactory: () => new Uint8Array(12).fill(3),
    rawKeyFactory: () => new Uint8Array(32).fill(5),
    pollExport: async () => { events.push('export'); return { atBookmark: 'bookmark-demand-public', downloadUrl: 'https://download.example.test/private' } },
    downloadExport: async () => { events.push('download'); return { body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close() } }) } },
    signal: new AbortController().signal,
    ...overrides,
  }
  return { backupId, events, input, migrations, store }
}

test('demand creation brackets export with migrations, publishes manifest last, fences R2, and finalizes one row', async () => {
  const setup = successfulSetup()
  const result = await createStagingBackup(setup.input)
  assert.deepEqual(result, {
    backupId: setup.backupId,
    completedAt: '2026-08-27T12:34:56.789Z',
    manifestKey: `backups/v2/2026/08/${setup.backupId}.manifest.json`,
    migrationCount: 2,
    migrationSetSha256: (await migrationEvidence(setup.migrations)).migrationSetSha256,
    objectEtag: 'etag-demand-public',
    objectSize: 4,
    restoreVerified: false,
    retentionClass: 'daily',
    status: 'stored',
  })
  assert.deepEqual(setup.events.filter((event) => ['migrations', 'export', 'put-sql', 'put-manifest', 'stored'].includes(event)), [
    'migrations', 'export', 'migrations', 'put-sql', 'put-manifest', 'stored',
  ])
  const sqlIndex = setup.events.indexOf('put-sql')
  const manifestIndex = setup.events.indexOf('put-manifest')
  assert.equal(setup.events[sqlIndex - 1], 'renew:creating')
  assert.equal(setup.events[sqlIndex + 1], 'reread')
  assert.equal(setup.events[manifestIndex - 1], 'renew:creating')
  assert.equal(setup.events[manifestIndex + 1], 'reread')
  assert.equal(setup.events.at(-1), 'release')
})

test('migration drift compensates manifest-first and never publishes a manifest', async () => {
  const setup = successfulSetup()
  let reads = 0
  setup.input.store.readMigrations = async () => {
    setup.events.push('migrations')
    reads += 1
    return reads === 1 ? setup.migrations : [...setup.migrations, { id: 3, name: '0003_drift.sql' }]
  }
  await assert.rejects(createStagingBackup(setup.input), /^Error: BACKUP_STAGING_FAILED$/)
  assert.equal(setup.events.includes('put-sql'), false)
  assert.equal(setup.events.includes('put-manifest'), false)
  const deletes = setup.events.filter((event) => event.startsWith('delete:'))
  assert.match(deletes[0], /\.manifest\.json$/)
  assert.match(deletes[1], /\.sql$/)
  for (const index of setup.events.flatMap((event, index) => event === 'absent' ? [index] : [])) {
    assert.equal(setup.events[index + 1], 'reread')
  }
  assert.equal(setup.events.some((event) => event === 'failed:BACKUP_MIGRATION_SET_CHANGED'), true)
})

test('one-live-day refusal performs no export or R2 mutation', async () => {
  const setup = successfulSetup()
  setup.input.store.readDayFacts = async () => ({ liveDayCount: 1, liveMonthlyCount: 1, storedMonthlyCount: 1 })
  await assert.rejects(createStagingBackup(setup.input), /^Error: BACKUP_STAGING_REFUSED$/)
  assert.equal(setup.events.includes('export'), false)
  assert.equal(setup.events.some((event) => event.startsWith('put-')), false)
})

test('migration status prints only bounded evidence', async () => {
  const rows = [{ id: 1, name: '0001_security_primitives.sql' }]
  assert.deepEqual(await stagingMigrationStatus({ store: { readMigrations: async () => rows } }), {
    migrationCount: 1,
    migrationSetSha256: (await migrationEvidence(rows)).migrationSetSha256,
    status: 'ok',
  })
})

test('status rejects a database-controlled manifest key before any R2 read', async () => {
  const source = validateStagingBackupConfig({ config, environment }).source
  let manifestReads = 0
  await assert.rejects(statusStagingBackup({
    backupId: 'bkp_status_public_20260827',
    source,
    keyring: { getBackupKek: async () => { throw new Error('must not open') } },
    store: {
      async readBackup() {
        return {
          id: 'bkp_status_public_20260827',
          status: 'stored',
          version: 3,
          localDay: '2026-08-27',
          localMonth: '2026-08',
          retentionClass: 'daily',
          objectKey: 'workbook-objects/not-a-backup.sql',
          manifestKey: 'workbook-objects/not-a-backup.manifest.json',
          objectEtag: 'status-etag-public',
          objectSize: 4,
          completedAt: '2026-08-27T12:34:56.789Z',
          lastErrorCode: null,
          createdAt: '2026-08-27T12:00:00.000Z',
        }
      },
    },
    async getManifest() {
      manifestReads += 1
      return new Uint8Array()
    },
  }), /^Error: BACKUP_STAGING_FAILED$/)
  assert.equal(manifestReads, 0)
})

test('an uncertain final CAS accepts only the exact stored object facts and keeps artifacts', async () => {
  const setup = successfulSetup()
  setup.input.store.markStored = async () => {
    setup.events.push('stored-timeout')
    throw new Error('provider timeout marker')
  }
  setup.input.store.readBackup = async () => {
    setup.events.push('read-backup')
    return {
      id: setup.backupId,
      status: 'stored',
      version: 3,
      localDay: '2026-08-27',
      localMonth: '2026-08',
      retentionClass: 'daily',
      objectKey: `backups/v2/2026/08/${setup.backupId}.sql`,
      manifestKey: `backups/v2/2026/08/${setup.backupId}.manifest.json`,
      objectEtag: 'etag-demand-public',
      objectSize: 4,
      completedAt: '2026-08-27T12:34:56.789Z',
      lastErrorCode: null,
      createdAt: '2026-08-27T12:34:56.789Z',
    }
  }
  const result = await createStagingBackup(setup.input)
  assert.equal(result.status, 'stored')
  assert.equal(setup.events.some((event) => event.startsWith('delete:')), false)
  assert.deepEqual(setup.events.slice(-3), ['stored-timeout', 'read-backup', 'release'])
})

test('an uncertain final CAS rejects an inexact stored reread before artifact preservation', async () => {
  const setup = successfulSetup()
  setup.input.store.markStored = async () => { throw new Error('provider timeout marker') }
  setup.input.store.readBackup = async () => ({
    id: setup.backupId,
    status: 'stored',
    version: 3,
    localDay: '2026-08-27',
    localMonth: '2026-08',
    retentionClass: 'daily',
    objectKey: `backups/v2/2026/08/${setup.backupId}.sql`,
    manifestKey: `backups/v2/2026/08/${setup.backupId}.manifest.json`,
    objectEtag: 'etag-demand-public',
    objectSize: 4,
    completedAt: '2026-08-27T12:34:56.789Z',
    lastErrorCode: null,
    createdAt: '2026-08-27T12:34:56.789Z',
    attackerControlledExtra: true,
  })
  await assert.rejects(createStagingBackup(setup.input), /^Error: BACKUP_STAGING_FAILED$/)
  assert.equal(setup.events.some((event) => event.startsWith('delete:')), true)
})

test('a release failure after stored finalization reports the valid backup and never deletes it', async () => {
  const setup = successfulSetup()
  setup.input.store.releaseLease = async () => {
    setup.events.push('release-timeout')
    throw new Error('provider timeout marker')
  }
  const result = await createStagingBackup(setup.input)
  assert.equal(result.status, 'stored')
  assert.deepEqual(setup.events.slice(-2), ['stored', 'release-timeout'])
  assert.equal(setup.events.some((event) => event.startsWith('delete:')), false)
  assert.equal(setup.events.some((event) => event.startsWith('failed:')), false)
})

test('an uncertain exporting CAS continues only from the exact owned exporting row', async () => {
  const setup = successfulSetup()
  setup.input.store.markExporting = async () => {
    setup.events.push('exporting-timeout')
    throw new Error('provider timeout marker')
  }
  setup.input.store.readBackup = async () => {
    setup.events.push('read-backup')
    return {
      id: setup.backupId,
      status: 'exporting',
      version: 2,
      localDay: '2026-08-27',
      localMonth: '2026-08',
      retentionClass: 'daily',
      objectKey: null,
      manifestKey: null,
      objectEtag: null,
      objectSize: null,
      completedAt: null,
      lastErrorCode: null,
      createdAt: '2026-08-27T12:34:56.789Z',
    }
  }
  const result = await createStagingBackup(setup.input)
  assert.equal(result.status, 'stored')
  assert.ok(setup.events.indexOf('read-backup') < setup.events.indexOf('export'))
})

test('a failed exporting CAS marks its already-created queued row failed without export', async () => {
  const setup = successfulSetup()
  setup.input.store.markExporting = async () => { throw new Error('provider failure marker') }
  setup.input.store.readBackup = async () => ({
    id: setup.backupId,
    status: 'queued',
    version: 1,
    localDay: '2026-08-27',
    localMonth: '2026-08',
    retentionClass: 'daily',
    objectKey: null,
    manifestKey: null,
    objectEtag: null,
    objectSize: null,
    completedAt: null,
    lastErrorCode: null,
    createdAt: '2026-08-27T12:34:56.789Z',
  })
  await assert.rejects(createStagingBackup(setup.input), /^Error: BACKUP_STAGING_FAILED$/)
  assert.equal(setup.events.includes('export'), false)
  assert.equal(setup.events.includes('failed:BACKUP_CREATE_FAILED'), true)
})

test('failed absence proof leaves cleanup lease fenced for an executable takeover', async () => {
  const setup = successfulSetup()
  setup.input.archive.putSql = async () => { throw new Error('write marker') }
  setup.input.archive.objectAbsent = async () => false
  await assert.rejects(createStagingBackup(setup.input), /^Error: BACKUP_STAGING_FAILED$/)
  assert.equal(setup.events.includes('release'), false)
  assert.equal(setup.events.includes('failed:BACKUP_ORPHAN_CLEANUP_FAILED'), true)
})

test('an uncertain failed-row CAS keeps the lease when an exact reread is still exporting', async () => {
  const setup = successfulSetup()
  setup.input.archive.putSql = async () => { throw new Error('write marker') }
  setup.input.store.markFailed = async () => {
    setup.events.push('failed-timeout')
    throw new Error('provider timeout marker')
  }
  setup.input.store.readBackup = async () => {
    setup.events.push('read-backup')
    return {
      id: setup.backupId,
      status: 'exporting',
      version: 2,
      localDay: '2026-08-27',
      localMonth: '2026-08',
      retentionClass: 'daily',
      objectKey: null,
      manifestKey: null,
      objectEtag: null,
      objectSize: null,
      completedAt: null,
      lastErrorCode: null,
      createdAt: '2026-08-27T12:34:56.789Z',
    }
  }
  await assert.rejects(createStagingBackup(setup.input), /^Error: BACKUP_STAGING_FAILED$/)
  assert.equal(setup.events.includes('failed-timeout'), true)
  assert.equal(setup.events.includes('read-backup'), true)
  assert.equal(setup.events.includes('release'), false)
})

test('an uncertain failed-row CAS releases only after an exact failed-row reread', async () => {
  const setup = successfulSetup()
  setup.input.archive.putSql = async () => { throw new Error('write marker') }
  setup.input.store.markFailed = async () => {
    setup.events.push('failed-timeout')
    throw new Error('provider timeout marker')
  }
  setup.input.store.readBackup = async () => {
    setup.events.push('read-backup')
    return {
      id: setup.backupId,
      status: 'failed',
      version: 3,
      localDay: '2026-08-27',
      localMonth: '2026-08',
      retentionClass: 'daily',
      objectKey: null,
      manifestKey: null,
      objectEtag: null,
      objectSize: null,
      completedAt: null,
      lastErrorCode: 'BACKUP_CREATE_FAILED',
      createdAt: '2026-08-27T12:34:56.789Z',
    }
  }
  await assert.rejects(createStagingBackup(setup.input), /^Error: BACKUP_STAGING_FAILED$/)
  assert.equal(setup.events.at(-1), 'release')
})

test('a concurrent one-live/day insert loser refuses before export or R2 writes', async () => {
  const setup = successfulSetup()
  let dayReads = 0
  setup.input.store.readDayFacts = async () => {
    dayReads += 1
    return dayReads === 1
      ? { liveDayCount: 0, liveMonthlyCount: 1, storedMonthlyCount: 1 }
      : { liveDayCount: 1, liveMonthlyCount: 1, storedMonthlyCount: 1 }
  }
  setup.input.store.insertQueued = async () => { throw new Error('unique collision marker') }
  await assert.rejects(createStagingBackup(setup.input), /^Error: BACKUP_STAGING_REFUSED$/)
  assert.equal(dayReads, 2)
  assert.equal(setup.events.includes('export'), false)
  assert.equal(setup.events.some((event) => event.startsWith('put-')), false)
})

test('an expired owner is taken over by CAS and its v2 then v1 artifacts are removed before a new row', async () => {
  const setup = successfulSetup()
  setup.input.store.acquireLease = async () => {
    setup.events.push('acquire-stale')
    return {
      backupId: setup.backupId,
      owner: 'lease_owner_public_20260827',
      version: 2,
      stale: { backupId: 'bkp_stale_public_20260826', localMonth: '2026-08' },
    }
  }
  const result = await createStagingBackup(setup.input)
  assert.equal(result.status, 'stored')
  assert.deepEqual(setup.events.filter((event) => event.startsWith('delete:')).slice(0, 4), [
    'delete:backups/v2/2026/08/bkp_stale_public_20260826.manifest.json',
    'delete:backups/v2/2026/08/bkp_stale_public_20260826.sql',
    'delete:backups/v1/2026/08/bkp_stale_public_20260826.manifest.json',
    'delete:backups/v1/2026/08/bkp_stale_public_20260826.sql',
  ])
  assert.ok(setup.events.indexOf('stale-failed:BACKUP_OPERATOR_LEASE_EXPIRED') < setup.events.indexOf('day'))
})

test('post-SQL and post-manifest failures both compensate manifest-first before marking failed', async () => {
  for (const failurePoint of ['manifest-put', 'manifest-head']) {
    const setup = successfulSetup()
    if (failurePoint === 'manifest-put') {
      setup.input.archive.putManifest = async () => { throw new Error('manifest put marker') }
    } else {
      setup.input.archive.headManifest = async ({ bytes }) => ({ etag: 'wrong-manifest-etag', size: bytes.byteLength })
    }
    await assert.rejects(createStagingBackup(setup.input), /^Error: BACKUP_STAGING_FAILED$/)
    const deletes = setup.events.filter((event) => event.startsWith('delete:'))
    assert.match(deletes[0], /\.manifest\.json$/)
    assert.match(deletes[1], /\.sql$/)
    assert.equal(setup.events.some((event) => event.startsWith('failed:')), true)
  }
})

test('an unexpired singleton operator lease is a fixed refusal with no lifecycle work', async () => {
  const setup = successfulSetup()
  setup.input.store.acquireLease = async () => { throw new Error('BACKUP_OPERATOR_BUSY') }
  await assert.rejects(createStagingBackup(setup.input), /^Error: BACKUP_STAGING_REFUSED$/)
  assert.equal(setup.events.length, 0)
})

test('the source D1 store refuses an active lease before issuing a takeover mutation', async () => {
  const statements = []
  const store = createDemandBackupStore({
    async query(sql) {
      statements.push(sql)
      return [{
        key: 'backup.demand.lease.v1',
        value_json: '{"backupId":"bkp_active_public","leaseExpiresAt":"2026-08-27T12:12:00.000Z","leaseOwner":"active_owner_public","phase":"creating"}',
        version: 7,
        updated_at: '2026-08-27T12:00:00.000Z',
      }]
    },
  })
  await assert.rejects(store.acquireLease({
    backupId: 'bkp_new_public',
    owner: 'new_owner_public',
    now: '2026-08-27T12:01:00.000Z',
    leaseExpiresAt: '2026-08-27T12:13:00.000Z',
  }), /^Error: BACKUP_OPERATOR_BUSY$/)
  assert.equal(statements.length, 1)
  assert.match(statements[0], /^SELECT key,value_json,version,updated_at FROM system_state/)
})

test('the pinned source runner rejects a symlinked temporary root before child execution', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'bwm-backup-symlink-root-'))
  const real = join(outer, 'real')
  const link = join(outer, 'link')
  mkdirSync(real)
  symlinkSync(real, link, 'dir')
  let executions = 0
  const selection = validateStagingBackupConfig({ config, environment })
  const runner = createPinnedSourceRunner({
    tempRoot: link,
    wranglerPath: '/opaque/wrangler.js',
    database: selection.database,
    async execute() {
      executions += 1
      return { stdout: JSON.stringify([{ results: [{ id: 1, name: '0001_security_primitives.sql' }], success: true, meta: {} }]) }
    },
  })
  try {
    await assert.rejects(runner.query('SELECT id,name FROM d1_migrations ORDER BY id LIMIT 257'), /^Error: BACKUP_STAGING_FAILED$/)
    assert.equal(executions, 0)
  } finally {
    await runner.cleanup()
    rmSync(outer, { recursive: true, force: true })
  }
})

test('the source D1 store takes a lease expiring exactly now by versioned CAS', async () => {
  const now = '2026-08-27T12:12:00.000Z'
  const nextExpiry = '2026-08-27T12:24:00.000Z'
  const statements = []
  const store = createDemandBackupStore({
    async query(sql) {
      statements.push(sql)
      if (sql.startsWith('SELECT key,value_json')) {
        return [{
          key: 'backup.demand.lease.v1',
          value_json: '{"backupId":"bkp_stale_public","leaseExpiresAt":"2026-08-27T12:12:00.000Z","leaseOwner":"stale_owner_public","phase":"creating"}',
          version: 7,
          updated_at: '2026-08-27T12:00:00.000Z',
        }]
      }
      if (sql.startsWith('SELECT id,local_month')) {
        return [{
          id: 'bkp_stale_public',
          local_month: '2026-08',
          status: 'exporting',
          version: 2,
          last_error_code: null,
        }]
      }
      if (sql.startsWith('UPDATE system_state')) {
        return [{
          key: 'backup.demand.lease.v1',
          value_json: `{"backupId":"bkp_new_public","leaseExpiresAt":"${nextExpiry}","leaseOwner":"new_owner_public","phase":"cleanup"}`,
          version: 8,
          updated_at: now,
        }]
      }
      throw new Error('unexpected statement')
    },
  })
  assert.deepEqual(await store.acquireLease({
    backupId: 'bkp_new_public',
    owner: 'new_owner_public',
    now,
    leaseExpiresAt: nextExpiry,
  }), {
    backupId: 'bkp_new_public',
    owner: 'new_owner_public',
    version: 8,
    stale: { backupId: 'bkp_stale_public', localMonth: '2026-08' },
  })
  assert.equal(statements.length, 3)
  assert.match(statements[2], /version=7/)
})

test('the source D1 store rejects a CAS RETURNING row for another lease owner', async () => {
  let calls = 0
  const store = createDemandBackupStore({
    async query(sql) {
      calls += 1
      if (sql.startsWith('SELECT key,value_json')) {
        return [{
          key: 'backup.demand.lease.v1',
          value_json: '{"backupId":null,"leaseExpiresAt":null,"leaseOwner":null,"phase":"idle"}',
          version: 1,
          updated_at: '1970-01-01T00:00:00.000Z',
        }]
      }
      return [{
        key: 'backup.demand.lease.v1',
        value_json: '{"backupId":"bkp_new_public","leaseExpiresAt":"2026-08-27T12:24:00.000Z","leaseOwner":"other_owner_public","phase":"creating"}',
        version: 2,
        updated_at: '2026-08-27T12:12:00.000Z',
      }]
    },
  })
  await assert.rejects(store.acquireLease({
    backupId: 'bkp_new_public',
    owner: 'new_owner_public',
    now: '2026-08-27T12:12:00.000Z',
    leaseExpiresAt: '2026-08-27T12:24:00.000Z',
  }), /^Error: BACKUP_OPERATOR_LEASE_LOST$/)
  assert.equal(calls, 2)
})

test('takeover of a completed backup lease preserves its artifacts and starts in creating phase', async () => {
  const now = '2026-08-28T12:12:00.000Z'
  const nextExpiry = '2026-08-28T12:24:00.000Z'
  const statements = []
  const store = createDemandBackupStore({
    async query(sql) {
      statements.push(sql)
      if (sql.startsWith('SELECT key,value_json')) {
        return [{
          key: 'backup.demand.lease.v1',
          value_json: '{"backupId":"bkp_stored_public","leaseExpiresAt":"2026-08-27T12:12:00.000Z","leaseOwner":"stale_owner_public","phase":"creating"}',
          version: 9,
          updated_at: '2026-08-27T12:00:00.000Z',
        }]
      }
      if (sql.startsWith('SELECT id,local_month')) {
        return [{
          id: 'bkp_stored_public',
          local_month: '2026-08',
          status: 'stored',
          version: 3,
          last_error_code: null,
        }]
      }
      if (sql.startsWith('UPDATE system_state')) {
        return [{
          key: 'backup.demand.lease.v1',
          value_json: `{"backupId":"bkp_new_public","leaseExpiresAt":"${nextExpiry}","leaseOwner":"new_owner_public","phase":"creating"}`,
          version: 10,
          updated_at: now,
        }]
      }
      throw new Error('unexpected statement')
    },
  })
  assert.deepEqual(await store.acquireLease({
    backupId: 'bkp_new_public',
    owner: 'new_owner_public',
    now,
    leaseExpiresAt: nextExpiry,
  }), {
    backupId: 'bkp_new_public',
    owner: 'new_owner_public',
    version: 10,
    stale: null,
  })
  assert.equal(statements.some((sql) => sql.includes('DELETE')), false)
})

test('takeover CAS recovers an expired pre-insert lease with no backup row or artifact cleanup', async () => {
  const now = '2026-08-28T12:12:00.000Z'
  const nextExpiry = '2026-08-28T12:24:00.000Z'
  const statements = []
  const store = createDemandBackupStore({
    async query(sql) {
      statements.push(sql)
      if (sql.startsWith('SELECT key,value_json')) {
        return [{
          key: 'backup.demand.lease.v1',
          value_json: '{"backupId":"bkp_never_inserted_public","leaseExpiresAt":"2026-08-27T12:12:00.000Z","leaseOwner":"stale_owner_public","phase":"creating"}',
          version: 11,
          updated_at: '2026-08-27T12:00:00.000Z',
        }]
      }
      if (sql.startsWith('SELECT id,local_month')) return []
      if (sql.startsWith('UPDATE system_state')) {
        return [{
          key: 'backup.demand.lease.v1',
          value_json: `{"backupId":"bkp_new_public","leaseExpiresAt":"${nextExpiry}","leaseOwner":"new_owner_public","phase":"creating"}`,
          version: 12,
          updated_at: now,
        }]
      }
      throw new Error('unexpected statement')
    },
  })
  assert.deepEqual(await store.acquireLease({
    backupId: 'bkp_new_public',
    owner: 'new_owner_public',
    now,
    leaseExpiresAt: nextExpiry,
  }), {
    backupId: 'bkp_new_public',
    owner: 'new_owner_public',
    version: 12,
    stale: null,
  })
  assert.equal(statements.length, 3)
})

test('source lifecycle terminal CASes bind exact pending and stored versions', async () => {
  const statements = []
  const store = createDemandBackupStore({
    async query(sql) {
      statements.push(sql)
      if (sql.startsWith('SELECT key,value_json')) {
        return [{
          key: 'backup.demand.lease.v1',
          value_json: '{"backupId":"bkp_exact_cas_public","leaseExpiresAt":"2026-08-27T12:24:00.000Z","leaseOwner":"exact_owner_public","phase":"creating"}',
          version: 7,
          updated_at: '2026-08-27T12:00:00.000Z',
        }]
      }
      if (sql.includes("SET status='failed'")) return [{ status: 'failed', version: 3 }]
      if (sql.includes("SET status='restore_verified'")) return [{ status: 'restore_verified', version: 4 }]
      throw new Error('unexpected statement')
    },
  })
  assert.deepEqual(await store.markFailed({
    backupId: 'bkp_exact_cas_public',
    errorCode: 'BACKUP_CREATE_FAILED',
    expectedStatus: 'exporting',
    expectedVersion: 2,
    failedAt: '2026-08-27T12:12:00.000Z',
    lease: { backupId: 'bkp_exact_cas_public', owner: 'exact_owner_public', version: 7 },
  }), { status: 'failed', version: 3 })
  assert.deepEqual(await store.markRestoreVerified({
    backupId: 'bkp_exact_cas_public',
    manifestKey: 'backups/v2/2026/08/bkp_exact_cas_public.manifest.json',
    objectEtag: 'etag-exact-public',
    objectKey: 'backups/v2/2026/08/bkp_exact_cas_public.sql',
    objectSize: 42,
    verifiedAt: '2026-08-27T12:13:00.000Z',
  }), { updated: true })
  const failedSql = statements.find((sql) => sql.includes("SET status='failed'"))
  const restoredSql = statements.find((sql) => sql.includes("SET status='restore_verified'"))
  assert.match(failedSql, /status='exporting' AND version=2/)
  assert.doesNotMatch(failedSql, /status IN/)
  assert.match(restoredSql, /version=4/)
  assert.match(restoredSql, /status='stored' AND version=3/)
})

function streamFrom(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

const s3Metadata = Object.freeze({
  backupId: 'bkp_s3_public_20260827',
  format: 'bwm-d1-sql-v2',
  retentionClass: 'daily',
  sourceAppEnv: 'staging',
  sourceDatabaseId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
})

test('S3 upload uses one conditional put through 8 MiB and returns exact head metadata', async () => {
  const commands = []
  const signals = []
  const bytes = new Uint8Array(8 * 1024 * 1024).fill(11)
  const client = {
    async send(command, options) {
      commands.push(command)
      signals.push(options.abortSignal)
      if (command.constructor.name === 'PutObjectCommand') return { ETag: '"small-etag-public"' }
      if (command.constructor.name === 'HeadObjectCommand') {
        return {
          ETag: '"small-etag-public"',
          ContentLength: bytes.byteLength,
          Metadata: {
            backupid: s3Metadata.backupId,
            format: s3Metadata.format,
            retentionclass: s3Metadata.retentionClass,
            sourceappenv: s3Metadata.sourceAppEnv,
            sourcedatabaseid: s3Metadata.sourceDatabaseId,
          },
        }
      }
      throw new Error('unexpected command')
    },
  }
  const archive = createS3BackupArchive({ client, bucket: 'backup-staging-public' })
  const signal = new AbortController().signal
  const stored = await archive.putSql({
    key: 'backups/v2/2026/08/bkp_s3_public_20260827.sql',
    body: streamFrom([bytes]),
    ssecKey: new Uint8Array(32).fill(4),
    customMetadata: s3Metadata,
    signal,
    checkpoint: async () => {},
  })
  assert.deepEqual(stored, { etag: 'small-etag-public', size: 8 * 1024 * 1024 })
  assert.equal(commands.length, 1)
  assert.equal(commands[0].constructor.name, 'PutObjectCommand')
  assert.equal(commands[0].input.IfNoneMatch, '*')
  assert.deepEqual(commands[0].input.Metadata, {
    backupid: s3Metadata.backupId,
    format: s3Metadata.format,
    retentionclass: s3Metadata.retentionClass,
    sourceappenv: s3Metadata.sourceAppEnv,
    sourcedatabaseid: s3Metadata.sourceDatabaseId,
  })
  assert.ok(signals[0] instanceof AbortSignal)
  assert.notEqual(signals[0], signal)
  assert.equal(bytes.every((value) => value === 0), true)

  assert.deepEqual(await archive.headSql({
    key: 'backups/v2/2026/08/bkp_s3_public_20260827.sql',
    ssecKey: new Uint8Array(32).fill(4),
    signal,
  }), { etag: 'small-etag-public', size: 8 * 1024 * 1024, customMetadata: s3Metadata })
})

test('S3 upload above 8 MiB emits exact parts, fences completion, and aborts a failed multipart', async () => {
  const calls = []
  const chunks = [new Uint8Array(5 * 1024 * 1024).fill(21), new Uint8Array(5 * 1024 * 1024).fill(22)]
  const client = {
    async send(command) {
      const name = command.constructor.name
      calls.push({ name, input: command.input, body: command.input.Body ? new Uint8Array(command.input.Body) : null })
      if (name === 'CreateMultipartUploadCommand') return { UploadId: 'upload-public' }
      if (name === 'UploadPartCommand') return { ETag: `"part-${command.input.PartNumber}-public"` }
      if (name === 'CompleteMultipartUploadCommand') return { ETag: '"multipart-etag-public"' }
      throw new Error('unexpected command')
    },
  }
  const checkpoints = []
  const archive = createS3BackupArchive({ client, bucket: 'backup-staging-public' })
  const result = await archive.putSql({
    key: 'backups/v2/2026/08/bkp_s3_public_20260827.sql',
    body: streamFrom(chunks),
    ssecKey: new Uint8Array(32).fill(4),
    customMetadata: s3Metadata,
    signal: new AbortController().signal,
    checkpoint: async () => { checkpoints.push(calls.length) },
  })
  assert.deepEqual(result, { etag: 'multipart-etag-public', size: 10 * 1024 * 1024 })
  assert.deepEqual(calls.map(({ name }) => name), [
    'CreateMultipartUploadCommand',
    'UploadPartCommand',
    'UploadPartCommand',
    'CompleteMultipartUploadCommand',
  ])
  assert.deepEqual(calls.filter(({ name }) => name === 'UploadPartCommand').map(({ body }) => body.byteLength), [
    8 * 1024 * 1024,
    2 * 1024 * 1024,
  ])
  assert.deepEqual(checkpoints, [0, 1, 2, 2, 3, 3, 4])
  assert.equal(chunks.every((chunk) => chunk.every((value) => value === 0)), true)

  const failedCalls = []
  const failingArchive = createS3BackupArchive({
    bucket: 'backup-staging-public',
    client: {
      async send(command) {
        failedCalls.push(command.constructor.name)
        if (command.constructor.name === 'CreateMultipartUploadCommand') return { UploadId: 'failed-upload-public' }
        if (command.constructor.name === 'AbortMultipartUploadCommand') return {}
        throw new Error('upload failure marker')
      },
    },
  })
  await assert.rejects(failingArchive.putSql({
    key: 'backups/v2/2026/08/bkp_s3_public_20260827.sql',
    body: streamFrom([new Uint8Array(8 * 1024 * 1024), new Uint8Array([1])]),
    ssecKey: new Uint8Array(32).fill(4),
    customMetadata: s3Metadata,
    signal: new AbortController().signal,
    checkpoint: async () => {},
  }), /upload failure marker/)
  assert.deepEqual(failedCalls, ['CreateMultipartUploadCommand', 'UploadPartCommand', 'AbortMultipartUploadCommand'])
})

test('a failed multipart abort stays retryable and never reuses the cancelled upload signal', async () => {
  const controller = new AbortController()
  const abortSignals = []
  let abortCalls = 0
  const key = 'backups/v2/2026/08/bkp_s3_public_20260827.sql'
  const archive = createS3BackupArchive({
    bucket: 'backup-staging-public',
    client: {
      async send(command, options) {
        const name = command.constructor.name
        if (name === 'CreateMultipartUploadCommand') return { UploadId: 'retryable-upload-public' }
        if (name === 'UploadPartCommand') {
          controller.abort()
          throw new Error('upload interruption marker')
        }
        if (name === 'AbortMultipartUploadCommand') {
          abortCalls += 1
          abortSignals.push(options.abortSignal)
          if (abortCalls === 1) throw new Error('first abort failure marker')
          return {}
        }
        throw new Error('unexpected command')
      },
    },
  })
  await assert.rejects(archive.putSql({
    key,
    body: streamFrom([new Uint8Array(8 * 1024 * 1024), new Uint8Array([1])]),
    ssecKey: new Uint8Array(32).fill(4),
    customMetadata: s3Metadata,
    signal: controller.signal,
    checkpoint: async () => {},
  }), /upload interruption marker/)
  await archive.abortMultipart({ key, signal: new AbortController().signal })
  assert.equal(abortCalls, 2)
  assert.equal(abortSignals.every((signal) => signal instanceof AbortSignal && signal.aborted === false), true)
})
