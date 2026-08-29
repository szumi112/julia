import { compareUtf16CodeUnits } from '../../src/code-unit-order.js'
import { decryptForScope, loadDataKey } from '../security/envelope.js'

const IDENTITY_SCOPE = Object.freeze({
  type: 'staff_directory', id: 'centre_1', purpose: 'identity',
})
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/

const fail = () => { throw new Error('CRYPTO_FAILURE') }

const labelsForRows = async ({ db, keyring, rows }) => {
  const keys = new Map()
  const labels = []
  for (const row of rows) {
    if (!SPECIALIST_ID.test(row.id ?? '')) fail()
    let envelope
    try { envelope = JSON.parse(row.display_name_envelope) } catch { fail() }
    const keyId = `${envelope?.dataKeyId}\n${envelope?.dataKeyVersion}`
    let dataKey = keys.get(keyId)
    if (!dataKey) {
      dataKey = await loadDataKey(db, { envelope, expectedScope: IDENTITY_SCOPE })
      keys.set(keyId, dataKey)
    }
    let label
    try {
      label = await decryptForScope(keyring, dataKey, {
        expectedScope: IDENTITY_SCOPE, recordId: row.id,
        field: 'display_name', envelope,
      })
    } catch { fail() }
    if (typeof label !== 'string' || !label
      || label !== label.trim().normalize('NFC')
      || /[\p{Cc}\p{Cf}]/u.test(label)
      || new TextEncoder().encode(label).byteLength > 120) fail()
    labels.push(Object.freeze({ id: row.id, label }))
  }
  labels.sort((left, right) => compareUtf16CodeUnits(left.label, right.label)
    || compareUtf16CodeUnits(left.id, right.id))
  return Object.freeze(labels)
}

export async function loadWorkbookSpecialistDirectory({ db, keyring } = {}) {
  if (!db?.prepare || !keyring) fail()
  const rows = (await db.prepare(
    `SELECT id,display_name_envelope,version FROM specialists
     WHERE status='active' ORDER BY id LIMIT 101`,
  ).all()).results
  if (!Array.isArray(rows) || rows.length > 100
    || rows.some(({ version }) => !Number.isSafeInteger(version) || version < 1)) fail()
  return Object.freeze({
    options: await labelsForRows({ db, keyring, rows }),
    snapshot: Object.freeze(rows.map(({ id, version }) => Object.freeze({ id, version }))),
  })
}

export async function loadWorkbookSpecialistOptions(input) {
  return (await loadWorkbookSpecialistDirectory(input)).options
}

export async function loadWorkbookSpecialistLabels({ db, keyring, ids } = {}) {
  if (!db?.prepare || !keyring || !Array.isArray(ids)) fail()
  const unique = [...new Set(ids)].sort(compareUtf16CodeUnits)
  if (unique.length > 100 || unique.some((id) => !SPECIALIST_ID.test(id))) fail()
  if (unique.length === 0) return Object.freeze([])
  const rows = (await db.prepare(
    `SELECT id,display_name_envelope FROM specialists
     WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
  ).bind(JSON.stringify(unique)).all()).results
  if (!Array.isArray(rows) || rows.length !== unique.length) fail()
  return labelsForRows({ db, keyring, rows })
}
