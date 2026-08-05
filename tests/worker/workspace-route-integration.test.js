import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  blindEmailIndex,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import {
  applyCoreDirectoryStageB,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = 1_800_000_000_000
const CORRELATION_ID = '00000000-0000-4000-8000-000000000035'
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
let serial = 0

const nextId = (kind) => `${kind}_workspace_route_${++serial}`

const encrypt = async (context, recordId, field, plaintext) => JSON.stringify(
  await encryptForScope(context.keyring, context.dataKey, {
    expectedScope: context.scope, recordId, field, plaintext,
  }),
)

const context = async () => {
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_workspace_route_identity', createdAt: new Date(NOW_MS).toISOString(),
  })
  return { keyring, dataKey, scope: SCOPE }
}

const seedActor = async (cryptoContext, { role, specialistId = null }) => {
  const suffix = ++serial
  const id = `stf_workspace_route_${suffix}`
  const email = `${role}-workspace-route-${suffix}@example.test`
  const now = new Date(NOW_MS).toISOString()
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,'active',?,?,1,?,NULL,?,?)`).bind(
    id, await blindEmailIndex(email, cryptoContext.keyring),
    await encrypt(cryptoContext, id, 'email', email),
    await encrypt(cryptoContext, id, 'display_name', `Fikcyjna ${role}`),
    role, `access-workspace-route-${suffix}`, specialistId, now, now, now,
  ).run()
  if (specialistId) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO specialists
        (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
        VALUES (?,?,18000,'active',1,NULL,?,?)`).bind(specialistId, id, now, now),
      env.DB.prepare(`INSERT INTO record_versions
        (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
         changed_at,correlation_id) VALUES (?,'specialist',?,1,'{}',NULL,?,?)`).bind(
        nextId('ver'), specialistId, now, CORRELATION_ID,
      ),
    ])
  }
  return {
    id, specialistId,
    principal: { kind: 'human', subject: `access-workspace-route-${suffix}`, normalizedEmail: email },
  }
}

const appFor = (keyring, principal) => createApp({
  config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl', dataMode: 'fictional' },
  db: env.DB, keyring,
  idFactory: () => nextId('route'), now: () => NOW_MS,
  resolveAccessPrincipal: async () => principal,
  verifyCsrfToken: async () => true,
  safeLog: vi.fn(),
})

const createClient = (name, specialistId) => ({
  path: '/api/v1/clients',
  init: {
    method: 'POST',
    headers: {
      origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
      'sec-fetch-site': 'same-origin', 'x-csrf-token': 'valid',
      'x-correlation-id': CORRELATION_ID, 'idempotency-key': `workspace-route-${++serial}-0001`,
    },
    body: JSON.stringify({ name, age: 12, status: 'active', specialistId }),
  },
})

beforeAll(async () => {
  expect(await completeCoreDirectoryStageA()).toMatchObject({ status: 'complete' })
  await applyCoreDirectoryStageB()
})

describe('real workspace route authorization', () => {
  it('returns centre scope to owner and coordinator but only the specialist assignment to a specialist', async () => {
    const cryptoContext = await context()
    const centreSpecialist = await seedActor(cryptoContext, {
      role: 'specialist', specialistId: 'sp_workspace_route_centre',
    })
    const owner = await seedActor(cryptoContext, { role: 'owner' })
    const coordinator = await seedActor(cryptoContext, { role: 'coordinator' })
    const specialist = await seedActor(cryptoContext, {
      role: 'specialist', specialistId: 'sp_workspace_route_scoped',
    })
    const create = async (name, specialistId) => {
      const request = createClient(name, specialistId)
      const response = await appFor(cryptoContext.keyring, owner.principal)
        .request(request.path, request.init)
      expect(response.status).toBe(201)
      return (await response.json()).data.client
    }
    const centreClient = await create('Fikcyjna centrum', centreSpecialist.specialistId)
    const scopedClient = await create('Fikcyjna specjalistki', specialist.specialistId)
    const path = '/api/v1/workspace?from=2027-01-01&to=2027-01-02'

    for (const actor of [owner, coordinator]) {
      const response = await appFor(cryptoContext.keyring, actor.principal).request(path)
      expect(response.status).toBe(200)
      const workspace = await response.json()
      expect(workspace.data.window).toEqual({
        from: '2027-01-01', to: '2027-01-02', timeZone: 'Europe/Warsaw', complete: true,
      })
      expect(workspace.data.clients.map(({ id }) => id)).toEqual(expect.arrayContaining([
        centreClient.id, scopedClient.id,
      ]))
    }

    const response = await appFor(cryptoContext.keyring, specialist.principal).request(path)
    expect(response.status).toBe(200)
    const workspace = await response.json()
    expect(workspace.data.clients.map(({ id }) => id)).toEqual([scopedClient.id])
    expect(workspace.data.appointments).toEqual([])
  })
})
