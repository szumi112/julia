import {
  loadFinanceWindow,
  voidFinanceEntry,
} from '../core/finance-reporting.js'
import { AppError } from '../http/errors.js'

const exact = (value, keys, optional) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INTERNAL_ERROR')
  const actual = Reflect.ownKeys(value)
  const expected = Object.hasOwn(value, optional) ? [...keys, optional] : keys
  if (actual.length !== expected.length || !expected.every((key) => actual.includes(key))) {
    throw new Error('INTERNAL_ERROR')
  }
  return value
}

const validation = (field = 'body') => { throw new AppError('VALIDATION_FAILED', { field }) }

const callFinanceService = async (operation, fields) => {
  try { return await operation() } catch (error) {
    const match = /^VALIDATION_FAILED\/(selectedMonth|financeVoid)$/.exec(error?.message ?? '')
    if (match) validation(fields[match[1]])
    throw error
  }
}

export async function getFinanceWindow(input) {
  const command = exact(input, ['db', 'actor', 'keyring', 'nowMs', 'url'], 'load')
  let url
  try { url = new URL(command.url) } catch { validation('month') }
  const keys = [...url.searchParams.keys()]
  if (keys.length !== 1 || keys[0] !== 'month'
    || url.search !== `?month=${url.searchParams.get('month')}`) validation('month')
  const selectedMonth = url.searchParams.get('month')
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(selectedMonth ?? '')) validation('month')
  return callFinanceService(() => (command.load ?? loadFinanceWindow)({
    db: command.db, actor: command.actor, keyring: command.keyring,
    nowMs: command.nowMs, selectedMonth,
  }), { selectedMonth: 'month' })
}

export async function postFinanceEntryVoid(input) {
  const command = exact(input, [
    'db', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory', 'entryId',
    'body', 'idempotencyKey',
  ], 'service')
  const body = command.body
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.getPrototypeOf(body) !== Object.prototype
    || Reflect.ownKeys(body).length !== 2
    || !Object.hasOwn(body, 'expectedVersion') || !Object.hasOwn(body, 'reason')) {
    validation('body')
  }
  return callFinanceService(() => (command.service ?? voidFinanceEntry)({
    db: command.db, actor: command.actor, keyring: command.keyring,
    nowMs: command.nowMs, correlationId: command.correlationId,
    idFactory: command.idFactory, entryId: command.entryId,
    expectedVersion: body.expectedVersion, reason: body.reason,
    idempotencyKey: command.idempotencyKey,
  }), { financeVoid: 'body' })
}
