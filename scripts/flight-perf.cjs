const { spawnSync } = require('node:child_process')

const env = { ...process.env, CARGO_BUILD_JOBS: '1', CARGO_NET_OFFLINE: 'true', BLAZE_FLIGHT_PERF: '1' }
const build = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], { env, stdio: 'inherit' })
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)

const cli = require.resolve('@playwright/test/cli')
const spec = spawnSync(process.execPath, [cli, 'test', 'tests/e2e/flight-performance.spec.ts'], { env, stdio: 'inherit' })
if (spec.error) throw spec.error
process.exitCode = spec.status ?? 1
