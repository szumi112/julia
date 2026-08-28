import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { createApp, CORE_ROUTE_DESCRIPTORS } from '../../worker/app.js'
import * as paymentCore from '../../worker/core/payments.js'
import * as paymentRoutes from '../../worker/routes/payments.js'
import { authorityActor } from './fixtures.js'
import {
  applyCoreDirectoryStageB,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const ORIGIN = 'https://bearwithme-panel.app'
const NOW = '2027-03-01T07:00:00.000Z'
const OWN_ACTOR = authorityActor({
  id: 'stf_own_payments_one',
  role: 'specialist',
  specialistId: 'sp_own_payments_one',
  capabilities: ['appointment.charge.read'],
})

const responseBody = Object.freeze({ data: Object.freeze({
  window: Object.freeze({
    from: '2027-03-01', to: '2027-03-31', timeZone: 'Europe/Warsaw', complete: true,
  }),
  appointments: Object.freeze([]),
}) })

const statement = () => ({
  bind: vi.fn(() => statement()),
  all: vi.fn(async () => ({ results: [] })),
  first: vi.fn(async () => null),
  raw: vi.fn(async () => []),
  run: vi.fn(async () => ({ success: true })),
})

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  const staff = (id, specialistId, subject) => env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,'{}','{}','specialist','active',?,?,1,?,NULL,?,?)`).bind(
    id, `lookup_${id}`, subject, specialistId, NOW, NOW, NOW,
  )
  const specialist = (id, staffId) => env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,18000,'active',1,NULL,?,?)`).bind(id, staffId, NOW, NOW)
  const client = (id) => env.DB.prepare(`INSERT INTO clients
    (id,identity_envelope,status,version,archived_at,created_at,updated_at)
    VALUES (?,'{}','active',1,NULL,?,?)`).bind(id, NOW, NOW)
  const appointment = (id, clientId, specialistId, startsAt) => {
    const endsAt = new Date(Date.parse(startsAt) + 50 * 60_000).toISOString()
    return env.DB.prepare(`INSERT INTO appointments
      (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
       status,source,version,cancelled_at,created_at,updated_at)
      VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,
        'completed','panel',1,NULL,?,?)`).bind(
      id, clientId, specialistId, startsAt, endsAt, NOW, NOW,
    )
  }
  const charge = (id, appointmentId) => env.DB.prepare(`INSERT INTO session_charges
    (id,appointment_id,service_id,expected_amount_grosze,currency,version,created_at,updated_at)
    VALUES (?,?,'zajecia',18000,'PLN',1,?,?)`).bind(id, appointmentId, NOW, NOW)
  const payment = (id, appointmentId, staffId, amount, receivedAt) => env.DB.prepare(`
    INSERT INTO payment_entries
    (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
     external_reference_envelope,created_at)
    VALUES (?,?,?,'card',?,?,NULL,?)`).bind(
    id, appointmentId, amount, receivedAt, staffId, receivedAt,
  )
  await env.DB.batch([
    staff('stf_own_payments_one', 'sp_own_payments_one', 'access-own-payments-one'),
    specialist('sp_own_payments_one', 'stf_own_payments_one'),
    staff('stf_own_payments_two', 'sp_own_payments_two', 'access-own-payments-two'),
    specialist('sp_own_payments_two', 'stf_own_payments_two'),
    client('cl_own_payments_visible'),
    client('cl_own_payments_hidden'),
    appointment(
      'apt_own_payments_visible', 'cl_own_payments_visible',
      'sp_own_payments_one', '2027-03-01T08:00:00.000Z',
    ),
    appointment(
      'apt_own_payments_hidden', 'cl_own_payments_hidden',
      'sp_own_payments_two', '2027-03-01T09:00:00.000Z',
    ),
    charge('chg_own_payments_visible', 'apt_own_payments_visible'),
    charge('chg_own_payments_hidden', 'apt_own_payments_hidden'),
    payment(
      'pay_own_payments_visible', 'apt_own_payments_visible',
      'stf_own_payments_one', 5_000, '2027-03-01T08:30:00.000Z',
    ),
    payment(
      'pay_own_payments_hidden', 'apt_own_payments_hidden',
      'stf_own_payments_two', 18_000, '2027-03-01T09:30:00.000Z',
    ),
  ])
})

describe('own payments projection', () => {
  it('exports a dedicated core read and route adapter', () => {
    expect(typeof paymentCore.loadOwnPaymentsWindow).toBe('function')
    expect(typeof paymentRoutes.getOwnPayments).toBe('function')
  })

  it('proves own scope in D1 and omits client and directory records', async () => {
    const result = await paymentCore.loadOwnPaymentsWindow({
      db: env.DB,
      actor: OWN_ACTOR,
      url: `${ORIGIN}/api/v1/payments/own?from=2027-03-01&to=2027-03-31`,
    })
    expect(result).toEqual({ data: {
      window: {
        from: '2027-03-01', to: '2027-03-31', timeZone: 'Europe/Warsaw', complete: true,
      },
      appointments: [{
        id: 'apt_own_payments_visible',
        serviceId: 'zajecia',
        startsAt: '2027-03-01T08:00:00.000Z',
        status: 'completed',
        version: 1,
        charge: {
          id: 'chg_own_payments_visible', serviceId: 'zajecia',
          expectedAmountGrosze: 18_000, currency: 'PLN', version: 1,
        },
        payment: {
          status: 'partial', collectedGrosze: 5_000, outstandingGrosze: 13_000,
          latestMethod: 'card', latestReceivedAt: '2027-03-01T08:30:00.000Z',
        },
      }],
    } })
    expect(JSON.stringify(result)).not.toMatch(/client|specialists|displayName|hidden/i)

    await expect(paymentCore.loadOwnPaymentsWindow({
      db: env.DB,
      actor: authorityActor({
        id: 'stf_own_payments_owner', role: 'owner', specialistId: null,
        capabilities: ['appointment.charge.read'],
      }),
      url: `${ORIGIN}/api/v1/payments/own?from=2027-03-01&to=2027-03-31`,
    })).rejects.toThrow(/^FORBIDDEN$/)
  })

  it('registers a charge-read-only route and never falls back to the broad workspace', async () => {
    const descriptor = CORE_ROUTE_DESCRIPTORS.find(({ id }) => id === 'payments.own')
    expect(descriptor).toMatchObject({
      path: '/api/v1/payments/own',
      capability: 'appointment.charge.read',
      methods: ['GET', 'HEAD', 'OPTIONS'],
      queryMode: 'handler',
    })
    const loadOwnPaymentsWindow = vi.fn(async () => responseBody)
    const getWorkspace = vi.fn(async () => { throw new Error('must not load workspace') })
    const db = Object.freeze({
      prepare: vi.fn(() => statement()),
      batch: vi.fn(async (statements) => statements.map(() => ({ success: true }))),
    })
    const app = createApp({
      config: { appEnv: 'staging', appOrigin: ORIGIN, dataMode: 'fictional' },
      db,
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      now: () => Date.parse(NOW),
      resolveAccessPrincipal: async () => ({
        kind: 'human', subject: 'access-own-payments-one',
        normalizedEmail: 'own-payments@example.test',
      }),
      resolveActor: async () => OWN_ACTOR,
      verifyCsrfToken: async () => true,
      safeLog: vi.fn(),
      loadOwnPaymentsWindow,
      getWorkspace,
    })
    const path = '/api/v1/payments/own?from=2027-03-01&to=2027-03-31'
    const response = await app.request(path)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(responseBody)
    expect(loadOwnPaymentsWindow).toHaveBeenCalledWith(expect.objectContaining({
      actor: OWN_ACTOR,
      url: `http://localhost${path}`,
    }))
    expect(getWorkspace).not.toHaveBeenCalled()

    const head = await app.request(path, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })
})
