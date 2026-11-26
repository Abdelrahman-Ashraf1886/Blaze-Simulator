const { spawnSync } = require('node:child_process')
const { writeFileSync, existsSync } = require('node:fs')
const { cpus, hostname, platform, release, totalmem } = require('node:os')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '../..')

async function main() {
  const [job, countText, target, extra, recording, ...surplus] = process.argv.slice(2)
  const count = Number(countText)
  const size = Number(target)
  if (!Number.isSafeInteger(count) || count < 1 || surplus.length ||
      !['startup', 'memory', 'workshop', 'step-cost'].includes(job) ||
      (job === 'startup' && (!target || extra)) ||
      (job === 'workshop' && (!['1080', '2160'].includes(target) || !extra || recording)) ||
      // Two measurement windows of 20 s each (measure.spec.ts:12 and flight-performance.spec.ts:21).
      (job === 'memory' && (!Number.isSafeInteger(size) || size < 2 * 20 || !extra || (recording && count !== 1))) ||
      (job === 'step-cost' && (!target || !extra || recording))) {
    throw new Error('Usage: npm run profile -- startup N OUT.json | workshop N 1080|2160 OUT.json | memory N SECONDS OUT.json [FIXTURE.blzr] | step-cost N FLIGHT.blzr OUT.json')
  }
  const buildCommit = process.env.BLAZE_PROFILE_BUILD_COMMIT
  if (!buildCommit) throw new Error('Set BLAZE_PROFILE_BUILD_COMMIT to the commit used to build the app and engine')
  if (process.platform !== 'win32') throw new Error('Desktop and engine measurements currently use Windows process APIs')
  const out = resolve(job === 'startup' ? target : extra)
  if (existsSync(out)) throw new Error(`Output already exists: ${out}`)
  if (recording && existsSync(resolve(recording))) throw new Error('Recording fixture output already exists')

  if (job === 'step-cost') {
    const state = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(__dirname, 'windows.ps1')], {
      encoding: 'utf8', windowsHide: true,
    })
    if (state.error || state.status !== 0) throw state.error ?? new Error(state.stderr.trim())
    const metadata = {
      ...JSON.parse(state.stdout), buildCommit, runCount: count,
      machine: { host: hostname(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, platform: platform(), release: release(), ramBytes: totalmem() },
    }
    const result = await require('./step-cost.cjs').measureCost(root, count, resolve(target), metadata)
    writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    console.log(`Wrote ${out}`)
    return
  }

  const shell = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', join(__dirname, 'measure.config.cjs')], {
    cwd: root,
    env: {
      ...process.env, BLAZE_PROFILE_JOB: job, BLAZE_PROFILE_COUNT: countText, BLAZE_PROFILE_SIZE: target,
      BLAZE_PROFILE_OUT: out, BLAZE_PROFILE_FIXTURE: recording ? resolve(recording) : '',
    },
    stdio: 'inherit',
  })
  if (shell.error) throw shell.error
  process.exitCode = shell.status ?? 1
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
