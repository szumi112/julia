import assert from 'node:assert/strict'
import test from 'node:test'
import * as shellRouting from '../../src/shell-ctx.js'

test('exposes one pure shell route authority contract', () => {
  assert.equal(typeof shellRouting.canAccessShellRoute, 'function')
  assert.equal(typeof shellRouting.firstAccessibleShellRoute, 'function')
  assert.equal(typeof shellRouting.resolveShellRoute, 'function')
})

const demoContext = (roleId) => ({ appMode: 'demo', roleId, capabilities: [] })
const appContext = (capabilities, roleId = 'owner') => ({ appMode: 'app', roleId, capabilities })

test('preserves the exact demo role navigation including detail routes', () => {
  const expectations = {
    owner: [
      'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup', 'team',
      'psych', 'payments', 'reports', 'settings', 'profile',
    ],
    coordinator: [
      'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup',
      'payments', 'settings', 'profile',
    ],
    therapist: [
      'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup', 'settings', 'profile',
    ],
  }
  const routes = [
    'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup', 'team',
    'psych', 'payments', 'ledger', 'reports', 'history', 'settings', 'profile', 'unknown',
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
      accessible: [
        'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup', 'english',
        'payments', 'profile',
      ],
    },
    {
      capabilities: ['tus.manage'],
      accessible: ['profile'],
    },
    {
      capabilities: ['staff.manage'],
      accessible: ['team', 'psych', 'profile'],
    },
    {
      capabilities: ['permissions.manage'],
      accessible: ['team', 'profile'],
    },
    {
      capabilities: ['appointment.charge.read'],
      accessible: ['payments', 'profile'],
    },
    {
      capabilities: ['finance.centre.read'],
      accessible: ['payments', 'ledger', 'reports', 'profile'],
    },
    {
      capabilities: ['activity.read'],
      accessible: ['history', 'profile'],
    },
    {
      capabilities: [],
    accessible: ['profile'],
    },
  ]
  const routes = [
    'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup', 'team',
    'psych', 'payments', 'ledger', 'reports', 'history', 'settings', 'profile', 'english', 'unknown',
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
      { appMode: 'app', roleId: 'owner', capabilities: ['permissions.manage'] },
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
    'profile',
  )
  assert.equal(
    shellRouting.firstAccessibleShellRoute(appContext(['finance.centre.read'])),
    'payments',
  )
  assert.equal(shellRouting.firstAccessibleShellRoute(appContext([])), 'profile')
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

test('falls back from protected settings to the profile when no settings section is available', () => {
  assert.deepEqual(
    shellRouting.resolveShellRoute(appContext(['tus.manage']), { name: 'settings' }),
    { name: 'profile' },
  )
  assert.deepEqual(
    shellRouting.resolveShellRoute(appContext(['staff.manage']), { name: 'settings' }),
    { name: 'profile' },
  )
})

test('protected data security settings belong only to an owner with health access', () => {
  assert.equal(
    shellRouting.canAccessShellRoute(appContext(['operations.health.read'], 'owner'), 'settings'),
    true,
  )
  for (const roleId of ['coordinator', 'specialist']) {
    const context = appContext(['operations.health.read'], roleId)
    assert.equal(shellRouting.canAccessShellRoute(context, 'settings'), false)
    assert.deepEqual(
      shellRouting.resolveShellRoute(context, { name: 'settings', params: { section: 'security' } }),
      { name: 'profile' },
    )
  }
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
