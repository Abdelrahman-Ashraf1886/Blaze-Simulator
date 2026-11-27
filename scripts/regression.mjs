import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const [option = '--check', reason, ...extra] = process.argv.slice(2)
const valid = option === '--check' ? reason === undefined : option === '--update' && reason?.trim() && !extra.length
if (!valid) {
  console.error('Usage: npm run regression OR npm run regression:update -- "<reason>"')
  process.exit(1)
}

const root = fileURLToPath(new URL('../', import.meta.url))
const env = { ...process.env, CARGO_BUILD_JOBS: '1', CARGO_NET_OFFLINE: 'true' }
delete env.BLAZE_GOLDEN_UPDATE_REASON
if (option === '--update') env.BLAZE_GOLDEN_UPDATE_REASON = reason.trim()

const started = performance.now()
function run(command, args) {
  const child = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`${command} exited with ${child.status ?? child.signal}`)
}

try {
  run('cargo', ['build', '--release', '--locked', '--offline', '--manifest-path', 'simulation-engine/Cargo.toml'])
  if (!existsSync(new URL('../tests/fixtures/hostile', import.meta.url))) {
    console.log('Hostile fixtures unavailable in tests/fixtures/hostile; skipping.')
  }
  run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/regression/vitest.config.mts'])
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  console.log(`Regression took ${((performance.now() - started) / 1000).toFixed(2)} s`)
}
