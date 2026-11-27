import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const root = resolve(import.meta.dirname, '..')
const directory = 'documentation/validation'
const suite = 'tests/validation'
const inventory = join(directory, 'inventory.md')
const manifest = join('simulation-engine', 'Cargo.toml')
const binary = resolve(root, 'simulation-engine/target/release', process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine')
const verdicts = ['analytical', 'independent reference', 'published data', 'self-consistency only', 'not validated']
const sourceLines = new Map()
const lines = (file) => {
  if (!sourceLines.has(file)) sourceLines.set(file, readFileSync(resolve(root, file), 'utf8').split(/\r?\n/))
  return sourceLines.get(file)
}

let scratch

function run(command, args, { env = {}, input } = {}) {
  const stdoutPath = join(scratch, 'child.out')
  const stderrPath = join(scratch, 'child.err')
  const stdinPath = join(scratch, 'child.in')
  if (input !== undefined) writeFileSync(stdinPath, input, 'utf8')
  const stdin = input === undefined ? 'ignore' : openSync(stdinPath, 'r')
  const stdout = openSync(stdoutPath, 'w')
  const stderr = openSync(stderrPath, 'w')
  let result
  try {
    result = spawnSync(command, args, {
      cwd: root, stdio: [stdin, stdout, stderr],
      env: { ...process.env, CARGO_BUILD_JOBS: '1', CARGO_NET_OFFLINE: 'true', FORCE_COLOR: '0', ...env },
    })
  } finally {
    if (stdin !== 'ignore') closeSync(stdin)
    closeSync(stdout)
    closeSync(stderr)
  }
  if (result.error) throw result.error
  const output = { stdout: readFileSync(stdoutPath, 'utf8'), stderr: readFileSync(stderrPath, 'utf8') }
  if (result.status !== 0) {
    const tail = (output.stdout + '\n' + output.stderr).trim().split(/\r?\n/).slice(-30).join('\n')
    throw new Error(`${command} exited ${result.status ?? result.signal}\n${tail}`)
  }
  return output
}

const sourceLink = (file, line, label) => `[${label ?? `${file.split('/').at(-1)}:${line}`}](../../${file}#L${line})`
const normalize = (title) => title.replaceAll('’', "'").replaceAll('…', '')
const repoPath = (file) => relative(root, file).replaceAll('\\', '/')
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function inventoryAreas() {
  const equations = new Map()
  for (const entry of lines(join(directory, 'equations.tsv')).filter(Boolean)) {
    const [model, equation, extra] = entry.split('\t')
    if (!equation || extra || equations.has(model)) throw new Error(`Invalid equation entry for ${model}`)
    equations.set(model, equation)
  }
  const areas = []
  for (const [index, line] of lines(inventory).entries()) {
    if (line === '## Independent checks still needed') break
    if (line.startsWith('## ')) areas.push({ name: line.slice(3), models: [] })
    if (!line.startsWith('| ') || /^\| (Model |---)/.test(line)) continue
    const fields = line.slice(2, -2).split(' | ')
    const [name, implementation, source, check, comparison, tolerance, , range, verdict] = fields
    if (fields.length !== 9 || !verdicts.includes(verdict) || !equations.has(name)) {
      throw new Error(`${inventory}:${index + 1} has invalid fields or no equation for ${name}`)
    }
    const checks = Array.from(check.matchAll(/\[`([^`]+)`\]\(\.\.\/\.\.\/([^#]+)#L(\d+)\)/g), ([, title, file, line]) => ({
      title, file, line: Number(line),
    }))
    if (!checks.length && verdict !== 'not validated') throw new Error(`No executable check for ${name}`)
    areas.at(-1).models.push({ name, implementation, source, comparison, tolerance, range, verdict, checks, equation: equations.get(name) })
    equations.delete(name)
  }
  if (equations.size) throw new Error(`Unused equations: ${[...equations.keys()].join(', ')}`)
  return areas
}

function vitest(config, files, output, env, filters = []) {
  const result = run(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--includeTaskLocation',
    '--maxWorkers=1', '--reporter=verbose', '--reporter=json', `--outputFile.json=${output}`, ...filters, ...files,
  ], { env })
  const json = JSON.parse(readFileSync(output, 'utf8'))
  if (!json.success) throw new Error('Vitest did not report success')
  const tests = new Map(json.testResults.map((file) => [repoPath(file.name), file.assertionResults]))
  return { output: result.stdout, tests, passed: json.numPassedTests }
}

function passedRust(stdout) {
  const passed = new Set()
  const entries = [...stdout.matchAll(/^test (\S+)(?: - should panic)? \.\.\. /gm)]
  for (const [index, match] of entries.entries()) {
    const end = entries[index + 1]?.index ?? stdout.length
    if (/^ok\r?$/m.test(stdout.slice(match.index + match[0].length, end))) passed.add(match[1])
  }
  const total = stdout.match(/^test result: ok\. (\d+) passed;/m)
  if (!total || passed.size !== Number(total[1])) throw new Error('Could not match every passing Rust test to its result')
  return passed
}

function rustModule(file) {
  const path = file.split('/src/')[1].replace(/\.rs$/, '')
  // Inline tests are declared in a tests module. Dedicated files already carry its name.
  if (path.endsWith('/tests') || path.endsWith('/spin_study')) return path.replaceAll('/', '::')
  if (!lines(file).some((line) => /^mod tests \{/.test(line))) throw new Error(`Unknown Rust test module for ${file}`)
  return `${path}::tests`
}

function checkResult(check, rust, js) {
  if (check.file.startsWith('tests/e2e/')) return { ...check, status: 'source only' }
  if (check.file.endsWith('.rs')) {
    const key = `${rustModule(check.file)}::${check.title}`
    const line = lines(check.file).findIndex((line) => new RegExp(`^\\s*fn ${escapeRegex(check.title)}\\s*\\(`).test(line)) + 1
    if (!line || !rust.has(key)) throw new Error(`Missing passing Rust check ${key}`)
    return { ...check, line, status: 'passed' }
  }
  const matches = js.get(check.file)?.filter(({ title }) => normalize(title).startsWith(normalize(check.title))) ?? []
  if (matches.length !== 1 || matches[0].status !== 'passed' || !matches[0].location?.line) {
    throw new Error(`Missing unique passing Vitest check ${check.file}: ${check.title}`)
  }
  return { ...check, title: matches[0].title, line: matches[0].location.line, status: 'passed' }
}

function observations(output) {
  const byModel = new Map()
  for (const [, json] of output.matchAll(/^VALIDATION (\{[^\r\n]+\})/gm)) {
    const { model, metric, value, unit, file, line } = JSON.parse(json)
    if (!Number.isFinite(value) || !lines(file)[line - 1] || !metric || !unit) throw new Error(`Invalid observation: ${json}`)
    const entries = byModel.get(model) ?? []
    if (entries.some((entry) => entry.metric === metric)) throw new Error(`Duplicate observation: ${model} / ${metric}`)
    entries.push({ metric, value, unit, file, line })
    byModel.set(model, entries)
  }
  if (!byModel.size) throw new Error('Validation probes emitted no observations')
  return byModel
}

// Read these limits from the test statements themselves. The inventory supplies
// context for compound limits, exact predicates and tolerances defined by fixtures.
const core = 'simulation-engine/engine-core/src'
const unit = 'tests/unit'
const assertionSources = new Map([
  ['Shapes, assembly totals and tensor rotation', [[unit + '/mass.test.ts', /const close =/]]],
  ['Principal axes and engine handoff', [[unit + '/principal-axes.test.ts', /function expectDecomposition|m - sorted/]]],
  ['Static hover balance', [[unit + '/mass.test.ts', /const close =/]]],
  ['Frame mass allocation by primitive volume', [[unit + '/mass-input.test.ts', /close\(boxes\[1\]|close\(mp.totalMassKg/]]],
  ['Gravity, frame transforms and rigid-body integration', [[core + '/sim/tests.rs', /assert!.*vz \+ G \* t|assert!.*err <= bound/]]],
  ['Friction, single-point rebound and resting contact timing', [[core + '/environment/tests.rs', /assert!.*rebound speed|assert!.*rebound height/]]],
  ['Build thrust-curve fit and residual', [[unit + '/thrust-curve.test.ts', /expect\(result\.(rmsError|maxAbsError)\)\.toBeCloseTo\((Math.sqrt|Math.max)/]]],
  ['Static thrust fit, T-Motor source', [[unit + '/propulsion.test.ts', /expect\(fit.kT.maxAbsError\)\.toBeLessThan/]]],
  ['Rotor effectiveness, pseudoinverse and normalization', [[core + '/controller/tests.rs', /const EPS: f64/]]],
  ['Body-rate PID, feed-forward and anti-windup', [[core + '/controller/tests.rs', /const EPS: f64/]]],
  ['Position P, velocity PID, thrust vector and limits', [[core + '/position_control/tests.rs', /assert!\(\(a - b\)|assert!\(coarse.0 <|coarse.0 < .* && fine.0 </]]],
  ['Integrated takeoff/hold/land behavior', [[core + '/flight_loop/tests.rs', /const (HOLD_TOLERANCE_M|LANDED_TOLERANCE_M):/]]],
  ['Integrated return-to-start guidance', [[unit + '/scenario-protocol.test.ts', /expect\(errorM\[[01]\],/]]],
  ['Static notch, two-pole low-pass and derivative alpha filter', [[core + '/gyro_filters/tests.rs', /assert!.*measured\.[01] - gain/]]],
  ['Noisy gyro closed-loop hover and roll-rate response', [[unit + '/scenario-protocol.test.ts', /const limits = \{ rateRms: sigma|expect.soft\((excessive|riseS!)/]]],
])

function currentAssertions(model) {
  return (assertionSources.get(model) ?? []).flatMap(([file, pattern]) => {
    const matches = lines(file).flatMap((line, index) => {
      if (!pattern.test(line)) return []
      const text = line.trim()
      const delimiter = text.includes('`') ? '``' : '`'
      return [`${delimiter}${text}${delimiter} ${sourceLink(file, index + 1)}`]
    })
    if (!matches.length) throw new Error(`No source assertion for ${model} in ${file}`)
    return matches
  })
}

function render(areas, measured, metadata) {
  const models = areas.flatMap((area) => area.models)
  for (const name of measured.keys()) {
    if (!models.some((row) => row.name === name)) throw new Error(`Observation refers to unknown model ${name}`)
  }
  const report = [
    '# Validation report', '',
    '**Not compared with a real flight.** [Phase 8, D11(a)](../plans/phase-8-quality.md#L62)', '',
    ...metadata, '',
    '| Verdict | Models |', '| --- | ---: |',
    ...verdicts.map((verdict) => `| ${verdict} | ${models.filter((model) => model.verdict === verdict).length} |`),
    `| Total | ${models.length} |`, '',
    'The [README](README.md) explains how to read results and regenerate this report. The [inventory](inventory.md) lists open evidence gaps.',
  ]
  for (const { name, models } of areas) {
    report.push('', `## ${name}`, '')
    for (const verdict of ['self-consistency only', 'not validated']) {
      const flagged = models.filter((model) => model.verdict === verdict)
      if (flagged.length) report.push(`**${verdict === 'not validated' ? 'Not validated' : 'Self-consistency only'}** — ${flagged.map((row) => row.name).join('; ')}.`, '')
    }
    for (const model of models) {
      const { name, equation, source, implementation, comparison, tolerance, verdict, range, results } = model
      const runnable = results.filter((result) => result.status === 'passed')
      const numbers = measured.get(name) ?? []
      const assertions = currentAssertions(name)
      const result = numbers.length
        ? numbers.map(({ metric, value, unit, file, line }) => `  - ${metric} = ${value} ${unit} ${sourceLink(file, line)}`)
        : [runnable.length
          ? 'Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.'
          : 'No measurement or passing check available.']
      report.push(
        `### ${name}`, '',
        `- **Verdict** — ${verdict}`,
        `- **Model** — ${equation}`,
        `- **Source** — ${source} · Implementation ${implementation}`,
        `- **Check** — ${comparison === 'Not found' ? 'No check located.' : comparison} ${results.map(({ file, line, title, status }) => `${sourceLink(file, line, '`' + title + '`')} (${verdict === 'not validated' && status === 'passed' ? 'diagnostic ran' : status})`).join(' · ')}`.trimEnd(),
        `- **Result this run** — ${numbers.length ? 'See measurements below.' : result[0]}`,
        ...(numbers.length ? result : []),
        `- **Assertion limits** — ${tolerance}`,
        ...(assertions.length ? [`- **Current test statements** — ${assertions.join(' · ')}`] : []),
        `- **Range and limits** — ${range}`, '',
      )
    }
  }
  report.push('## Offline PX4 v1.13.3 sources', '',
    'The inventory lists the previously inspected [offline PX4 locators](inventory.md#offline-px4-source-availability). The supplied snapshot lacked `ROMFS/px4fmu_common/init.d/rc.mc_defaults`, which is outside PX4 `src/`. The named gyro filter coefficients are tested against the local fixtures.', '')
  return report.join('\n').trimEnd() + '\n'
}

function writeReport(report) {
  const path = resolve(root, directory, 'report.md')
  const pending = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(pending, report.replaceAll('\n', '\r\n'), 'utf8')
    renameSync(pending, path)
  } finally {
    rmSync(pending, { force: true })
  }
}

function main() {
  const start = performance.now()
  const areas = inventoryAreas()
  const models = areas.flatMap((area) => area.models)
  const tmp = scratch = mkdtempSync(join(tmpdir(), 'blaze-validation-'))
  try {
    const commit = run('git', ['rev-parse', 'HEAD']).stdout.trim()
    const dirty = run('git', ['status', '--porcelain', '--untracked-files=normal']).stdout.trim()
    console.log('Building the release engine offline')
    run('cargo', ['build', '--release', '--locked', '--offline', '--manifest-path', manifest])
    const hello = JSON.parse(run(binary, [], { input: '{"id":1,"type":"hello"}\n' }).stdout)
    if (!hello.ok || !hello.result.engineVersion) throw new Error('Engine hello did not return its version')

    console.log('Running engine-core unit checks and the K4 diagnostic')
    const cargo = ['test', '--release', '--locked', '--offline', '--manifest-path', manifest, '-p', 'engine-core', '--lib', '--']
    const rust = run('cargo', [...cargo, '--nocapture', '--test-threads=1'])
    const k4 = run('cargo', [...cargo, 'environment::spin_study::spin_study', '--exact', '--ignored', '--nocapture', '--test-threads=1'])
    const rustPassed = passedRust(rust.stdout)
    const k4Passed = passedRust(k4.stdout)
    const acceptance = join(tmp, 'acceptance.log')
    const rustLog = join(tmp, 'rust.log')
    const unitLog = join(tmp, 'unit.log')
    writeFileSync(rustLog, [rust.stdout, rust.stderr, k4.stdout].join('\n'), 'utf8')

    console.log('Running the inventory’s Vitest checks')
    const checks = models.flatMap((model) => model.checks).filter(({ file }) => file.startsWith('tests/unit/'))
    const files = [...new Set(checks.map(({ file }) => file))]
    const titles = [...new Set(checks.map(({ title }) => escapeRegex(normalize(title)).replaceAll("'", "['’]")))]
    const unit = vitest('vitest.config.mts', files, join(tmp, 'unit.json'), {
      BLAZE_SCENARIO_REFERENCE_ENGINE: binary, BLAZE_SCENARIO_ACCEPTANCE_LOG: acceptance, BLAZE_SCENARIO_BASELINES: '',
    }, ['--testNamePattern', `(?:${titles.join('|')})`])
    writeFileSync(unitLog, unit.output, 'utf8')

    const passingRust = new Set([...rustPassed, ...k4Passed])
    for (const model of models) {
      model.results = model.checks.map((check) => checkResult(check, passingRust, unit.tests))
    }
    console.log('Collecting current-run measurements')
    const probes = vitest(join(suite, 'vitest.config.mts'), [], join(tmp, 'probes.json'), {
      BLAZE_VALIDATION_RUST_LOG: rustLog, BLAZE_VALIDATION_UNIT_LOG: unitLog, BLAZE_VALIDATION_ACCEPTANCE_LOG: acceptance,
    })
    const measured = observations(probes.output)
    const metadata = [
      `- Build commit \`${commit}\`${dirty ? ' (working tree changes present)' : ''}`,
      `- Engine version ${hello.result.engineVersion} · protocol ${hello.result.protocolVersion}`,
      `- Machine ${platform()} ${release()} ${arch()} · ${cpus()[0].model.trim()}`,
      `- Generated ${new Date().toISOString()}`,
      `- Checks passed ${rustPassed.size} engine-core unit tests, ${k4Passed.size} ignored diagnostic, ${unit.passed} referenced Vitest tests and ${probes.passed} observation tests`,
    ]
    writeReport(render(areas, measured, metadata))
    console.log(`Wrote ${directory}/report.md in ${((performance.now() - start) / 1000).toFixed(2)} s`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
