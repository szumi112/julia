import { describe, expect, it, vi } from 'vitest'
import {
  captureCoreAuditEvent,
  isCoreAuditAction,
} from '../../src/core-audit-contract.js'
import { CORE_ROUTE_DESCRIPTORS, createApp } from '../../worker/app.js'
import { AppError } from '../../worker/http/errors.js'
import {
  postSpecialistAccountLink,
  postSpecialistProfile,
  postSpecialistProfileEdit,
} from '../../worker/routes/specialists.js'

const NOW_MS = Date.parse('2026-08-27T14:00:00.000Z')
const ORIGIN = 'https://bearwithme-panel.app'
const BODY = Object.freeze({
  staffId: 'stf_link_target',
  expectedSpecialistVersion: 3,
  expectedStaffVersion: 7,
})
const ACTOR = Object.freeze({
  id: 'stf_link_owner', role: 'owner', specialistId: null, version: 5,
})

const statement = () => {
  const value = {
    bind: vi.fn(() => value),
    all: vi.fn(async () => ({ results: [] })),
    first: vi.fn(async () => null),
    raw: vi.fn(async () => []),
    run: vi.fn(async () => ({ success: true })),
  }
  return value
}

const depsFor = (overrides = {}) => ({
  config: { appEnv: 'staging', appOrigin: ORIGIN, dataMode: 'fictional' },
  db: { prepare: vi.fn(statement), batch: vi.fn(async () => []) },
  cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
  now: () => NOW_MS,
  resolveAccessPrincipal: vi.fn(async () => ({
    kind: 'human', subject: 'access-link-owner',
    normalizedEmail: 'link-owner@example.test',
  })),
  resolveActor: vi.fn(async () => ACTOR),
  verifyCsrfToken: vi.fn(async () => true),
  safeLog: vi.fn(),
  idFactory: () => 'link_route_fixture',
  ...overrides,
})

const mutation = (body = BODY, key = 'specialist-link-route-0001') => ({
  method: 'POST',
  headers: {
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin',
    'X-CSRF-Token': 'valid',
    'X-Correlation-Id': '00000000-0000-4000-8000-000000000071',
    'Idempotency-Key': key,
  },
  body: JSON.stringify(body),
})

describe('specialist account link HTTP boundary', () => {
  it('publishes the exact link contract and professional-title profile bodies', () => {
    const link = CORE_ROUTE_DESCRIPTORS.find(({ id }) => id === 'specialists.account.link')
    expect(link).toMatchObject({
      capability: 'staff.manage',
      auditActions: ['specialist.account.linked'],
      bodyKeys: ['staffId', 'expectedSpecialistVersion', 'expectedStaffVersion'],
      methods: ['POST', 'OPTIONS'],
      sharedBudget: { totalLimit: 50, recoveryReserve: 8 },
    })
    expect(Object.isFrozen(link)).toBe(true)
    expect(CORE_ROUTE_DESCRIPTORS.find(({ id }) => id === 'specialists.create')?.bodyKeys)
      .toEqual(['displayName', 'professionalTitle', 'standardRateGrosze'])
    expect(CORE_ROUTE_DESCRIPTORS.find(({ id }) => id === 'specialists.edit')?.bodyKeys)
      .toEqual(['expectedVersion', 'displayName', 'professionalTitle', 'standardRateGrosze'])
  })

  it('keeps the link audit action exact, typed, and free of presentation data', () => {
    const valid = {
      action: 'specialist.account.linked',
      actorStaffId: 'stf_link_owner',
      entityType: 'specialist',
      entityId: 'sp_link_profile',
      result: 'success',
      metadata: { specialistVersion: 4, staffVersion: 8 },
    }
    expect(isCoreAuditAction(valid.action)).toBe(true)
    expect(captureCoreAuditEvent(valid)).toEqual(valid)
    expect(captureCoreAuditEvent({
      ...valid,
      metadata: { ...valid.metadata, professionalTitle: 'Specjalistka' },
    })).toBeNull()
  })

  it('forwards only the exact command input and maps validation fields safely', async () => {
    const service = vi.fn(async (input) => ({
      status: 201,
      body: { data: { link: { specialistId: input.specialistId } } },
    }))
    const input = {
      db: {}, recoveryDb: {}, actor: ACTOR, keyring: {}, nowMs: NOW_MS,
      correlationId: '00000000-0000-4000-8000-000000000071',
      idFactory: () => 'route_adapter', specialistId: 'sp_link_profile',
      body: BODY, idempotencyKey: 'specialist-link-adapter-0001',
      ignored: 'never-forwarded', link: service,
    }
    await expect(postSpecialistAccountLink(input)).resolves.toEqual({
      status: 201,
      body: { data: { link: { specialistId: 'sp_link_profile' } } },
    })
    expect(service).toHaveBeenCalledWith({
      db: input.db, recoveryDb: input.recoveryDb, actor: ACTOR,
      keyring: input.keyring, nowMs: NOW_MS, correlationId: input.correlationId,
      idFactory: input.idFactory, specialistId: 'sp_link_profile',
      body: BODY, idempotencyKey: 'specialist-link-adapter-0001',
    })

    for (const field of [
      'body', 'staffId', 'expectedSpecialistVersion', 'expectedStaffVersion',
    ]) {
      await expect(postSpecialistAccountLink({
        ...input,
        link: vi.fn(async () => { throw new TypeError(`VALIDATION_FAILED/${field}`) }),
      })).rejects.toEqual(expect.objectContaining({
        code: 'VALIDATION_FAILED', status: 400, details: { field },
      }))
    }
    await expect(postSpecialistProfile({
      ...input,
      create: vi.fn(async () => { throw new TypeError('VALIDATION_FAILED/professionalTitle') }),
    })).rejects.toEqual(expect.objectContaining({
      code: 'VALIDATION_FAILED', status: 400,
      details: { field: 'professionalTitle' },
    }))
    await expect(postSpecialistProfileEdit({
      ...input,
      edit: vi.fn(async () => { throw new TypeError('VALIDATION_FAILED/professionalTitle') }),
    })).rejects.toEqual(expect.objectContaining({
      code: 'VALIDATION_FAILED', status: 400,
      details: { field: 'professionalTitle' },
    }))
  })

  it('dispatches the protected command with sibling bounded database views', async () => {
    const postSpecialistAccountLink = vi.fn(async (input) => ({
      status: 201,
      body: { data: { link: {
        id: 'spl_link_route', specialistId: input.specialistId,
        staffId: input.body.staffId, lifecycle: 'activated',
        specialistVersion: 4, staffVersion: 8,
        createdAt: '2026-08-27T14:00:00.000Z',
      } } },
    }))
    const input = depsFor({ postSpecialistAccountLink })
    const response = await createApp(input).request(
      '/api/v1/specialists/sp_link_profile/account-links',
      mutation(),
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      data: { link: {
        specialistId: 'sp_link_profile', staffId: 'stf_link_target',
        lifecycle: 'activated', specialistVersion: 4, staffVersion: 8,
      } },
    })
    expect(postSpecialistAccountLink).toHaveBeenCalledWith(expect.objectContaining({
      actor: ACTOR,
      specialistId: 'sp_link_profile',
      body: BODY,
      idempotencyKey: 'specialist-link-route-0001',
    }))
    const command = postSpecialistAccountLink.mock.calls[0][0]
    expect(command.db).not.toBe(command.recoveryDb)
    expect(input.verifyCsrfToken).toHaveBeenCalledOnce()
  })

  it('rejects aliases and extra body keys before dispatch and advertises exact OPTIONS', async () => {
    const postSpecialistAccountLink = vi.fn()
    const input = depsFor({ postSpecialistAccountLink })
    const app = createApp(input)
    const extra = await app.request(
      '/api/v1/specialists/sp_link_profile/account-links',
      mutation({ ...BODY, centreId: 'centre_1' }, 'specialist-link-route-extra'),
    )
    expect(extra.status).toBe(400)
    expect((await extra.json()).error).toMatchObject({
      code: 'VALIDATION_FAILED', details: { field: 'body' },
    })
    expect(postSpecialistAccountLink).not.toHaveBeenCalled()

    for (const path of [
      '/api/v1/specialists/sp_link_profile/account-links/',
      '/api/v1/specialists/sp_link_profile/account-links?centreId=centre_1',
      '/api/v1/specialists/specialist_link_profile/account-links',
    ]) {
      const response = await app.request(path, mutation())
      expect(response.status).toBe(404)
    }
    expect(postSpecialistAccountLink).not.toHaveBeenCalled()

    const options = await app.request(
      '/api/v1/specialists/sp_link_profile/account-links',
      { method: 'OPTIONS', headers: { Origin: ORIGIN } },
    )
    expect(options.status).toBe(204)
    expect(options.headers.get('allow')).toBe('POST, OPTIONS')
  })

  it('maps structural conflicts to a fixed non-PII 409 envelope', async () => {
    const secret = 'private-profile-envelope'
    const postSpecialistAccountLink = vi.fn(async () => {
      const error = new Error('SPECIALIST_LINK_CONFLICT')
      error.details = { profile: secret }
      throw error
    })
    const response = await createApp(depsFor({ postSpecialistAccountLink })).request(
      '/api/v1/specialists/sp_link_profile/account-links',
      mutation(),
    )
    const body = await response.json()
    expect(response.status).toBe(409)
    expect(body.error.code).toBe('SPECIALIST_LINK_CONFLICT')
    expect(body.error).not.toHaveProperty('details')
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(new AppError('SPECIALIST_LINK_CONFLICT').status).toBe(409)
  })
})
