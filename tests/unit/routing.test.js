import assert from 'node:assert/strict'
import test from 'node:test'
import { routeFromHash, routeHref } from '../../src/routing.js'

test('route hashes round-trip scalar and highlighted-session array parameters', () => {
  const hash = routeHref('calendar', {
    highlightSessionIds: ['s12', 's7'],
    date: '2026-07-16',
  })

  assert.equal(hash, '#/calendar?date=2026-07-16&highlightSessionIds=s12%2Cs7')
  assert.deepEqual(routeFromHash(hash), {
    name: 'calendar',
    params: {
      date: '2026-07-16',
      highlightSessionIds: ['s12', 's7'],
    },
  })
})

test('route hashes preserve boolean route parameters', () => {
  const hash = routeHref('payments', { unpaidOnly: true, allPeriods: false })

  assert.equal(hash, '#/payments?allPeriods=false&unpaidOnly=true')
  assert.deepEqual(routeFromHash(hash), {
    name: 'payments',
    params: { allPeriods: false, unpaidOnly: true },
  })
})

test('route hashes round-trip historical scalar parameters in canonical key order', () => {
  const hash = routeHref('clients', {
    ym: '2026-07', review: 'unknown', historyPeriod: 'known', catalog: 'historical',
  })

  assert.equal(hash, '#/clients?catalog=historical&historyPeriod=known&review=unknown&ym=2026-07')
  assert.deepEqual(routeFromHash(hash), {
    name: 'clients',
    params: {
      catalog: 'historical', historyPeriod: 'known', review: 'unknown', ym: '2026-07',
    },
  })
})

test('route parsing rejects empty, unrelated, and malformed hashes', () => {
  assert.equal(routeFromHash(''), null)
  assert.equal(routeFromHash('#/'), null)
  assert.equal(routeFromHash('#main-content'), null)
  assert.equal(routeFromHash('#/%E0%A4%A'), null)
})
