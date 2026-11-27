import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_ASSET_BYTES, type AssemblyDocument, type IpcResult, type Project } from '../../electron/ipc/contract'
import { importAssetFile } from '../../electron/main/assets/store'
import { importTerrainFile, readTerrainFile } from '../../electron/main/assets/terrain-store'
import { loadBuiltIns } from '../../electron/main/components/seed'
import { openDatabase, type Db } from '../../electron/main/db/database'
import { createRepositories, STARTING_FRAME } from '../../electron/main/db/repositories'
import { flightStartSchema } from '../../electron/main/engine/flight-session'
import { FlightSessionStartResultSchema, FlightSessionStepResultSchema, VehicleLoadResultSchema, type EngineCommand } from '../../electron/main/engine/protocol'
import { sha256 } from '../../electron/main/projects/container'
import { createStaging, recoverInterruptedImports } from '../../electron/main/projects/publish'
import { ProjectTransfer } from '../../electron/main/projects/transfer'
import { RecordingStore } from '../../electron/main/telemetry/store'
import { flightStartWithTuning } from '../../src/features/flight/flight-mode'
import { enginePayload, flightGate } from '../../src/features/flight/readiness'
import { addPart, updatePart, type AttachTarget } from '../../src/features/workshop/assembly-ops'
import { effectiveShape } from '../../src/features/workshop/links'
import { placeClear, reseat } from '../../src/features/workshop/placement'
import { buildFrame } from '../../src/three/frame-geometry'
import { boxGlb } from '../fixtures/gltf'

let root: string
let databases: Db[]
const versions = { appVersion: 'test-app', engineVersion: 'test-engine' } // tests/unit/recording-store.test.ts:36
const use = <T>(result: IpcResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

function install(name: string) {
  const folder = join(root, name)
  mkdirSync(folder)
  const folders = { root: folder, assets: join(folder, 'assets'), recordings: join(folder, 'recordings') }
  const db = openDatabase(join(folder, 'blaze-uav.db'))
  databases.push(db)
  const repos = createRepositories(db, undefined, folders.recordings)
  loadBuiltIns(repos)
  return { db, repos, folders, transfer: new ProjectTransfer(() => db, repos, folders, () => versions) }
}
type Install = ReturnType<typeof install>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blaze-project-transfer-'))
  databases = []
})
afterEach(() => {
  for (const db of databases) if (db.open) db.close()
  rmSync(root, { recursive: true, force: true })
})

function catalogueProject(install: Install) {
  const { folders, repos } = install
  const project = repos.projects.create({ name: 'Catalogue quad', frameType: 'quad-x' })
  const partNamed = (name: string) => repos.components.list().find((item) => item.name === name)!
  // Existing flight fixture and its measured entries, tests/unit/scenario-protocol.test.ts:77–118.
  const motor = partNamed('MN3110 KV470')
  const prop = partNamed('P13*4.4 CF propeller')
  const battery = partNamed('Tattu G-Tech 5200mAh 4S 35C')
  repos.components.setFill(motor.id, 'rotorInertia', { value: 150, unit: 'g·cm²', source: 'measured', condition: 'bifilar pendulum, bell and shaft' })
  repos.components.setFill(motor.id, 'referenceDensity', { value: 1.225, unit: 'kg/m³', source: 'user', condition: 'bench air, as stated by the user' })
  const custom = repos.components.duplicate(battery.id)
  repos.components.update(custom.id, custom.revision, {
    name: custom.name, manufacturer: custom.manufacturer, notes: custom.notes, category: custom.category, specs: {
      ...custom.specs, internalResistance: { value: 12, unit: 'mΩ', source: 'measured', condition: '4-wire AC, 1 kHz, 25 °C' },
    },
  })
  const modelSource = join(root, 'box.glb')
  writeFileSync(modelSource, boxGlb({ size: [100, 20, 50] })) // tests/unit/assets.test.ts:29
  const model = use(importAssetFile(modelSource, folders.assets, repos))
  const terrainSource = join(root, 'ground.asc')
  // Terrain positions from scenario-protocol.test.ts:186–187, flat profile from :637–641.
  writeFileSync(terrainSource, 'ncols 2\nnrows 2\nxllcorner -2\nyllcorner -2\ncellsize 2\nNODATA_VALUE -42\n0 0\n0 0\n')
  const terrain = use(importTerrainFile(terrainSource, folders.assets, repos, { verticalUnit: 'm' }))
  const frame = { ...STARTING_FRAME['quad-x'], motorDiagonal: 0.55 }
  const geo = buildFrame('quad-x', frame)
  const frameTop = geo.plates.find(({ id }) => id === 'plate-top')!.position[2]
  let doc: AssemblyDocument = {
    frame, frameMass: { valueKg: 0.3, source: 'user' }, motors: {}, parts: [],
    bodyDrag: { cd: [1.1, 1.1, 1.1], source: 'user' },
    environment: {
      ground: { friction: null, restitution: null },
      terrain: { assetId: terrain.id, friction: 0.4, restitution: 0.2 },
      obstacles: [{
        id: randomUUID(), name: 'Model obstacle', type: 'hull', assetId: model.id, units: 'mm', upAxis: 'z',
        center: [2, 3, 4], yaw: 0, friction: 0.2, restitution: 0.3,
      }],
    },
    flight: { ambientAltitudeM: 0, temperatureC: null, cutoffType: 'voltageV', cutoffValue: 12 },
  }
  const components = Object.fromEntries(repos.components.list().map((c) => [c.id, c]))
  function attach(kind: 'motor' | 'propeller' | 'battery', target: AttachTarget, componentId: string) {
    const id = randomUUID()
    const added = addPart(doc, kind, target, frameTop, id, {}, (part) => effectiveShape(part, components))
    const placed = placeClear(added.doc, geo, id, components, {})
    if (!placed.ok) throw new Error(placed.reason)
    doc = reseat(placed.doc, updatePart(placed.doc, id, { componentId }), geo, id, components, {})
    const linked = placeClear(doc, geo, id, components, {})
    if (linked.ok) doc = linked.doc
    return id
  }
  const motors = geo.motors.map((mount) => {
    const id = attach('motor', { kind: 'mount', id: mount.id }, motor.id)
    attach('propeller', { kind: 'part', id }, prop.id)
    return id
  })
  const batteryPart = attach('battery', { kind: 'none' }, custom.id)
  doc.wires = [{
    id: randomUUID(), from: { partId: batteryPart, port: 'power' }, to: { partId: motors[0]!, port: 'phases' },
    gaugeAwg: null, lengthMm: null, color: null,
  }]
  doc.schematic = { [batteryPart]: { x: 0, y: 0 } }
  repos.assemblies.save({ ...doc, projectId: project.id, baseRevision: 0 })
  repos.tuning.set(project.id, { MC_ROLL_P: 7 }) // tests/unit/tuning-repository.test.ts:40
  return { project, custom, model, terrain }
}

function engineInput(install: Install, project: Project) {
  const { repos, folders } = install
  const doc = repos.assemblies.load(project.id)
  const terrainId = doc.environment!.terrain!.assetId!
  const grid = readTerrainFile(terrainId, folders.assets, repos)
  const components = Object.fromEntries(repos.components.list().map((c) => [c.id, c]))
  const assets = Object.fromEntries(repos.assets.list().map((a) => [a.id, a]))
  const payload = enginePayload(doc, buildFrame(project.frameType, doc.frame), components, assets, { terrain: { id: terrainId, grid } })
  if (!payload.ok) throw new Error(JSON.stringify(payload.blockers))
  const gate = flightGate(payload, doc.flight!)
  if (!gate.ok) throw new Error(JSON.stringify(gate.blockers))
  return { ...gate.input, ...flightStartWithTuning('position', repos.tuning.get(project.id), gate.thrustFit).session }
}

async function addRecording({ repos, folders }: Install, project: Project) {
  // Same format, cadence and sample used by tests/unit/recording-store.test.ts:20–40, 92–93.
  const recordings = new RecordingStore(folders.recordings, repos.runs)
  const id = randomUUID()
  const writer = await recordings.start({
    runId: id, projectId: project.id, projectName: project.name, kind: 'scenario', title: 'Scenario',
    startedAt: project.createdAt, ...versions, protocolVersion: 1, firstSampleStep: 4, samplePeriodSteps: 4,
    stepLengthS: 0.001, channels: [{ name: 'v', label: 'Velocity', unit: 'm/s' }],
    vehicleLoad: '{"mass":2.000}', startRequest: '{"duration":0.0080}',
  }, { maxPendingBytes: 4096 })
  if (!writer) throw new Error('Unable to create the recording fixture')
  writer.appendSamples([[1]])
  await writer.finish({ status: 'completed', reason: 'Finished', elapsedS: 0.008, finalStateHash: 'hash', engineError: null })
  return { id, recordings }
}

describe('project data transfer', () => {
  it('preserves the full flight payload and real-engine state hash in an empty data folder', async () => {
    const source = install('source')
    const target = install('target')
    const { project, model, terrain } = catalogueProject(source)
    const file = join(root, 'round-trip.blazeproj')
    const { id: runId } = await addRecording(source, project)
    await source.transfer.export(project.id, true, file)
    const imported = await target.transfer.import(file)
    expect(imported).toEqual(source.repos.projects.get(project.id))
    const before = engineInput(source, project)
    const after = engineInput(target, imported)
    expect(sha256(JSON.stringify(after))).toBe(sha256(JSON.stringify(before)))
    expect(after).toEqual(before)
    const importedParts = target.repos.assemblies.load(imported.id)
    expect(importedParts.wires).toEqual(source.repos.assemblies.load(project.id).wires)
    for (const asset of [model, terrain]) {
      const name = `${asset.id}.${asset.format}`
      expect(readFileSync(join(target.folders.assets, name))).toEqual(readFileSync(join(source.folders.assets, name)))
    }
    const recordings = new RecordingStore(target.folders.recordings, target.repos.runs)
    expect((await recordings.read(runId, (r) => r.summary())).sampleCount).toBe(1)
    const duplicate = await target.transfer.import(file)
    expect(duplicate.id).not.toBe(imported.id)
    const duplicateAssembly = target.repos.assemblies.load(duplicate.id)
    const ids = new Set(duplicateAssembly.parts.map((part) => part.id))
    expect(duplicateAssembly.parts.some((part) => importedParts.parts.some(({ id }) => id === part.id))).toBe(false)
    expect(ids.has(duplicateAssembly.wires![0]!.from.partId)).toBe(true)
    expect(ids.has(duplicateAssembly.wires![0]!.to.partId)).toBe(true)
    const run = target.repos.runs.listByProject(duplicate.id)[0]!
    expect(run.id).not.toBe(runId)
    expect((await recordings.read(run.id, (r) => r.summary())).header).toMatchObject({ projectId: duplicate.id, runId: run.id })

    const binary = process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine'
    const executable = join(__dirname, '../../simulation-engine/target/release', binary)
    const fly = (input: typeof before) => {
      // Same split and commands as flight-session.ts:52–62 and supervisor.ts:168–188.
      const { vehicle, propulsion, aero, ...session } = flightStartSchema.parse(input)
      const commands: EngineCommand[] = [
        { type: 'vehicle.load', vehicle, propulsion, aero },
        { type: 'flight.session.start', ...session },
        { type: 'flight.session.step', steps: 1, setpoint: { command: { type: 'takeoff' } } },
        { type: 'flight.session.end' },
      ]
      const run = spawnSync(executable, {
        input: commands.map((command, id) => JSON.stringify({ id, ...command })).join('\n') + '\n',
        encoding: 'utf8', windowsHide: true,
        timeout: 8000, // tests/unit/scenario-protocol.test.ts:473
      })
      if (run.error) throw run.error
      expect(run.status, run.stderr).toBe(0)
      const results = run.stdout.trim().split(/\r?\n/).map((line) => {
        const reply = JSON.parse(line)
        if (!reply.ok) throw new Error(JSON.stringify(reply.error))
        return reply.result
      })
      expect(results).toHaveLength(commands.length)
      expect(VehicleLoadResultSchema.parse(results[0]).valid).toBe(true)
      FlightSessionStartResultSchema.parse(results[1])
      return FlightSessionStepResultSchema.parse(results[2]).stateHash
    }
    const stateHash = fly(before)
    expect(stateHash).toBeTruthy()
    expect(fly(after)).toBe(stateHash)
  })

  it('exports a project without recordings until the option is enabled', async () => {
    const source = install('source')
    const target = install('target')
    const { project } = catalogueProject(source)
    await addRecording(source, project)
    const file = join(root, 'without-recordings.blazeproj')
    await source.transfer.export(project.id, false, file)
    const imported = await target.transfer.import(file)
    expect(target.repos.runs.listByProject(imported.id)).toEqual([])
    expect(existsSync(target.folders.recordings)).toBe(false)
  })

  it.each(['import:staged', 'import:rows', 'import:file', 'import:commit'] as const)(
    'rolls back files and rows after a failure at %s', async (point) => {
      const source = install('source')
      const target = install('target')
      const { project } = catalogueProject(source)
      const file = join(root, 'fault.blazeproj')
      await source.transfer.export(project.id, false, file)
      const before = readdirSync(target.folders.root)
      const existing = target.repos.projects.create({ name: 'Existing', frameType: 'quad-x' })
      const components = target.repos.components.list()
      await expect(target.transfer.import(file, (stage) => {
        if (stage === point) throw new Error('disk full during project import')
      })).rejects.toThrow('disk full during project import')
      expect(target.repos.projects.list()).toEqual([existing])
      expect(target.repos.components.list()).toEqual(components)
      expect(target.repos.assets.list()).toEqual([])
      expect(target.repos.terrain.list()).toEqual([])
      expect(readdirSync(target.folders.root)).toEqual(before)
    },
  )

  it.each([
    ['traversal', /entry path/], ['oversized', /oversized entry/], ['hash', /SHA-256 mismatch/],
    ['truncated', /truncated/], ['version', /Only project format version/], ['schema', /Project project.name/],
  ] as const)('rejects a hostile %s archive with no imported data', async (kind, message) => {
    const target = install('target')
    const path = join(root, 'hostile.blazeproj')
    const project = target.repos.projects.create({ name: 'Valid project', frameType: 'quad-x' })
    const projectData = kind === 'schema' ? { ...project, name: 42 } : project
    const payload = Buffer.from(JSON.stringify({ project: projectData, assembly: null, tuning: {}, assets: [], components: [], recordings: [] }))
    const hash = sha256(payload)
    const entry = { name: 'project.json', bytes: payload.length, sha256: kind === 'hash' ? sha256('wrong') : hash }
    const entries = [entry]
    if (kind === 'traversal') entries.push({ ...entry, name: 'assets/../project.json' })
    if (kind === 'oversized') entries.push({ ...entry, name: `assets/${hash}.glb`, bytes: MAX_ASSET_BYTES + 1 })
    const manifest = Buffer.from(JSON.stringify({ ...versions, version: kind === 'version' ? 2 : 1, entries }))
    const magic = Buffer.from('BLAZEPROJ')
    const header = Buffer.alloc(magic.length + Uint32Array.BYTES_PER_ELEMENT)
    magic.copy(header)
    header.writeUInt32LE(manifest.length, magic.length)
    writeFileSync(path, Buffer.concat([header, manifest, kind === 'truncated' ? payload.subarray(1) : payload]))
    await expect(target.transfer.import(path)).rejects.toThrow(message)
    expect(target.repos.projects.list()).toEqual([project])
    expect(readdirSync(target.folders.root).some((name) => name.startsWith('.blazeproj-import-'))).toBe(false)
  })

  it('removes only uncommitted files after an interrupted SQLite import', () => {
    const target = install('target')
    const staged = createStaging(target.folders.root)
    mkdirSync(target.folders.assets)
    const bytes = Buffer.from('interrupted')
    const name = sha256(bytes) + '.glb'
    writeFileSync(join(staged, 'entry-0'), bytes)
    linkSync(join(staged, 'entry-0'), join(target.folders.assets, name))
    writeFileSync(join(staged, 'publish.json'), JSON.stringify({
      id: randomUUID(), created: ['assets'], files: [{ directory: 'assets', name, staged: 'entry-0' }],
    }))
    recoverInterruptedImports(target.db, target.folders)
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(target.folders.assets)).toBe(false)
  })
})
