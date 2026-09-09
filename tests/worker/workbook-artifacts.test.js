import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  createWorkbookPanelMetadataCallbacks,
  createWorkbookPreviewToken,
  digestWorkbookSourcePayload,
  digestWorkbookSourceValue,
  readWorkbookArtifact,
  storeWorkbookArtifact,
  verifyWorkbookPreviewToken,
  verifyWorkbookPreviewTokenContext,
} from '../../worker/security/workbook-artifacts.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'

const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const config = Object.freeze({
  appEnv: 'staging',
  activeWorkbookKekVersion: 1,
  activeWorkbookHmacVersion: 1,
})
const ring = () => createKeyring({
  BWM_BACKUP_KEK_V1: key(3),
  BWM_WORKBOOK_KEK_V1: key(9),
  BWM_WORKBOOK_HMAC_V1: key(10),
}, {
  activeBackupKekVersion: 1,
  activeWorkbookKekVersion: 1,
  activeWorkbookHmacVersion: 1,
})
const bytes = new TextEncoder().encode('fictional-workbook-contents')
const fingerprint = 'fb32f58146f751756a79ea8dc89f37575a3751ee97430493b7190b4fe8270152'
const objectKeys = []

afterEach(async () => {
  await Promise.all(objectKeys.splice(0).map((objectKey) => env.ARCHIVE.delete(objectKey)))
})

describe('workbook artifact protection', () => {
  it('stores only ciphertext under an opaque key and verifies every signed R2/D1 metadata field before decrypting', async () => {
    const keyring = await ring()
    const objectKey = `workbook-objects/wbo_crypto_${crypto.randomUUID().replaceAll('-', '')}`
    objectKeys.push(objectKey)
    const descriptor = await storeWorkbookArtifact({
      bucket: env.ARCHIVE,
      keyring,
      config,
      centreId: 'centre_1',
      objectKey,
      bytes,
      fingerprint,
      parserVersion: 2,
      materializerVersion: 2,
      nonceFactory: () => new Uint8Array(12).fill(11),
    })

    expect(descriptor).toEqual({
      environment: 'staging',
      centreId: 'centre_1',
      objectKey,
      fingerprint,
      byteSize: bytes.byteLength,
      parserVersion: 2,
      materializerVersion: 2,
      contentNonce: 'CwsLCwsLCwsLCwsL',
      workbookKekVersion: 1,
      metadataHmacVersion: 1,
      metadataSignature: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
    const stored = await env.ARCHIVE.get(objectKey)
    const ciphertext = new Uint8Array(await stored.arrayBuffer())
    expect(ciphertext).not.toEqual(bytes)
    expect(new TextDecoder().decode(ciphertext)).not.toContain('fictional-workbook-contents')
    expect(stored.customMetadata).toEqual({
      bwmDomain: 'workbook-artifact-v1',
      byteSize: String(bytes.byteLength),
      centreId: 'centre_1',
      contentNonce: 'CwsLCwsLCwsLCwsL',
      environment: 'staging',
      fingerprint,
      materializerVersion: '2',
      metadataHmacVersion: '1',
      metadataSignature: descriptor.metadataSignature,
      objectKey,
      parserVersion: '2',
      workbookKekVersion: '1',
    })
    await expect(readWorkbookArtifact({
      bucket: env.ARCHIVE,
      keyring,
      config,
      centreId: 'centre_1',
      descriptor,
    })).resolves.toEqual(bytes)
  })

  it('rejects ciphertext, signed metadata, cross-environment, centre, object, digest, size and key-version tampering', async () => {
    const keyring = await ring()
    const objectKey = `workbook-objects/wbo_tamper_${crypto.randomUUID().replaceAll('-', '')}`
    objectKeys.push(objectKey)
    const descriptor = await storeWorkbookArtifact({
      bucket: env.ARCHIVE,
      keyring,
      config,
      centreId: 'centre_1',
      objectKey,
      bytes,
      fingerprint,
      parserVersion: 2,
      materializerVersion: 2,
      nonceFactory: () => new Uint8Array(12).fill(12),
    })
    const invalid = (overrides = {}, otherConfig = config, centreId = 'centre_1') => expect(
      readWorkbookArtifact({
        bucket: env.ARCHIVE,
        keyring,
        config: otherConfig,
        centreId,
        descriptor: { ...descriptor, ...overrides },
      }),
    ).rejects.toThrow(/^WORKBOOK_ARTIFACT_INVALID$/)

    await invalid({ centreId: 'centre_2' })
    await invalid({ environment: 'production' })
    await invalid({ objectKey: `${objectKey}_other` })
    await invalid({ fingerprint: 'a'.repeat(64) })
    await invalid({ byteSize: bytes.byteLength + 1 })
    await invalid({ workbookKekVersion: 2 })
    await invalid({ metadataHmacVersion: 2 })
    await invalid({ metadataSignature: `A${descriptor.metadataSignature.slice(1)}` })
    await invalid({}, { ...config, appEnv: 'production' })
    await invalid({}, config, 'centre_2')

    const stored = await env.ARCHIVE.get(objectKey)
    const ciphertext = new Uint8Array(await stored.arrayBuffer())
    ciphertext[0] ^= 1
    await env.ARCHIVE.put(objectKey, ciphertext, { customMetadata: stored.customMetadata })
    await invalid()
  })
})

describe('workbook HMAC domain', () => {
  it('binds short-lived preview tokens to exact bytes, parser versions, environment and centre', async () => {
    const keyring = await ring()
    const token = await createWorkbookPreviewToken({
      keyring,
      config,
      centreId: 'centre_1',
      actorId: 'stf_workbook_owner_one',
      fingerprint,
      byteSize: bytes.byteLength,
      parserVersion: 2,
      materializerVersion: 2,
      planDigest: `v1_${'A'.repeat(43)}`,
      issuedAtMs: 1_800_000_000_000,
      expiresAtMs: 1_800_000_300_000,
      nonceFactory: () => new Uint8Array(16).fill(13),
    })
    const expected = {
      centreId: 'centre_1',
      actorId: 'stf_workbook_owner_one',
      fingerprint,
      byteSize: bytes.byteLength,
      parserVersion: 2,
      materializerVersion: 2,
      planDigest: `v1_${'A'.repeat(43)}`,
    }
    await expect(verifyWorkbookPreviewToken({
      token,
      keyring,
      config,
      expected,
      nowMs: 1_800_000_100_000,
    })).resolves.toMatchObject(expected)
    const { planDigest: _planDigest, ...stableExpected } = expected
    await expect(verifyWorkbookPreviewTokenContext({
      token,
      keyring,
      config,
      expected: stableExpected,
      nowMs: 1_800_000_100_000,
    })).resolves.toMatchObject(expected)
    for (const mismatch of [
      { ...expected, fingerprint: 'a'.repeat(64) },
      { ...expected, byteSize: bytes.byteLength + 1 },
      { ...expected, parserVersion: 3 },
      { ...expected, materializerVersion: 3 },
      { ...expected, planDigest: `v1_${'B'.repeat(43)}` },
    ]) await expect(verifyWorkbookPreviewToken({
      token, keyring, config, expected: mismatch, nowMs: 1_800_000_100_000,
    })).rejects.toThrow(/^WORKBOOK_PREVIEW_TOKEN_INVALID$/)
    await expect(verifyWorkbookPreviewToken({
      token, keyring, config, expected, nowMs: 1_800_000_300_001,
    })).rejects.toThrow(/^WORKBOOK_PREVIEW_TOKEN_INVALID$/)
    await expect(verifyWorkbookPreviewToken({
      token,
      keyring,
      config: { ...config, appEnv: 'production' },
      expected,
      nowMs: 1_800_000_100_000,
    })).rejects.toThrow(/^WORKBOOK_PREVIEW_TOKEN_INVALID$/)
    await expect(verifyWorkbookPreviewToken({
      token,
      keyring,
      config,
      expected: { ...expected, actorId: 'stf_workbook_owner_two' },
      nowMs: 1_800_000_100_000,
    })).rejects.toThrow(/^WORKBOOK_PREVIEW_TOKEN_INVALID$/)
  })

  it('provides domain-separated Panel-v2 sign/verify callbacks without accepting backup keys', async () => {
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring: await ring(),
      config,
      centreId: 'centre_1',
    })
    const payload = new TextEncoder().encode('{"format":"Panel-v2"}')
    const signature = await callbacks.sign(payload)
    expect(signature).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/)
    await expect(callbacks.verify(payload, signature)).resolves.toBe(true)
    const tampered = new TextEncoder().encode('{"format":"legacy"}')
    await expect(callbacks.verify(tampered, signature)).resolves.toBe(false)
  })

  it('signs legacy raw cells that carry decimal amounts', async () => {
    const keyring = await ring()
    const payload = {
      schema: 'workbook_source_payload.v1',
      normalized: { sourceLabel: 'Fikcyjny koszt stały', amountGrosze: 30_750 },
      raw: { Kwota: 307.5 },
    }

    await expect(digestWorkbookSourcePayload({
      keyring,
      config,
      centreId: 'centre_1',
      sourceKey: 'workbook:v1:24:4:10',
      payload,
    })).resolves.toEqual({
      digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      hmacVersion: 1,
    })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses to sign a raw cell holding %p, which JSON renders as a colliding null',
    async (unsignable) => {
      const keyring = await ring()

      await expect(digestWorkbookSourcePayload({
        keyring,
        config,
        centreId: 'centre_1',
        sourceKey: 'workbook:v1:24:4:10',
        payload: {
          schema: 'workbook_source_payload.v1',
          normalized: { amountGrosze: 30_750 },
          raw: { Kwota: unsignable },
        },
      })).rejects.toThrow(/^WORKBOOK_PANEL_SIGNATURE_INVALID$/)
    },
  )

  it('uses literal domain-separated keyed digests for source provenance and Panel field bases', async () => {
    const keyring = await ring()
    const payload = {
      schema: 'workbook_source_payload.v1',
      normalized: { sourceLabel: 'Fikcyjna konsultacja', amountGrosze: 18_000 },
      raw: { Cena: '180 zł' },
    }
    await expect(digestWorkbookSourcePayload({
      keyring,
      config,
      centreId: 'centre_1',
      sourceKey: 'workbook:v1:0:2:0',
      payload,
    })).resolves.toEqual({
      digest: 'lKIj28SQAFiWUqOlUBT4OWooVoZBXUo1fPCaOVZOphQ',
      hmacVersion: 1,
    })
    await expect(digestWorkbookSourceValue({
      keyring,
      config,
      centreId: 'centre_1',
      sourceValueKind: 'explicit_name',
      sourceValue: 'Anna Janowska',
    })).resolves.toEqual({
      digest: '8Pe43Aq8dYUAzEtvZd6sWpdQbeFeHt4aNHhs93GFEOo',
      hmacVersion: 1,
    })
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring, config, centreId: 'centre_1',
    })
    await expect(callbacks.digestField({
      rowType: 'finance_entry', rowId: 'fin_one', field: 'amountGrosze', value: 18_000,
    })).resolves.toBe('v1_1Z48HY5b2_DENoHNfGFfhGlZ6IHiEi5r1QDNrEKnQkA')
    await expect(callbacks.digestField({
      rowType: 'finance_entry', rowId: 'fin_one', field: 'amountGrosze', value: 18_000,
      hmacVersion: 2,
    })).rejects.toThrow(/^WORKBOOK_PANEL_SIGNATURE_INVALID$/)
  })
})
