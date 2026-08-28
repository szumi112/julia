import assert from 'node:assert/strict'
import test from 'node:test'
import * as shellRouting from '../../src/shell-ctx.js'

test('exposes one pure shell route authority contract', () => {
  assert.equal(typeof shellRouting.canAccessShellRoute, 'function')
  assert.equal(typeof shellRouting.firstAccessibleShellRoute, 'function')
  assert.equal(typeof shellRouting.resolveShellRoute, 'function')
})

const demoContext = (roleId) => ({ appMode: 'demo', roleId, capabilities: [] })
const appContext = (capabilities) => ({ appMode: 'app', roleId: 'owner', capabilities })

test('preserves the exact demo role navigation including detail routes', () => {
  const expectations = {
    owner: [
      'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup', 'team',
      'psych', 'payments', 'reports', 'settings',
    ],
    coordinator: [
      'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup',
      'payments', 'settings',
    ],
    therapist: [
      'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup', 'settings',
    ],
  }
  const routes = [
    'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup', 'team',
    'psych', 'payments', 'ledger', 'reports', 'settings', 'unknown',
  ]

  for (const [roleId, accessible] of Object.entries(expectations)) {
    for (const routeName of routes) {
      assert.equal(
        shellRouting.canAccessShellRoute(demoContext(roleId), routeName),
        accessible.includes(routeName),
        `${roleId}/${routeName}`,
      )
    }
    assert.equal(shellRouting.firstAccessibleShellRoute(demoContext(roleId)), 'dashboard')
  }
})

test('maps every rendered protected route to capabilities instead of role labels', () => {
  const cases = [
    {
      capabilities: [
        'appointment.charge.read',
        'client.operational.read',
        'specialist.directory.read',
      ],
      accessible: ['dashboard', 'calendar', 'clients', 'client', 'payments', 'settings'],
    },
    {
      capabilities: ['tus.manage'],
      accessible: ['tus', 'tusGroup', 'english', 'settings'],
    },
    {
      capabilities: ['staff.manage'],
      accessible: ['team', 'psych', 'settings'],
    },
    {
      capabilities: ['appointment.charge.read'],
      accessible: ['settings'],
    },
    {
      capabilities: ['finance.centre.read'],
      accessible: ['payments', 'ledger', 'reports', 'settings'],
    },
    {
      capabilities: [],
      accessible: ['settings'],
    },
  ]
  const routes = [
    'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup', 'team',
    'psych', 'payments', 'ledger', 'reports', 'settings', 'english', 'unknown',
  ]

  for (const { capabilities, accessible } of cases) {
    for (const routeName of routes) {
      assert.equal(
        shellRouting.canAccessShellRoute(appContext(capabilities), routeName),
        accessible.includes(routeName),
        `${capabilities.join(',') || 'empty'}/${routeName}`,
      )
    }
  }

  assert.equal(
    shellRouting.canAccessShellRoute(
      { appMode: 'app', roleId: 'coordinator', capabilities: ['staff.manage'] },
      'team',
    ),
    true,
  )
  assert.equal(
    shellRouting.canAccessShellRoute(
      { appMode: 'app', roleId: 'owner', capabilities: ['finance.centre.read'] },
      'team',
    ),
    false,
  )
})

test('selects the first accessible top-level route in product navigation order', () => {
  assert.equal(
    shellRouting.firstAccessibleShellRoute(appContext([
      'appointment.charge.read',
      'client.operational.read',
      'specialist.directory.read',
    ])),
    'dashboard',
  )
  assert.equal(
    shellRouting.firstAccessibleShellRoute(appContext(['tus.manage'])),
    'tus',
  )
  assert.equal(
    shellRouting.firstAccessibleShellRoute(appContext(['finance.centre.read'])),
    'payments',
  )
  assert.equal(shellRouting.firstAccessibleShellRoute(appContext([])), 'settings')
})

test('keeps an accessible requested route and rejects direct or programmatic unknown routes', () => {
  const context = appContext(['finance.centre.read'])
  const requested = { name: 'reports', params: { month: '2026-08' } }

  assert.equal(shellRouting.resolveShellRoute(context, requested), requested)
  assert.deepEqual(
    shellRouting.resolveShellRoute(context, { name: 'team', params: { id: 'stf_1' } }),
    { name: 'payments' },
  )
  assert.deepEqual(
    shellRouting.resolveShellRoute(context, { name: 'unknown' }),
    { name: 'payments' },
  )
  assert.equal(shellRouting.canAccessShellRoute(context, 'unknown'), false)
})

test('fails closed when the mode, demo role, or capability set is malformed', () => {
  assert.equal(shellRouting.canAccessShellRoute(demoContext('unknown'), 'dashboard'), false)
  assert.equal(shellRouting.firstAccessibleShellRoute(demoContext('unknown')), null)
  assert.equal(shellRouting.canAccessShellRoute({
    appMode: 'unknown', roleId: 'owner', capabilities: ['client.operational.read'],
  }, 'dashboard'), false)
  assert.equal(shellRouting.canAccessShellRoute(appContext(['unknown.capability']), 'settings'), false)
  assert.equal(shellRouting.firstAccessibleShellRoute(appContext(['unknown.capability'])), null)
  assert.equal(
    shellRouting.resolveShellRoute(appContext(['unknown.capability']), { name: 'dashboard' }),
    null,
  )
})
