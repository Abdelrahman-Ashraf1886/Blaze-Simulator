const { spawn, spawnSync } = require('node:child_process')
const { closeSync, copyFileSync, existsSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createInterface } = require('node:readline')
const { crc32 } = require('node:zlib')

function loadFlight(path) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    let offset = 0
    const read = (length) => {
      if (offset + length > size) throw new Error('Truncated flight recording')
      const buffer = Buffer.alloc(length)
      if (readSync(fd, buffer, 0, length, offset) !== length) throw new Error('Could not read recording frame')
      offset += length
      return buffer
    }
    // Frame layout and checksums: electron/main/telemetry/format.ts:3–18,24–32,75–83.
    const preamble = read(8)
    if (preamble.toString('ascii', 0, 4) !== 'BLZR' || preamble.readUInt32LE(4) !== 1) throw new Error('Expected BLZR v1')
    let metadata
    let end
    const steps = []
    while (offset < size) {
      const frame = read(13)
      const type = frame[0]
      const bytes = frame.readUInt32LE(1)
      if (crc32(frame.subarray(0, 5)) !== frame.readUInt32LE(5)) throw new Error('Recording frame header CRC mismatch')
      if (!metadata && type !== 0) throw new Error('Recording header is missing')
      if (type === 1) {
        offset += bytes // Sample payload is independent of the protocol inputs.
        if (offset > size) throw new Error('Truncated recording sample frame')
        continue
      }
      const payload = read(bytes)
      if (crc32(payload) !== frame.readUInt32LE(9)) throw new Error('Recording frame payload CRC mismatch')
      const line = payload.toString('utf8')
      if (type === 0 && !metadata) metadata = JSON.parse(line)
      else if (type === 2) steps.push(line.replace(/\r?\n$/, ''))
      else if (type === 3 && offset === size) end = JSON.parse(line)
      else throw new Error('Unexpected recording frame')
    }
    if (metadata?.kind !== 'flight' || end?.status !== 'completed' || !steps.length) {
      throw new Error('Expected a completed flight with step requests')
    }
    const load = metadata.vehicleLoad.trimEnd()
    const start = metadata.startRequest.trimEnd()
    const setup = JSON.parse(start)
    const commands = steps.map((line) => JSON.parse(line))
    if (JSON.parse(load).type !== 'vehicle.load' || setup.type !== 'flight.session.start' ||
        !commands.every(({ type, steps }) => type === 'flight.session.step' && Number.isSafeInteger(steps) && steps > 0)) {
      throw new Error('Expected vehicle.load, flight.session.start and flight.session.step requests')
    }
    if (Object.values(setup.sensors ?? {}).some((value) => value != null)) throw new Error('Record the flight with all sensors and gyro feedback off')
    if (!Number.isSafeInteger(setup.sampleEverySteps) || setup.sampleEverySteps <= 0) throw new Error('Expected a sampled flight')
    delete setup.sampleEverySteps
    return {
      configurations: {
        unsampled: [load, JSON.stringify(setup), ...steps],
        sampled: [load, start, ...steps],
      },
      workload: {
        runId: metadata.runId, engineVersion: metadata.engineVersion, samplePeriodSteps: metadata.samplePeriodSteps,
        stepLengthS: metadata.stepLengthS, recordedFinalStateHash: end.finalStateHash,
        requestedSteps: commands.reduce((sum, command) => sum + command.steps, 0), stepRequests: steps.length,
      },
    }
  } finally {
    closeSync(fd)
  }
}

function build(root, directory) {
  const engine = join(root, 'simulation-engine')
  // Same package/dependencies and release settings as engine-host/Cargo.toml:1–15
  // and simulation-engine/Cargo.toml:5–17. Reuse the lock without writing to the product workspace.
  const manifest = join(directory, 'Cargo.toml')
  writeFileSync(manifest, `[package]
name = "engine-host"
version = "0.1.0"
edition = "2021"
license = "UNLICENSED"

[[bin]]
name = "drone-engine-profile"
path = ${JSON.stringify(join(__dirname, 'step-cost.rs'))}

[dependencies]
engine-core = { path = ${JSON.stringify(join(engine, 'engine-core'))} }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
`, 'utf8')
  copyFileSync(join(engine, 'Cargo.lock'), join(directory, 'Cargo.lock'))
  const result = spawnSync('cargo', ['build', '--release', '--offline', '--locked', '--manifest-path', manifest], {
    stdio: 'inherit',
    env: { ...process.env, CARGO_BUILD_JOBS: '1', CARGO_TARGET_DIR: join(directory, 'target') },
  })
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Profile engine build exited ${result.status}`)
  return join(directory, 'target', 'release', 'drone-engine-profile.exe')
}

async function roundTrips(binary, commands) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`NDJSON engine exited ${code}`)))
  })
  // Attach a rejection handler while the replies are being consumed.
  void exited.catch(() => {})
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const replies = lines[Symbol.asyncIterator]()
  const send = async (command) => {
    const next = replies.next()
    const written = new Promise((resolve, reject) => {
      child.stdin.write(command + '\n', (error) => error ? reject(error) : resolve())
    })
    const [reply] = await Promise.all([next, written])
    if (reply.done) throw new Error('Engine closed stdout before replying')
    const value = JSON.parse(reply.value)
    if (!value.ok) throw new Error(`Engine refused ${JSON.parse(command).type}: ${JSON.stringify(value.error)}`)
    return value.result
  }
  let totalNs = 0n
  let steps = 0
  let finalStateHash
  try {
    await send(commands[0])
    await send(commands[1])
    for (const command of commands.slice(2)) {
      const start = process.hrtime.bigint()
      const reply = await send(command)
      totalNs += process.hrtime.bigint() - start
      steps += reply.stepsRun
      finalStateHash = reply.stateHash
    }
  } finally {
    child.stdin.end()
    lines.close()
    await exited
  }
  return { totalNs: Number(totalNs), steps, requests: commands.length - 2, finalStateHash }
}

async function measureCost(root, count, recording, metadata) {
  const engine = join(root, 'simulation-engine', 'target', 'release', 'drone-engine.exe')
  if (!existsSync(engine)) throw new Error(`Build the release engine first: ${engine}`)
  const { configurations, workload } = loadFlight(recording)
  const directory = mkdtempSync(join(tmpdir(), 'blaze-step-cost-'))
  try {
    const profile = build(root, directory)
    const runs = []
    for (const [sampling, commands] of Object.entries(configurations)) {
      const input = join(directory, `${sampling}.ndjson`)
      writeFileSync(input, commands.join('\n') + '\n', 'utf8')
      const directRun = () => {
        const result = spawnSync(profile, [input], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
        if (result.error || result.status !== 0) throw result.error ?? new Error(`Direct engine exited ${result.status}`)
        return JSON.parse(result.stdout)
      }
      for (let i = 0; i < count; i++) {
        const order = i % 2 ? ['ndjson', 'direct'] : ['direct', 'ndjson']
        const pair = {}
        for (const method of order) pair[method] = method === 'direct' ? directRun() : await roundTrips(engine, commands)
        const { direct, ndjson } = pair
        for (const sample of [direct, ndjson]) sample.usPerStep = sample.steps ? sample.totalNs / sample.steps / 1000 : null
        direct.handleUsPerStep = direct.steps ? direct.handleNs / direct.steps / 1000 : null
        const sameWork = direct.steps > 0 && direct.steps === ndjson.steps &&
          direct.requests === ndjson.requests && direct.finalStateHash === ndjson.finalStateHash
        runs.push({
          sampling, order, direct, ndjson, sameWork,
          extraUsPerStep: sameWork && direct.steps ? ndjson.usPerStep - direct.usPerStep : null,
          recordingHashMatches: sampling === 'sampled' ? ndjson.finalStateHash === workload.recordedFinalStateHash : null,
        })
        console.log(`K6 ${sampling} run ${i + 1}: direct ${direct.usPerStep} µs/step, NDJSON ${ndjson.usPerStep} µs/step, same work ${sameWork}`)
      }
    }
    return { metadata, workload, runs }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
}

module.exports = { measureCost }
