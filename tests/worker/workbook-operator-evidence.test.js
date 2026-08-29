import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  loadWorkbookOperatorEvidence,
  loadWorkbookReconciliationEvidence,
  verifyWorkbookImportArtifact,
} from '../../worker/core/workbook-operator-evidence.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { storeWorkbookArtifact } from '../../worker/security/workbook-artifacts.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2027-08-01T09:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const OWNER = authorityActor({ id: 'stf_workbook_operator_owner', role: 'owner' })
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const config = Object.freeze({
  appEnv: 'staging', activeWorkbookKekVersion: 1, activeWorkbookHmacVersion: 1,
})

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    OWNER.id, 'workbook_operator_owner_lookup', '{}', '{}', 'owner', 'active',
    'workbook-operator-owner-subject', null, 1, NOW, null, NOW, NOW,
  ).run()
  await env.ARCHIVE.put(
    'workbook-objects/wbo_operator_evidence_0000000000000000',
    new Uint8Array([1, 2, 3]),
  )
  await env.ARCHIVE.put('unrelated/operator-evidence', new Uint8Array([4]))
})

describe.sequential('source-free workbook operator evidence', () => {
  it('returns exact bounded D1 and R2 write counters without object keys', async () => {
    const result = await loadWorkbookOperatorEvidence({
      db: env.DB, bucket: env.ARCHIVE, actor: OWNER, nowMs: NOW_MS,
    })
    expect(result).toEqual({ data: {
      artifactCount: 0,
      workbookObjectCount: 1,
      templateCount: 0,
      importCount: 0,
      planCount: 0,
      sourceRecordCount: 0,
      quarantineCount: 0,
      resolutionCount: 0,
      resolutionSetCount: 0,
      jobCount: 0,
      candidateCount: 0,
      decisionCount: 0,
      financeEntryCount: 0,
      financeLinkCount: 0,
      historicalOccurrenceCount: 0,
      activityChargeCount: 0,
      projectionLinkCount: 0,
      workbookVoidCount: 0,
      manualVoidCount: 0,
      createdRecordCount: 0,
      voidedRecordCount: 0,
      auditEventCount: 1,
      outboxMessageCount: 0,
    } })
    expect(JSON.stringify(result)).not.toContain('wbo_operator')
  })

  it('fails closed on a non-advancing empty R2 page and on final authority loss', async () => {
    let calls = 0
    const repeated = {
      async list() {
        calls += 1
        return calls === 1
          ? { objects: [{}], truncated: true, cursor: 'same-cursor' }
          : { objects: [], truncated: true, cursor: 'same-cursor' }
      },
    }
    await expect(loadWorkbookOperatorEvidence({
      db: env.DB, bucket: repeated, actor: OWNER, nowMs: NOW_MS,
    })).rejects.toThrow(/^INTERNAL_ERROR$/)
    expect(calls).toBe(2)

    let checks = 0
    const revoked = {
      prepare(sql) {
        if (sql.includes('SELECT authority.revision FROM staff_users AS staff')) {
          checks += 1
          if (checks > 1) return {
            bind() { return this }, async first() { return null },
          }
        }
        return env.DB.prepare(sql)
      },
    }
    await expect(loadWorkbookOperatorEvidence({
      db: revoked,
      bucket: { async list() { return { objects: [], truncated: false } } },
      actor: OWNER,
      nowMs: NOW_MS,
    })).rejects.toThrow(/^NOT_FOUND$/)
    expect(checks).toBe(2)
  })

  it('rechecks current authority after artifact readback and reconciliation work', async () => {
    const keyring = await createKeyring({
      BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V1: key(2),
      BWM_WORKBOOK_KEK_V1: key(3), BWM_WORKBOOK_HMAC_V1: key(4),
    }, {
      ...config, activeDataKekVersion: 1, activeLookupKeyVersion: 1,
    })
    const bytes = new Uint8Array([80, 75, 3, 4, 21])
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((value) => value.toString(16).padStart(2, '0')).join('')
    const objectKey = 'workbook-objects/wbo_operator_verification_0000000000000000'
    const descriptor = await storeWorkbookArtifact({
      bucket: env.ARCHIVE, keyring, config, centreId: 'centre_1', objectKey,
      bytes, fingerprint, parserVersion: 2, materializerVersion: 2,
      nonceFactory: () => new Uint8Array(12).fill(7),
    })
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_artifacts
        (id,centre_id,environment,fingerprint,byte_size,parser_version,
         materializer_version,object_key,content_nonce_b64,workbook_kek_version,
         metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wba_operator_verification', 'centre_1', descriptor.environment,
        descriptor.fingerprint, descriptor.byteSize, descriptor.parserVersion,
        descriptor.materializerVersion, descriptor.objectKey, descriptor.contentNonce,
        descriptor.workbookKekVersion, descriptor.metadataHmacVersion,
        descriptor.metadataSignature, OWNER.id, NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_imports
        (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
         correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wbi_operator_verification', 'wba_operator_verification', 'A'.repeat(43),
        'ready', 0, 0, 'corr_operator_verification', OWNER.id, 1, NOW, NOW, null,
      ),
    ])
    const revokedAfterInitialCheck = () => {
      let checks = 0
      return {
        prepare(sql) {
          if (sql.includes('SELECT authority.revision FROM staff_users AS staff')) {
            checks += 1
            if (checks > 1) return {
              bind() { return this }, async first() { return null },
            }
          }
          return env.DB.prepare(sql)
        },
      }
    }
    await expect(verifyWorkbookImportArtifact({
      db: revokedAfterInitialCheck(), bucket: env.ARCHIVE, actor: OWNER, keyring,
      config, nowMs: NOW_MS, importId: 'wbi_operator_verification',
    })).rejects.toThrow(/^NOT_FOUND$/)
    await expect(loadWorkbookReconciliationEvidence({
      db: revokedAfterInitialCheck(), actor: OWNER, nowMs: NOW_MS,
      importId: 'wbi_operator_verification',
    })).rejects.toThrow(/^NOT_FOUND$/)
  })
})
