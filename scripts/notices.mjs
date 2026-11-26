import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, 'build/notices/THIRD-PARTY-NOTICES.txt')
const read = (file) => readFileSync(file, 'utf8')
const json = (file) => JSON.parse(read(file))
const slash = (path) => path.replaceAll('\\', '/')
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
function run(file, args, env = process.env) {
  // A file descriptor also works where Windows sandboxes deny child-process pipes.
  const temporary = mkdtempSync(join(tmpdir(), 'blaze-notices-'))
  const stdout = join(temporary, 'stdout')
  const fd = openSync(stdout, 'w')
  try {
    const result = spawnSync(file, args, { cwd: root, env, stdio: ['ignore', fd, 'inherit'] })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(file + ' exited with status ' + result.status)
    return read(stdout)
  } finally {
    closeSync(fd)
    unlinkSync(stdout)
    rmdirSync(temporary)
  }
}

// Only reviewed SPDX identifiers. A new identifier must be reviewed even inside an OR.
const identifiers = new Set([
  '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'ISC', 'MIT',
  'OFL-1.1', 'Unicode-3.0', 'Unlicense', 'Zlib',
])

export function validateExpression(expression, label) {
  const tokens = typeof expression === 'string' ? expression.match(/[A-Za-z0-9.-]+|[()]|[^\s]/g) ?? [] : []
  let cursor = 0
  function term() {
    const token = tokens[cursor++]
    if (token !== '(') return identifiers.has(token)
    return group() && tokens[cursor++] === ')'
  }
  function group() {
    if (!term()) return false
    while (tokens[cursor] === 'AND' || tokens[cursor] === 'OR') {
      cursor++
      if (!term()) return false
    }
    return true
  }
  if (!group() || cursor !== tokens.length) {
    throw new Error(label + ': unknown licence expression ' + JSON.stringify(expression))
  }
  return expression
}

// Legacy Cargo syntax with both alternatives shipped in each archive as LICENSE-MIT and LICENSE-APACHE.
const legacyAlternatives = new Set(['matrixmultiply@0.3.11', 'rawpointer@0.2.1'])
// These virtual modules carry generated runtime code from the named bundler packages.
// The IDs come from generateBundle's chunk.modules for the three production builds.
const virtualOwners = new Map([
  ['\0rolldown/runtime.js', 'rolldown'],
  ['\0vite/preload-helper.js', 'vite'],
  ['\0vite/modulepreload-polyfill.js', 'vite'],
])
const licenceFile = /^(?:licen[cs]es?|copying|unlicense|notice|ofl)(?:$|[._-])/i
const nonTextFile = /\.(?:html?|json|spdx)$/i

class MissingLicence extends Error {}

export function packageNotice({ name, version, licence, directory, source, kind, declaredFile }) {
  const key = name + '@' + version
  const label = kind + ' ' + key
  const expression = legacyAlternatives.has(key) && licence === 'MIT/Apache-2.0'
    ? 'MIT OR Apache-2.0'
    : licence
  validateExpression(expression, label)
  if (!source) throw new Error(label + ': missing source URL')
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((file) => file.isFile() && licenceFile.test(file.name) && !nonTextFile.test(file.name))
    .map((file) => file.name)
  if (declaredFile && !files.includes(declaredFile)) files.push(declaredFile)
  const texts = files.sort(compare).map((file) => [slash(file), read(join(directory, file)).trimEnd()])
    .filter(([, body]) => body.trim())
  if (!texts.some(([file]) => file === slash(declaredFile ?? '') || !/^notice(?:$|[._-])/i.test(file))) {
    throw new MissingLicence(label + ': missing licence file')
  }
  return { name, version, expression, source, kind, texts }
}

export function npmRuntimeDirectories() {
  const args = ['--offline', 'ls', '--omit=dev', '--all', '--parseable']
  const cli = process.env.npm_execpath
  const listing = cli
    ? run(process.execPath, [cli, ...args])
    : process.platform === 'win32'
      ? run(process.env.ComSpec, ['/d', '/c', 'npm.cmd', ...args])
      : run('npm', args)
  return listing.trim().split(/\r?\n/).map((path) => resolve(path)).filter((path) => path !== resolve(root))
}

function npmDirectory(id) {
  const path = slash(id).split('?')[0]
  const match = /^(.*(?:^|\/)node_modules\/(?!\.)(?:@[^/]+\/)?[^/]+)(?:\/|$)/.exec(path)
  return match && resolve(match[1])
}

// Rolldown does not expose getWatchFiles() in generateBundle. Observe the CSS
// transforms' addWatchFile calls to include stylesheets that the build inlines.
function trackStylesheetImports(plugins, add) {
  for (const name of ['vite:css', '@tailwindcss/vite:generate:build']) {
    const transform = plugins.find((plugin) => plugin.name === name)?.transform
    if (typeof transform?.handler !== 'function') throw new Error('Missing CSS build hook: ' + name)
    const handler = transform.handler
    transform.handler = function (code, id, ...args) {
      const context = Object.create(this, {
        addWatchFile: { value: (file) => {
          if (/\.css$/i.test(file)) add(file)
          this.addWatchFile(file)
        } },
      })
      return handler.call(context, code, id, ...args)
    }
  }
}

export async function npmBundleDirectories() {
  const { resolveConfig } = await import('electron-vite')
  const { build, mergeConfig } = await import('vite')
  process.env.NODE_ENV_ELECTRON_VITE = 'production'
  const { config } = await resolveConfig({ root }, 'build', 'production')
  const packages = new Map()
  for (const target of ['main', 'preload', 'renderer']) {
    const add = (id) => {
      const owner = virtualOwners.get(id)
      const directory = owner ? join(root, 'node_modules', owner) : npmDirectory(id)
      if (!directory) return
      if (!packages.has(directory)) packages.set(directory, new Set())
      packages.get(directory).add(target)
    }
    if (!config?.[target]) throw new Error('Missing Vite build target: ' + target)
    await build(mergeConfig(config[target], {
      logLevel: 'warn',
      build: { write: false },
      plugins: [{
        name: 'third-party-notices',
        enforce: 'post',
        configResolved({ plugins }) {
          if (target === 'renderer') trackStylesheetImports(plugins, add)
        },
        generateBundle(_, bundle) {
          for (const item of Object.values(bundle)) {
            if (item.type === 'chunk') Object.keys(item.modules).forEach(add)
            else item.originalFileNames.forEach((file) => add(resolve(config[target].root ?? root, file)))
          }
        },
      }],
    }))
  }
  return packages
}

export function rustRuntimePackages() {
  // Follow only normal target edges from the owner of the packaged binary. Proc macros run at compile time.
  const metadata = JSON.parse(run('cargo', [
    'metadata', '--offline', '--locked', '--format-version', '1',
    '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', 'simulation-engine/Cargo.toml',
  ], { ...process.env, CARGO_BUILD_JOBS: '1' }))
  const host = metadata.packages.find((pkg) => metadata.workspace_members.includes(pkg.id) &&
    pkg.targets.some((target) => target.name === 'drone-engine' && target.kind.includes('bin')))
  if (!host) throw new Error('Cargo metadata has no workspace drone-engine binary')
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]))
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const seen = new Set()
  const pending = [host.id]
  while (pending.length) {
    const id = pending.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some(({ kind }) => kind === null) &&
          !packages.get(dep.pkg).targets.some(({ kind }) => kind.includes('proc-macro'))) {
        pending.push(dep.pkg)
      }
    }
  }
  return [...seen].filter((id) => !metadata.workspace_members.includes(id)).map((id) => packages.get(id))
}

function entry(name, version, expression, source, body) {
  return { name, version, expression, source, kind: 'component', texts: [['', body]] }
}

function platformNotices(px4) {
  const dist = join(root, 'node_modules/electron/dist')
  const versions = JSON.parse(run(join(dist, 'electron.exe'), ['-p', 'JSON.stringify(process.versions)'], {
    ...process.env, ELECTRON_RUN_AS_NODE: '1',
  }))
  const credits = read(join(dist, 'LICENSES.chromium.html'))
  const licence = read(join(dist, 'LICENSE'))
  if (!licence.includes('Permission is hereby granted') || !credits.includes('>Node.js</span>')) {
    throw new Error('Electron dist is missing its MIT terms or Node.js credits')
  }
  const shipped = (file) => 'Full licence text ships next to the application executable in ' + file +
    ' (in development, see node_modules/electron/dist).'
  const sqliteHeader = read(join(root, 'node_modules/better-sqlite3/deps/sqlite3/sqlite3.h'))
  const sqlite = /^#define SQLITE_VERSION\s+"([^"]+)"/m.exec(sqliteHeader)?.[1]
  const sqliteBlessing = sqliteHeader.match(/^\*\* The author disclaims copyright to this source code\.[\s\S]*?(?=\r?\n\*\*\r?\n\*{3})/m)?.[0]
  if (!sqlite || !sqliteBlessing) throw new Error('better-sqlite3: missing SQLite version or public domain statement')
  return [
    entry('Electron', versions.electron, 'MIT', 'https://github.com/electron/electron', shipped('LICENSE.electron.txt')),
    entry('Chromium and its bundled third-party components', versions.chrome, 'Multiple licences',
      'https://chromium.googlesource.com/chromium/src/', shipped('LICENSES.chromium.html')),
    entry('Node.js and its bundled third-party components', versions.node, 'MIT and bundled licences',
      'https://github.com/nodejs/node', shipped('LICENSES.chromium.html, under Node.js')),
    entry('SQLite (better-sqlite3)', sqlite, 'Public domain', 'https://sqlite.org/copyright.html',
      sqliteBlessing.replace(/^\*\* ?/gm, '')),
    entry('PX4-Autopilot', 'v1.13.3', 'BSD-3-Clause', 'https://github.com/PX4/PX4-Autopilot/tree/v1.13.3',
      px4),
  ]
}

export function renderNotices(entries, issues = [], otherSources = '') {
  const groups = new Map()
  for (const item of entries) {
    if (!groups.has(item.expression)) groups.set(item.expression, [])
    groups.get(item.expression).push(item)
  }
  const sections = ['Blaze UAV third-party notices']
  if (issues.length) {
    sections.push('DRAFT — INCOMPLETE THIRD-PARTY LICENCE EVIDENCE\n' + issues.map((issue) => '- ' + issue).join('\n'))
  }
  for (const expression of [...groups.keys()].sort(compare)) {
    sections.push('=== ' + expression + ' ===')
    const sorted = groups.get(expression).sort((a, b) =>
      compare(a.name, b.name) || compare(a.version, b.version) || compare(a.kind, b.kind))
    for (const { name, version, kind, source, texts } of sorted) {
      sections.push([name + '@' + version + ' [' + kind + ']', 'Source: ' + source,
        ...texts.map(([file, body]) => (file ? '\n-- ' + file + ' --\n' : '\n') + body)].join('\n'))
    }
  }
  if (otherSources) sections.push(otherSources.trimEnd())
  return sections.join('\n\n').replace(/\r\n/g, '\n') + '\n'
}

export async function collectNotices({ draft = false } = {}) {
  const lock = json(join(root, 'package-lock.json')).packages
  const npm = new Set([...npmRuntimeDirectories(), ...(await npmBundleDirectories()).keys()])
  const inputs = [...npm].sort(compare).map((directory) => {
    const pkg = json(join(directory, 'package.json'))
    const path = slash(relative(root, directory))
    // Node resolves from parent node_modules in linked worktrees. Require the locked version there too.
    const locked = lock[path] ?? (path.startsWith('../') ? lock['node_modules/' + pkg.name] : undefined)
    if (locked?.version !== pkg.version) throw new Error(pkg.name + ': installed version differs from package-lock.json')
    return { name: pkg.name, version: pkg.version, licence: pkg.license, directory,
      source: locked.resolved, kind: 'npm' }
  })
  for (const pkg of rustRuntimePackages()) {
    inputs.push({ name: pkg.name, version: pkg.version, licence: pkg.license, directory: dirname(pkg.manifest_path),
      declaredFile: pkg.license_file, source: pkg.repository ?? pkg.homepage, kind: 'crate' })
  }
  const issues = []
  const entries = []
  for (const input of inputs) {
    try {
      entries.push(packageNotice(input))
    } catch (error) {
      if (!(error instanceof MissingLicence)) throw error
      issues.push(error.message)
      const { name, version, kind, licence: expression, source } = input
      entries.push({ name, version, kind, expression, source, texts: [['', 'Licence text unavailable in the installed archive.']] })
    }
  }
  const px4 = read(join(root, 'simulation-engine/NOTICE-PX4.md')).trimEnd()
  if (/^ {2}- .* \*\r?$/m.test(px4)) issues.push('PX4-Autopilot v1.13.3: missing upstream headers marked in NOTICE-PX4.md')
  issues.sort(compare)
  if (!draft && issues.length) throw new Error(issues.join('\n'))
  const otherSources = read(join(root, 'build/notices/OTHER-SOURCES.txt'))
  return { entries: [...entries, ...platformNotices(px4)], issues, otherSources }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { entries, issues, otherSources } = await collectNotices({ draft: process.argv.includes('--draft') })
    const contents = renderNotices(entries, issues, otherSources)
    if (process.argv.includes('--check')) {
      if (!existsSync(output) || read(output).replace(/\r\n/g, '\n') !== contents) {
        throw new Error('Notice file is missing or out of date. Run npm run notices.')
      }
    } else {
      writeFileSync(output, contents, 'utf8')
    }
    if (issues.length) {
      throw new Error('Incomplete draft at ' + slash(relative(root, output)) + '\n' + issues.join('\n'))
    }
    console.log('Third-party notices verified: ' + slash(relative(root, output)))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
