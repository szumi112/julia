const ARRAY_PARAMS = new Set(['highlightSessionIds'])
const BOOLEAN_PARAMS = new Set(['allPeriods', 'unpaidOnly'])

export function routeHref(route, params = {}) {
  const search = new URLSearchParams()
  Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return
      search.set(key, Array.isArray(value) ? value.join(',') : String(value))
    })
  const query = search.toString()
  return `#/${encodeURIComponent(route)}${query ? `?${query}` : ''}`
}

export function routeFromHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#/')) return null
  const [encodedName, query = ''] = hash.slice(2).split('?', 2)
  if (!encodedName) return null

  let name
  try {
    name = decodeURIComponent(encodedName)
  } catch {
    return null
  }

  const entries = Array.from(new URLSearchParams(query), ([key, value]) => {
    if (ARRAY_PARAMS.has(key)) return [key, value.split(',').filter(Boolean)]
    if (BOOLEAN_PARAMS.has(key) && (value === 'true' || value === 'false')) {
      return [key, value === 'true']
    }
    return [key, value]
  })
  const params = Object.fromEntries(entries)
  return entries.length > 0 ? { name, params } : { name }
}
