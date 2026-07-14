import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearRoleViewState,
  patchRouteViewState,
  readRouteViewState,
  resetRouteViewState,
} from '../../src/view-state.js'

test('view state is isolated by role and route', () => {
  let registry = {}
  registry = patchRouteViewState(registry, 'owner', 'clients', {
    query: 'Anna',
    filters: { psychologistId: 'p1' },
    period: 'month',
    date: '2026-07-14',
    pagination: { page: 2 },
    expansion: { c1: true },
    scrollY: 320,
  })
  registry = patchRouteViewState(registry, 'owner', 'calendar', { date: '2026-07-21' })
  registry = patchRouteViewState(registry, 'therapist', 'clients', { query: 'Marta' })

  assert.deepEqual(readRouteViewState(registry, 'owner', 'clients'), {
    query: 'Anna',
    filters: { psychologistId: 'p1' },
    period: 'month',
    date: '2026-07-14',
    pagination: { page: 2 },
    expansion: { c1: true },
    scrollY: 320,
  })
  assert.deepEqual(readRouteViewState(registry, 'owner', 'calendar'), { date: '2026-07-21' })
  assert.deepEqual(readRouteViewState(registry, 'therapist', 'clients'), { query: 'Marta' })
})

test('reading merges stored state over defaults without changing either input', () => {
  const defaults = { query: '', filters: { status: 'all' }, page: 1, scrollY: 0 }
  const registry = { owner: { clients: { query: 'Ola', page: 3 } } }

  const result = readRouteViewState(registry, 'owner', 'clients', defaults)

  assert.deepEqual(result, { query: 'Ola', filters: { status: 'all' }, page: 3, scrollY: 0 })
  assert.deepEqual(defaults, { query: '', filters: { status: 'all' }, page: 1, scrollY: 0 })
  assert.deepEqual(registry, { owner: { clients: { query: 'Ola', page: 3 } } })
  assert.notEqual(result, defaults)
  assert.notEqual(result, registry.owner.clients)
})

test('patching is immutable and preserves other roles and routes', () => {
  const registry = {
    owner: { clients: { query: 'Ola', page: 1 }, calendar: { date: '2026-07-14' } },
    therapist: { clients: { query: 'Marta' } },
  }

  const result = patchRouteViewState(registry, 'owner', 'clients', { page: 2, scrollY: 88 })

  assert.deepEqual(result.owner.clients, { query: 'Ola', page: 2, scrollY: 88 })
  assert.deepEqual(registry.owner.clients, { query: 'Ola', page: 1 })
  assert.notEqual(result, registry)
  assert.notEqual(result.owner, registry.owner)
  assert.notEqual(result.owner.clients, registry.owner.clients)
  assert.equal(result.owner.calendar, registry.owner.calendar)
  assert.equal(result.therapist, registry.therapist)
})

test('resetting one route leaves the role and its other routes intact', () => {
  const registry = {
    owner: { clients: { query: 'Ola' }, calendar: { date: '2026-07-14' } },
    therapist: { clients: { query: 'Marta' } },
  }

  const result = resetRouteViewState(registry, 'owner', 'clients')

  assert.deepEqual(result, {
    owner: { calendar: { date: '2026-07-14' } },
    therapist: { clients: { query: 'Marta' } },
  })
  assert.deepEqual(registry.owner.clients, { query: 'Ola' })
})

test('clearing one role leaves every other role intact', () => {
  const registry = {
    owner: { clients: { query: 'Ola' }, calendar: { date: '2026-07-14' } },
    therapist: { clients: { query: 'Marta' } },
  }

  const result = clearRoleViewState(registry, 'owner')

  assert.deepEqual(result, { therapist: { clients: { query: 'Marta' } } })
  assert.deepEqual(registry.owner.clients, { query: 'Ola' })
})
