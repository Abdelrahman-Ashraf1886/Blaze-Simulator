import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage, statFile } from '@electron/asar'
import { verifyPackagedFuses } from './fuses.mjs'

const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)))
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const pkg = json(join(root, 'package.json'))
const { version } = pkg
const output = join(root, 'release', version)
const exe = `${pkg.productName}.exe`
const stockExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const sqlite = 'node_modules/better-sqlite3/prebuilds/win32-x64.node'
const replay = 'build/self-check/self-check.json'
const engine = 'engine/drone-engine.exe'
const notices = 'notices/THIRD-PARTY-NOTICES.txt'
const payloadFiles = [exe, 'resources/app.asar', ...[
  `app.asar.unpacked/${sqlite}`, engine, notices, replay,
].map((path) => `resources/${path}`)]
const offline = fileURLToPath(new URL('./offline.cjs', import.meta.url)).replaceAll('\\', '/')
const env = {
  ...process.env,
  CARGO_BUILD_JOBS: '1',
  CARGO_NET_OFFLINE: 'true',
  npm_config_offline: 'true',
  ELECTRON_BUILDER_OFFLINE: 'true',
  NODE_OPTIONS: `--require "${offline}"`,
}

function run(file, args, { input, capture = false } = {}) {
  const result = spawnSync(file, args, {
    cwd: root, env, windowsHide: true, input, encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} exited with ${result.status ?? result.signal}`)
  return result.stdout
}

function cleanGeneratedDirectory(path) {
  if (realpathSync(dirname(path)) !== dirname(path)) throw new Error(`Unexpected output parent for ${path}`)
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (!entry) return
  if (!entry.isDirectory() || realpathSync(path) !== path) throw new Error(`Unexpected output directory ${path}`)
  rmSync(path, { recursive: true })
}

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function inspectAsar(archive) {
  const contents = listPackage(archive).map((path) => path.replaceAll('\\', '/').replace(/^\//, ''))
  const allowed = /^(?:out(?:\/|$)|node_modules(?:\/|$)|package\.json$)/
  const forbidden = /(?:^|\/)(?:tests?|__tests__|scripts|docs|documentation|src)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]s$|\.map$/i
  const extras = contents.filter((path) => !allowed.test(path) || forbidden.test(path))
  if (extras.length) throw new Error(`Unexpected ASAR entries: ${extras.slice(0, 20).join(', ')} (${extras.length} total)`)
  const metadata = JSON.parse(extractFile(archive, 'package.json'))
  if (metadata.version !== version || !contents.includes(pkg.main) || !statFile(archive, join(...sqlite.split('/'))).unpacked) {
    throw new Error('ASAR version, application entry point or unpacked SQLite binding is incorrect')
  }
  writeFileSync(join(output, 'ASAR-CONTENTS.txt'), contents.sort().join('\n') + '\n', 'utf8')
  console.log(`ASAR contents verified (${contents.length} entries)`)
}

async function verifyArtifacts(names, staged) {
  const stagedHashes = await Promise.all(payloadFiles.map((file) => digest(join(staged, file))))
  // electron-winstaller's installed full 7-Zip reader supports NSIS. Read both
  // x64 payloads without running either executable (extractAppPackage.nsh:73).
  const sevenZip = join(root, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe')
  for (const name of names) {
    const work = mkdtempSync(join(output, '.verify-'))
    try {
      const opts = ['-y', '-bso0', '-bsp0']
      const inner = 'app-64.7z'
      run(sevenZip, ['e', join(output, name), `-o${work}`, '-r', inner, ...opts])
      run(sevenZip, ['x', join(work, inner), `-o${work}`, ...opts, ...payloadFiles])
      for (const [index, file] of payloadFiles.entries()) {
        if (await digest(join(work, file)) !== stagedHashes[index]) throw new Error(`${name} payload differs: ${file}`)
      }
      console.log(`Payload verified: ${name}`)
    } finally {
      cleanGeneratedDirectory(work)
    }
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This release requires Windows x64')
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`)
  const started = performance.now()
  const npm = (...args) => run(process.execPath, [process.env.npm_execpath, ...args])
  const git = (...args) => run('git', args, { capture: true }).trim()
  const commit = git('rev-parse', 'HEAD')
  const dirty = git('status', '--porcelain').length > 0

  if (!process.argv.includes('--verify')) {
    if (!process.env.npm_execpath) throw new Error('Run the release through npm run release')
    mkdirSync(dirname(output), { recursive: true })
    cleanGeneratedDirectory(output)
    cleanGeneratedDirectory(join(root, 'out'))
    npm('run', 'engine:build')
    npm('run', 'notices', '--', '--check')
    npm('run', 'dist')
  }

  if (realpathSync(output) !== output) throw new Error(`Unexpected release output directory ${output}`)
  const staged = join(output, 'win-unpacked')
  const resources = join(staged, 'resources')
  const fuses = await verifyPackagedFuses(join(staged, exe), stockExe)
  console.log('Packaged Electron fuses verified', fuses)
  inspectAsar(join(resources, 'app.asar'))
  const input = '{"id":0,"type":"hello"}\n'
  const reply = JSON.parse(run(join(resources, engine), [], { input, capture: true }))
  if (!reply.ok || reply.id !== 0 || reply.result?.engineVersion !== version ||
      json(join(resources, replay)).engineVersion !== version) {
    throw new Error('Packaged engine or self-check version does not match the app version')
  }
  if (await digest(join(resources, notices)) !== await digest(join(root, 'build', notices))) {
    throw new Error('Packaged notices differ from the strictly checked copy')
  }

  const artifacts = [`BlazeUAV-Setup-${version}.exe`, `BlazeUAV-Portable-${version}.exe`]
  await verifyArtifacts(artifacts, staged)
  const files = await Promise.all(artifacts.map(async (name) => {
    const path = join(output, name)
    return { name, bytes: statSync(path).size, sha256: await digest(path) }
  }))
  const manifest = {
    appVersion: version,
    engineVersion: reply.result.engineVersion,
    protocolVersion: reply.result.protocolVersion,
    electronVersion: json(join(root, 'node_modules', 'electron', 'package.json')).version,
    commit,
    dirty,
    artifacts: files,
  }
  writeFileSync(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  writeFileSync(join(output, 'SHA256SUMS.txt'), files.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(''), 'utf8')
  for (const { name, bytes } of files) console.log(`${name}: ${bytes} bytes`)
  console.log(`Release ready in ${relative(root, output)} (${((performance.now() - started) / 1000).toFixed(1)} s)`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
