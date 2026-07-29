import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net']
const SECRET_NAMES = [
  'BWM_BACKUP_KEK_V1',
  'BWM_DATA_KEK_V1',
  'BWM_LOOKUP_HMAC_V1',
  'CF_ACCESS_GROUP_TOKEN',
  'CF_D1_EXPORT_TOKEN',
  'SCW_SECRET_KEY',
]
const BACKEND_BINDINGS = [
  'ACCESS_AUD',
  'ACCESS_HEALTH_SERVICE_TOKEN_ID',
  'ACCESS_TEAM_DOMAIN',
  'ACTIVE_BACKUP_KEK_VERSION',
  'ACTIVE_DATA_KEK_VERSION',
  'ACTIVE_LOOKUP_KEY_VERSION',
  'APP_ENV',
  'APP_ORIGIN',
  'ARCHIVE',
  'ASSETS',
  'BWM_BACKUP_KEK_V1',
  'BWM_DATA_KEK_V1',
  'BWM_LOOKUP_HMAC_V1',
  'CF_ACCESS_GROUP_TOKEN',
  'CF_D1_EXPORT_TOKEN',
  'DATA_MODE',
  'DB',
  'SCW_SECRET_KEY',
]
const SEMVER_NUMBER = '(?:0|[1-9]\\d*)'
const SEMVER_PRERELEASE = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const EXACT_SEMVER = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE}(?:\\.${SEMVER_PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
)

const relativePath = (root, path) => relative(root, path).split(sep).join('/')

const isInside = (root, path) => {
  const pathFromRoot = relative(root, path)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

const assertNoSymlinkComponents = (root, path) => {
  let resolvedPath = resolve(path)
  if (!isInside(root, resolvedPath)) {
    try {
      resolvedPath = realpathSync(resolvedPath)
    } catch {
      throw new Error(`Path must remain inside project root: ${path}`)
    }
  }
  if (!isInside(root, resolvedPath)) throw new Error(`Path must remain inside project root: ${path}`)
  let current = root
  for (const component of relative(root, resolvedPath).split(sep).filter(Boolean)) {
    current = join(current, component)
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink is not allowed: ${current}`)
  }
}

const requirePathType = (path, type) => {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    throw new Error(`Missing required ${type}: ${path}`)
  }
  if (stats.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${path}`)
  if ((type === 'file' && !stats.isFile()) || (type === 'directory' && !stats.isDirectory())) {
    throw new Error(`Expected regular ${type}: ${path}`)
  }
  return stats
}

const parseJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`Invalid JSON: ${path}`)
  }
}

const resolveRegularInside = ({ base, value, projectRoot, appRoot, type, field }) => {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) {
    throw new Error(`${field} must be a relative path`)
  }
  const candidate = resolve(base, value)
  assertNoSymlinkComponents(projectRoot, candidate)
  requirePathType(candidate, type)
  const resolved = realpathSync(candidate)
  if (!isInside(appRoot, resolved)) throw new Error(`${field} must resolve inside dist/app`)
  return resolved
}

const walkRegularFiles = (path) => {
  requirePathType(path, 'directory')
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${entryPath}`)
      if (entry.isDirectory()) {
        visit(entryPath)
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.map')) throw new Error(`Source maps are not allowed: ${entryPath}`)
        files.push(entryPath)
      } else {
        throw new Error(`Unexpected non-regular file: ${entryPath}`)
      }
    }
  }
  visit(path)
  return files
}

const assertNoRuntimeHosts = (contents, path) => {
  const normalized = contents.toLowerCase()
  for (const host of RUNTIME_HOSTS) {
    if (normalized.includes(host)) throw new Error(`Runtime dependency remains in ${path}: ${host}`)
  }
}

export const assertTrackedFiles = (paths) => {
  const forbidden = paths.filter((path) =>
    path.split(/[\\/]/).at(-1).endsWith('.xlsx')
    || path.split(/[\\/]/).at(-1).startsWith('.env')
    || path.split(/[\\/]/).at(-1).startsWith('.dev.vars')
    || path.split(/[\\/]/).includes('playwright-report')
    || path.split(/[\\/]/).includes('test-results')
  )
  if (forbidden.length) throw new Error(`Forbidden tracked files: ${forbidden.join(', ')}`)
}

export const assertDirectDependencyPins = (packageJson) => {
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(packageJson[section] || {})) {
      if (typeof version !== 'string' || !EXACT_SEMVER.test(version)) {
        throw new Error(`Direct dependency ${name} must use an exact semver version`)
      }
    }
  }
}

export const assertRuntimeIndex = (html) => assertNoRuntimeHosts(html, 'index.html')

export const inspectDeployArtifact = ({ root, configPath, secretValues = {} }) => {
  const projectRoot = realpathSync(root)
  const appRoot = resolve(projectRoot, 'dist/app')
  assertNoSymlinkComponents(projectRoot, appRoot)
  requirePathType(appRoot, 'directory')
  const resolvedAppRoot = realpathSync(appRoot)
  if (!isInside(projectRoot, resolvedAppRoot)) throw new Error('dist/app must remain inside project root')
  const deployRoot = join(projectRoot, '.wrangler/deploy')
  assertNoSymlinkComponents(projectRoot, deployRoot)
  requirePathType(deployRoot, 'directory')
  const resolvedDeployRoot = realpathSync(deployRoot)
  if (!isInside(projectRoot, resolvedDeployRoot)) throw new Error('.wrangler/deploy must remain inside project root')

  const deployEntries = readdirSync(deployRoot, { withFileTypes: true })
  if (deployEntries.length !== 1 || deployEntries[0]?.name !== 'config.json' || !deployEntries[0].isFile()) {
    throw new Error(`Unexpected file under .wrangler/deploy: ${deployEntries.map((entry) => entry.name).join(', ')}`)
  }

  const soleDeployConfigPath = join(deployRoot, 'config.json')
  assertNoSymlinkComponents(projectRoot, soleDeployConfigPath)
  requirePathType(soleDeployConfigPath, 'file')
  const resolvedSoleDeployConfigPath = realpathSync(soleDeployConfigPath)
  const deployConfigPath = configPath
    ? (isAbsolute(configPath) ? configPath : resolve(projectRoot, configPath))
    : soleDeployConfigPath
  assertNoSymlinkComponents(projectRoot, deployConfigPath)
  requirePathType(deployConfigPath, 'file')
  if (realpathSync(deployConfigPath) !== resolvedSoleDeployConfigPath) {
    throw new Error('configPath must resolve to the sole .wrangler/deploy/config.json')
  }
  const deployConfig = parseJson(deployConfigPath)
  if (
    !deployConfig
    || typeof deployConfig !== 'object'
    || Array.isArray(deployConfig)
    || Object.keys(deployConfig).length !== 1
    || typeof deployConfig.configPath !== 'string'
    || deployConfig.configPath.length === 0
    || isAbsolute(deployConfig.configPath)
  ) {
    throw new Error('Deploy config must contain only a relative configPath')
  }

  const workerConfigPath = resolveRegularInside({
    base: dirname(deployConfigPath),
    value: deployConfig.configPath,
    projectRoot,
    appRoot: resolvedAppRoot,
    type: 'file',
    field: 'configPath',
  })
  const workerConfig = parseJson(workerConfigPath)
  if (!workerConfig || typeof workerConfig !== 'object' || Array.isArray(workerConfig)) {
    throw new Error('Generated Worker config must be an object')
  }
  const workerPath = resolveRegularInside({
    base: dirname(workerConfigPath),
    value: workerConfig.main,
    projectRoot,
    appRoot: resolvedAppRoot,
    type: 'file',
    field: 'main',
  })
  const assetsPath = resolveRegularInside({
    base: dirname(workerConfigPath),
    value: workerConfig.assets?.directory,
    projectRoot,
    appRoot: resolvedAppRoot,
    type: 'directory',
    field: 'assets.directory',
  })
  const appFiles = walkRegularFiles(resolvedAppRoot)
  const browserFiles = walkRegularFiles(assetsPath)

  for (const browserFile of browserFiles) {
    const contents = readFileSync(browserFile, 'utf8')
    assertNoRuntimeHosts(contents, relativePath(projectRoot, browserFile))
    for (const binding of BACKEND_BINDINGS) {
      if (new RegExp(`\\b${binding}\\b`).test(contents)) {
        throw new Error(`Backend binding found in browser asset: ${binding} (${relativePath(projectRoot, browserFile)})`)
      }
    }
  }

  const filesToScan = [...new Set([...appFiles, deployConfigPath])]
  for (const [name, value] of Object.entries(secretValues)) {
    if (!SECRET_NAMES.includes(name) || typeof value !== 'string' || value.length === 0) continue
    const secret = Buffer.from(value)
    for (const file of filesToScan) {
      if (readFileSync(file).includes(secret)) {
        throw new Error(`Runtime secret ${name} found in ${relativePath(projectRoot, file)}`)
      }
    }
  }

  return { appRoot: resolvedAppRoot, assetsPath, workerPath }
}

const runCli = () => {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dist')) {
    throw new Error('Usage: node scripts/assert-repository-safety.mjs [--dist]')
  }
  const tracked = execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean)
  assertTrackedFiles(tracked)
  assertDirectDependencyPins(parseJson('package.json'))
  assertRuntimeIndex(readFileSync('index.html', 'utf8'))
  if (args[0] === '--dist') {
    const secretValues = Object.fromEntries(
      SECRET_NAMES.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : [])
    )
    inspectDeployArtifact({ root: process.cwd(), secretValues })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
