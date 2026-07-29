import { decodeBase64Url } from './encoding.js'

const RESERVED = [
  ['BWM_DATA_KEK_V', 'data'],
  ['BWM_LOOKUP_HMAC_V', 'lookup'],
  ['BWM_BACKUP_KEK_V', 'backup'],
]
const VERSION = /^[1-9]\d*$/

const fail = (binding) => {
  throw new Error(`KEYRING_INVALID:${binding}`)
}

const validVersion = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const importKey = async (kind, raw) => {
  if (kind === 'lookup') return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function createKeyring(env, config) {
  const stores = { data: new Map(), lookup: new Map(), backup: new Map() }
  for (const [binding, value] of Object.entries(env ?? {})) {
    const reserved = RESERVED.find(([prefix]) => binding.startsWith(prefix))
    if (!reserved) continue
    const [prefix, kind] = reserved
    const suffix = binding.slice(prefix.length)
    if (!VERSION.test(suffix) || !Number.isSafeInteger(Number(suffix)) || typeof value !== 'string') fail(binding)
    let raw
    try {
      raw = decodeBase64Url(value)
      if (raw.byteLength !== 32) fail(binding)
      stores[kind].set(Number(suffix), await importKey(kind, raw))
    } catch (error) {
      if (error?.message?.startsWith('KEYRING_INVALID:')) throw error
      fail(binding)
    } finally {
      raw?.fill(0)
    }
  }
  const activeDataKekVersion = config?.activeDataKekVersion
  const activeLookupKeyVersion = config?.activeLookupKeyVersion
  const activeBackupKekVersion = config?.activeBackupKekVersion
  for (const [binding, version, store] of [
    ['BWM_DATA_KEK_V', activeDataKekVersion, stores.data],
    ['BWM_LOOKUP_HMAC_V', activeLookupKeyVersion, stores.lookup],
    ['BWM_BACKUP_KEK_V', activeBackupKekVersion, stores.backup],
  ]) {
    if (version === undefined) continue
    if (!validVersion(version)) fail(binding)
    if (!store.has(version)) fail(`${binding}${version}`)
  }
  const versions = (store) => Object.freeze([...store.keys()].sort((left, right) => right - left))
  return Object.freeze({
    activeDataKekVersion,
    activeLookupKeyVersion,
    activeBackupKekVersion,
    dataKekVersions: versions(stores.data),
    lookupKeyVersions: versions(stores.lookup),
    backupKekVersions: versions(stores.backup),
    getDataKek: (version) => stores.data.get(version) ?? null,
    getLookupHmac: (version) => stores.lookup.get(version) ?? null,
    getBackupKek: (version) => stores.backup.get(version) ?? null,
  })
}
