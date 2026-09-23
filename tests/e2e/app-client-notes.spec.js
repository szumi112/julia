import { expect, test } from '@playwright/test'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const csrfToken = `v1.${Date.parse('2030-01-01T00:00:00.000Z') / 1000}.${'A'.repeat(22)}.${'B'.repeat(43)}`
const json = (status, data) => ({
  status, contentType: 'application/json', body: JSON.stringify({ data }),
})

const session = (role) => json(200, {
  actor: {
    id: role === 'specialist' ? 'stf_note_e2e' : `stf_note_${role}`,
    displayName: role === 'specialist' ? 'Anna Nowak' : 'Osoba z zespołu',
    email: `${role}@example.test`,
    professionalTitle: role === 'coordinator' ? null : 'Psycholożka',
    role,
    specialistId: role === 'specialist' ? 'sp_note_e2e'
      : role === 'owner' ? 'sp_note_other' : null,
    version: 1,
  },
  authorityRevision: 1,
  capabilities: ROLE_DEFAULT_CAPABILITIES[role],
  csrfExpiresAt: '2030-01-01T00:00:00.000Z',
  csrfToken,
  dataMode: 'fictional',
  environment: 'development',
})

const workspace = (from, to) => json(200, {
  window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
  specialists: [{
    id: 'sp_note_e2e', displayName: 'Anna Nowak', professionalTitle: 'Psycholożka',
    standardRateGrosze: 18000, status: 'active', version: 1, staffVersion: 1,
  }, {
    id: 'sp_note_other', displayName: 'Ewa Druga', professionalTitle: 'Psycholożka',
    standardRateGrosze: 18000, status: 'active', version: 1, staffVersion: 1,
  }],
  clients: [{
    id: 'cl_notes', name: 'Fikcyjna Klientka', age: 12, status: 'active',
    version: 1, archivedAt: null, readOnly: false,
    createdAt: '2026-01-10T09:00:00.000Z', updatedAt: '2026-01-10T09:00:00.000Z',
    assignment: {
      id: 'asg_notes', specialistId: 'sp_note_e2e',
      startsAt: '2026-01-10T09:00:00.000Z', version: 1,
    },
  }],
  appointments: [], historicalClients: [], historicalOccurrences: [],
  latestPopulatedMonth: null,
})

const mockWorkspace = async (page, role) => {
  await page.route('**/api/v1/session', (route) => route.fulfill(session(role)))
  await page.route('**/api/v1/workspace?*', (route) => {
    const query = new URL(route.request().url()).searchParams
    return route.fulfill(workspace(query.get('from'), query.get('to')))
  })
}

test('@specialist retries an uncertain note save with the same key and reads it on return', async ({ page }) => {
  await mockWorkspace(page, 'specialist')
  const saved = []
  const keys = []
  await page.route('**/api/v1/clients/cl_notes/notes*', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill(json(200, { items: saved, nextCursor: null }))
    }
    keys.push(route.request().headers()['idempotency-key'])
    if (keys.length === 1) return route.abort('connectionfailed')
    const { text } = route.request().postDataJSON()
    const note = {
      id: 'cno_note_e2e', clientId: 'cl_notes',
      authorStaffId: 'stf_note_e2e', authorSpecialistId: 'sp_note_e2e',
      createdAt: '2026-09-22T10:15:00.000Z', text,
    }
    saved.unshift(note)
    return route.fulfill(json(201, { note }))
  })

  await page.goto('./#/client?id=cl_notes')
  const notes = page.getByRole('region', { name: 'Notatki z sesji' })
  await expect(notes).toBeVisible()
  const input = notes.getByRole('textbox', { name: 'Treść notatki' })
  await input.fill('Fikcyjna obserwacja.\nDalszy krok.')
  await notes.getByRole('button', { name: 'Dodaj notatkę' }).click()
  await expect(notes.getByText('Nie udało się potwierdzić zapisu. Spróbuj ponownie.')).toBeVisible()
  await expect(input).toHaveValue('Fikcyjna obserwacja.\nDalszy krok.')
  await notes.getByRole('button', { name: 'Dodaj notatkę' }).click()
  await expect(notes.getByText('Fikcyjna obserwacja.\nDalszy krok.')).toBeVisible()
  await expect(notes.locator('.note__text')).toHaveCSS('white-space', 'pre-wrap')
  await expect(notes).toContainText('Anna Nowak')
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])

  await page.goto('./#/clients')
  await page.goto('./#/client?id=cl_notes')
  await expect(page.getByRole('region', { name: 'Notatki z sesji' }))
    .toContainText('Fikcyjna obserwacja.')
})

test('@owner @coordinator hides private notes from people outside the current lead role', async ({ page }, testInfo) => {
  await mockWorkspace(page, testInfo.project.name)
  const requests = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/clients/cl_notes/notes') requests.push(request)
  })
  await page.goto('./#/client?id=cl_notes')
  await expect(page.getByRole('heading', { name: 'Fikcyjna Klientka' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Notatki z sesji' })).toHaveCount(0)
  expect(requests).toHaveLength(0)
})
