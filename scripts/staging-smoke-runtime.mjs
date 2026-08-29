import { strFromU8, unzipSync } from 'fflate'

const MAX_EXPORT_BYTES = 10 * 1024 * 1024
const MAX_UNZIPPED_BYTES = 24 * 1024 * 1024
const MAX_PART_BYTES = 8 * 1024 * 1024
const failed = () => { throw new Error('STAGING_SMOKE_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

export const STAGING_TOP_LEVEL_ROUTES = Object.freeze([
  'dashboard', 'calendar', 'clients', 'tus', 'english', 'team', 'payments',
  'ledger', 'reports', 'settings',
])

export const STAGING_ROUTE_MATRIX = Object.freeze({
  owner: Object.freeze({
    allowed: Object.freeze([...STAGING_TOP_LEVEL_ROUTES]),
    denied: Object.freeze([]),
  }),
  coordinator: Object.freeze({
    allowed: Object.freeze(['dashboard', 'calendar', 'clients', 'tus', 'english', 'payments', 'ledger', 'reports', 'settings']),
    denied: Object.freeze(['team']),
  }),
  specialist: Object.freeze({
    allowed: Object.freeze(['dashboard', 'calendar', 'clients', 'tus', 'english', 'payments', 'settings']),
    denied: Object.freeze(['team', 'ledger', 'reports']),
  }),
})

export function independentRouteMatrixEvidence(role, observed) {
  const expected = STAGING_ROUTE_MATRIX[role]
  if (!expected || !plain(observed)
    || !Array.isArray(observed.allowed) || !Array.isArray(observed.denied)) return false
  const complete = [...expected.allowed, ...expected.denied]
  return complete.length === STAGING_TOP_LEVEL_ROUTES.length
    && STAGING_TOP_LEVEL_ROUTES.every((route) => complete.includes(route))
    && new Set(complete).size === complete.length
    && expected.allowed.length === observed.allowed.length
    && expected.denied.length === observed.denied.length
    && expected.allowed.every((route, index) => observed.allowed[index] === route)
    && expected.denied.every((route, index) => observed.denied[index] === route)
}

// Passed verbatim to BrowserContext.addInitScript so instrumentation exists before app code.
export function installPersistentSmokeInstrumentation({ sentinels, origin }) {
  const evidence = {
    decodedUrlLeak: false,
    rawUrlLeak: false,
    transientAttributeLeak: false,
    storageMutation: false,
    indexedDbMutation: false,
    cacheMutation: false,
    serviceWorkerMutation: false,
  }
  Object.defineProperty(globalThis, '__BWM_STAGING_SMOKE_EVIDENCE__', {
    value: evidence, configurable: false, enumerable: false, writable: false,
  })
  const has = (value, decoded) => {
    const raw = String(value ?? '')
    if (sentinels.some((sentinel) => raw.includes(sentinel))) {
      evidence[decoded ? 'decodedUrlLeak' : 'rawUrlLeak'] = true
    }
  }
  const url = (value) => {
    const raw = String(value ?? '')
    has(raw, false)
    let decoded = raw
    for (let index = 0; index < 3; index += 1) {
      try {
        const next = decodeURIComponent(decoded)
        if (next === decoded) break
        decoded = next
        has(decoded, true)
      } catch { break }
    }
  }
  const inspectAttribute = (node, name) => {
    if (!(node instanceof Element)) return
    const value = node.getAttribute(name)
    if (value !== null) {
      let candidate = value
      for (let index = 0; index < 4; index += 1) {
        if (sentinels.some((sentinel) => candidate.includes(sentinel))) {
          evidence.transientAttributeLeak = true
        }
        try {
          const next = decodeURIComponent(candidate)
          if (next === candidate) break
          candidate = next
        } catch { break }
      }
    }
  }
  const observer = new MutationObserver((records) => records.forEach((record) => {
    if (record.type === 'attributes') {
      inspectAttribute(record.target, record.attributeName)
      if (record.oldValue !== null) {
        let candidate = record.oldValue
        for (let index = 0; index < 4; index += 1) {
          if (sentinels.some((sentinel) => candidate.includes(sentinel))) {
            evidence.transientAttributeLeak = true
          }
          try {
            const next = decodeURIComponent(candidate)
            if (next === candidate) break
            candidate = next
          } catch { break }
        }
      }
    }
    if (record.type === 'childList') record.addedNodes.forEach((node) => {
      if (!(node instanceof Element)) return
      ;[node, ...node.querySelectorAll('*')].forEach((element) => {
        ;[...element.attributes].forEach(({ name }) => inspectAttribute(element, name))
      })
    })
  }))
  observer.observe(document, {
    subtree: true, childList: true, attributes: true, attributeOldValue: true,
  })
  url(location.href)
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name].bind(history)
    history[name] = function smokeHistory(state, title, next) {
      url(next)
      return original(state, title, next)
    }
  }
  addEventListener('hashchange', () => url(location.href))
  addEventListener('popstate', () => url(location.href))
  for (const name of ['setItem', 'removeItem', 'clear']) {
    const original = Storage.prototype[name]
    Storage.prototype[name] = function smokeStorage(...args) {
      evidence.storageMutation = true
      return original.apply(this, args)
    }
  }
  if (globalThis.indexedDB) {
    for (const name of ['open', 'deleteDatabase']) {
      const original = IDBFactory.prototype[name]
      IDBFactory.prototype[name] = function smokeIdb(...args) {
        evidence.indexedDbMutation = true
        return original.apply(this, args)
      }
    }
  }
  if (globalThis.caches) {
    for (const name of ['open', 'delete']) {
      const original = CacheStorage.prototype[name]
      CacheStorage.prototype[name] = function smokeCacheStorage(...args) {
        evidence.cacheMutation = true
        return original.apply(this, args)
      }
    }
    for (const name of ['put', 'add', 'addAll', 'delete']) {
      const original = Cache.prototype[name]
      Cache.prototype[name] = function smokeCache(...args) {
        evidence.cacheMutation = true
        return original.apply(this, args)
      }
    }
  }
  if (navigator.serviceWorker) {
    const register = ServiceWorkerContainer.prototype.register
    ServiceWorkerContainer.prototype.register = function smokeRegister(...args) {
      evidence.serviceWorkerMutation = true
      return register.apply(this, args)
    }
    const unregister = ServiceWorkerRegistration.prototype.unregister
    ServiceWorkerRegistration.prototype.unregister = function smokeUnregister(...args) {
      evidence.serviceWorkerMutation = true
      return unregister.apply(this, args)
    }
  }
  Object.defineProperty(globalThis, '__BWM_STAGING_SMOKE_ORIGIN__', {
    value: origin, enumerable: false,
  })
}

export function persistentSmokeEvidence(value) {
  const keys = [
    'decodedUrlLeak', 'rawUrlLeak', 'transientAttributeLeak', 'storageMutation',
    'indexedDbMutation', 'cacheMutation', 'serviceWorkerMutation',
  ]
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => typeof value[key] !== 'boolean')) failed()
  return Object.freeze({ clean: keys.every((key) => value[key] === false) })
}

export function canonicalContentLength(value, maximumBytes = MAX_EXPORT_BYTES) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) failed()
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count > maximumBytes) failed()
  return count
}

// Serialized into the page by Playwright; keep this function dependency-free.
export function authorityResetDomEvidence() {
  const input = document.querySelector('input[aria-label="Wybierz plik XLSX"]')
  const text = document.body?.innerText ?? ''
  return input instanceof HTMLInputElement
    && input.type === 'file'
    && input.disabled === false
    && input.files instanceof FileList
    && input.files.length === 0
    && !text.includes('Podgląd — nic nie zostało zapisane')
    && ![...document.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === 'Zapisz i rozpocznij import')
}

export async function installDomStorageMutationObserver({ context, page, onMutation }) {
  let session
  try {
    if (!context || typeof context.newCDPSession !== 'function' || !page
      || typeof onMutation !== 'function') failed()
    session = await context.newCDPSession(page)
    const events = [
      'DOMStorage.domStorageItemAdded',
      'DOMStorage.domStorageItemUpdated',
      'DOMStorage.domStorageItemRemoved',
      'DOMStorage.domStorageItemsCleared',
    ]
    for (const event of events) session.on(event, onMutation)
    await session.send('DOMStorage.enable')
    return Object.freeze({
      async close() {
        try {
          for (const event of events) session.off(event, onMutation)
          await session.detach()
          return true
        } catch { failed() }
      },
    })
  } catch (error) {
    try { await session?.detach() } catch { /* fail closed below */ }
    if (error?.message === 'STAGING_SMOKE_FAILED') throw error
    failed()
  }
}

function sentinelList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) failed()
  const result = value.map((sentinel) => {
    if (typeof sentinel !== 'string' || sentinel.length < 4 || sentinel.length > 200
      || sentinel !== sentinel.trim() || sentinel !== sentinel.normalize('NFC')
      || /[\p{Cc}\p{Cf}]/u.test(sentinel)) failed()
    return sentinel
  })
  if (new Set(result).size !== result.length) failed()
  return result
}

function decodeXmlEntities(value) {
  return value.replace(/&(#(?:x[0-9a-fA-F]+|\d+)|amp|apos|gt|lt|quot);/g, (match, entity) => {
    if (entity === 'amp') return '&'
    if (entity === 'apos') return "'"
    if (entity === 'gt') return '>'
    if (entity === 'lt') return '<'
    if (entity === 'quot') return '"'
    const point = entity[1]?.toLowerCase() === 'x'
      ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
    if (!Number.isSafeInteger(point) || point < 1 || point > 0x10ffff
      || (point >= 0xd800 && point <= 0xdfff)) failed()
    return String.fromCodePoint(point)
  }).replace(/&[^;\s<]{1,64};/g, () => failed())
}

function canonicalXmlText(bytes) {
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)
      || /<!DOCTYPE|<!ENTITY/i.test(source)) failed()
    let offset = 0
    let text = ''
    const attributes = []
    const token = /<!--[^]*?-->|<!\[CDATA\[([^]*?)\]\]>|<[^>]*>|([^<]+)/gy
    while (offset < source.length) {
      token.lastIndex = offset
      const match = token.exec(source)
      if (!match || match.index !== offset) failed()
      if (match[0].startsWith('<!') && !match[0].startsWith('<!--')
        && !match[0].startsWith('<![CDATA[')) failed()
      if (match[1] !== undefined) text += match[1]
      if (match[2] !== undefined) text += decodeXmlEntities(match[2])
      if (match[0].startsWith('<') && !match[0].startsWith('</')
        && !match[0].startsWith('<!') && !match[0].startsWith('<?')) {
        const attribute = /\s[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(["'])([^]*?)\1/g
        for (const value of match[0].matchAll(attribute)) {
          attributes.push(decodeXmlEntities(value[2]))
        }
      }
      if (text.length > MAX_PART_BYTES) failed()
      offset = token.lastIndex
    }
    return `${text}\0${attributes.join('\0')}`
  } catch (error) {
    if (error?.message === 'STAGING_SMOKE_FAILED') throw error
    failed()
  }
}

export function scanXlsxSentinels(bytes, input) {
  let files
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
      || bytes.byteLength > MAX_EXPORT_BYTES || !plain(input)
      || Reflect.ownKeys(input).length !== 2) failed()
    const inScope = sentinelList(input.inScopeSentinels)
    const outOfScope = sentinelList(input.outOfScopeSentinels)
    let expandedBytes = 0
    let oversized = false
    files = unzipSync(bytes, {
      filter: (file) => {
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0
          || file.originalSize > MAX_PART_BYTES
          || expandedBytes + file.originalSize > MAX_UNZIPPED_BYTES) {
          oversized = true
          return false
        }
        expandedBytes += file.originalSize
        return true
      },
    })
    if (oversized || !Object.hasOwn(files, '[Content_Types].xml')
      || Object.keys(files).length < 2) failed()
    const candidates = []
    for (const [name, part] of Object.entries(files)) {
      candidates.push(name.normalize('NFC'))
      candidates.push(strFromU8(part).normalize('NFC'))
      if (name.endsWith('.xml') || name.endsWith('.rels')) {
        candidates.push(canonicalXmlText(part).normalize('NFC'))
      }
    }
    return Object.freeze({
      inScopePresent: inScope.every((sentinel) => (
        candidates.some((content) => content.includes(sentinel))
      )),
      outOfScopeAbsent: outOfScope.every((sentinel) => (
        candidates.every((content) => !content.includes(sentinel))
      )),
    })
  } catch (error) {
    if (error?.message === 'STAGING_SMOKE_FAILED') throw error
    failed()
  } finally {
    if (files) Object.values(files).forEach((part) => part.fill(0))
  }
}

export function smokePersistenceEvidence(value) {
  try {
    const keys = ['local', 'session', 'databases', 'caches', 'workers']
    if (!plain(value) || Reflect.ownKeys(value).length !== keys.length
      || !keys.every((key) => Object.hasOwn(value, key))
      || Object.values(value).some((count) => !Number.isSafeInteger(count) || count < 0)) failed()
    return Object.freeze({ empty: Object.values(value).every((count) => count === 0) })
  } catch (error) {
    if (error?.message === 'STAGING_SMOKE_FAILED') throw error
    failed()
  }
}

export function apiStatusesOk(statuses) {
  return Array.isArray(statuses) && statuses.length >= 1
    && statuses.every((status) => Number.isSafeInteger(status) && status >= 200 && status < 300)
}

export function topbarActorDomEvidence({ displayName, presentation }) {
  const identities = document.querySelectorAll('.topbar .userchip--authenticated')
  if (identities.length !== 1) return false
  const identity = identities[0]
  return identity.querySelector('.userchip__name')?.textContent === displayName
    && identity.querySelector('.userchip__role')?.textContent === presentation
}

export function settingsActorDomEvidence({ displayName, presentation }) {
  const identities = document.querySelectorAll('.settings-account-identity')
  if (identities.length !== 1) return false
  const values = [...identities[0].querySelectorAll('strong')].map(({ textContent }) => textContent)
  return values.length === 2 && values[0] === displayName && values[1] === presentation
}

export function juliaTeamDomEvidence() {
  const cards = [...document.querySelectorAll('.team-card')].filter((card) => (
    card.querySelector('.team-card__name')?.textContent === 'Julia Wolanin'
  ))
  if (cards.length !== 1) return false
  const card = cards[0]
  const badgeTexts = [...card.querySelectorAll('.pill')].map(({ textContent }) => textContent?.trim())
  return card.querySelector('.team-card__spec')?.textContent?.startsWith('Specjalistka · ')
    && badgeTexts.includes('Dostęp aktywny') && !card.textContent.includes('Właściciel')
}
