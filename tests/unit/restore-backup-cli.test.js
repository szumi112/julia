import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readBoundedJson,
  readBoundedManifestBody,
  restoreCliLine,
  sseCustomerParameters,
} from '../../scripts/restore-backup.mjs'

function unfinishedStream(bytes) {
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(bytes) },
    cancel() { cancelled = true },
  })
  return { stream, wasCancelled: () => cancelled }
}

test('restore provider cancels oversized and malformed unfinished response streams', async () => {
  const oversized = unfinishedStream(new Uint8Array(64 * 1024 + 1))
  await assert.rejects(readBoundedJson(new Response(oversized.stream, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })), /^Error: RESTORE_FAILED$/)
  assert.equal(oversized.wasCancelled(), true)

  const malformed = unfinishedStream(new Uint8Array())
  await assert.rejects(readBoundedManifestBody(malformed.stream), /^Error: RESTORE_FAILED$/)
  assert.equal(malformed.wasCancelled(), true)
})

test('restore SSE-C parameters accept only an exact full 32-byte ArrayBuffer view', () => {
  const exact = new Uint8Array(32).fill(7)
  assert.deepEqual(sseCustomerParameters(exact), {
    SSECustomerAlgorithm: 'AES256',
    SSECustomerKey: Buffer.from(exact.buffer).toString('base64'),
  })
  const oversized = new Uint8Array(64)
  assert.throws(() => sseCustomerParameters(oversized.subarray(8, 40)), /^Error: RESTORE_FAILED$/)
})

test('restore CLI success lines preserve the exact redacted v1, v2 and v3 grammar', () => {
  const keys = [
    'backupId', 'format', 'migrationCount', 'migrationSetSha256', 'recoveryKind',
    'target', 'manifestAuthenticated', 'objectReadbackVerified',
    'migrationsVerified', 'recoveryFactsVerified', 'restoreSentinelVerified',
    'sourceMarkedVerified', 'targetFreshVerified',
  ]
  for (const [format, facts] of [
    ['bwm-d1-sql-v1', { recoveryKind: null, migrationsVerified: false, recoveryFactsVerified: false, restoreSentinelVerified: false, sourceMarkedVerified: false }],
    ['bwm-d1-sql-v2', { recoveryKind: null, migrationsVerified: true, recoveryFactsVerified: false, restoreSentinelVerified: true, sourceMarkedVerified: true }],
    ['bwm-d1-sql-v3', { recoveryKind: 'core_pre_workbook_v1', migrationsVerified: true, recoveryFactsVerified: true, restoreSentinelVerified: true, sourceMarkedVerified: true }],
  ]) {
    const result = {
      backupId: `bkp_cli_${format.at(-1)}`,
      format,
      migrationCount: 15,
      migrationSetSha256: 'a'.repeat(64),
      recoveryKind: facts.recoveryKind,
      target: `bearwithme-restore-v${format.at(-1)}`,
      manifestAuthenticated: true,
      objectReadbackVerified: true,
      migrationsVerified: facts.migrationsVerified,
      recoveryFactsVerified: facts.recoveryFactsVerified,
      restoreSentinelVerified: facts.restoreSentinelVerified,
      sourceMarkedVerified: facts.sourceMarkedVerified,
      targetFreshVerified: true,
    }
    const line = restoreCliLine(result)
    assert.equal(line.endsWith('\n'), true)
    assert.deepEqual(Object.keys(JSON.parse(line)), keys)
    assert.doesNotMatch(line, /objectKey|manifestKey|databaseId|objectEtag|bookmark|fingerprint|artifact|jobId|\/tmp\//)
  }
})
