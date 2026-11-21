import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Component, SpecValue } from '../../electron/ipc/component-fields'
import type { AssemblyDocument, Wire } from '../../electron/ipc/contract'
import { runChecks, type CheckInput } from '../../src/domain/checks'
import { autoWire, canConnect, escOfMotor, portsOf, wireIndex, wiresAt, wiringFindings, type WiringPart } from '../../src/domain/wiring'
import { calculate, DEFAULT_LOAD_CASE } from '../../src/domain/electrical'
import { addWire, movePort, placeNode, removeWire } from '../../src/features/electrical/wiring-ops'
import { deletePart } from '../../src/features/workshop/assembly-ops'

const seed = JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as { components: Component[] }
const lib = (name: string) => ({ ...seed.components.find((c) => c.name === name)!, origin: 'built-in' }) as Component
let n = 0
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const part = (name: string, kind: WiringPart['kind'], component: Component | null, motorNumber: number | null = null): WiringPart => ({
  id: id(),
  name,
  kind,
  component,
  motorNumber,
})

const PX = lib('Pixhawk 6C')
const PM02 = lib('PM02 V3')
const T45 = lib('Tekko32 F4 45A ESC (AM32)')

/** A hex: battery, PM02, Pixhawk 6C, six single ESCs and six motors, M10 GPS and SiK radio. */
function hex() {
  const parts = [
    part('Battery 1', 'battery', lib('Tattu G-Tech 5200mAh 4S 35C')),
    part('Power module', 'payload', PM02),
    part('Flight controller 1', 'flight-controller', PX),
    ...Array.from({ length: 6 }, (_, i) => part(`ESC ${i + 1}`, 'esc', T45)),
    ...Array.from({ length: 6 }, (_, i) => part(`Motor ${i + 1}`, 'motor', lib('MN3110 KV700'), i + 1)),
    part('GPS', 'payload', lib('M10 GPS')),
    part('Radio', 'payload', lib('SiK Telemetry Radio V3 100mW')),
  ]
  const by = (name: string) => parts.find((p) => p.name === name)!
  return { parts, by }
}
const endName = (parts: WiringPart[], e: { partId: string; port: string }) => `${parts.find((p) => p.id === e.partId)!.name}/${e.port}`
const describeWires = (parts: WiringPart[], wires: Wire[]) => wires.map((w) => `${endName(parts, w.from)} → ${endName(parts, w.to)}`)

describe('ports', () => {
  it('come from the part kind and its linked component', () => {
    const fc = portsOf(part('FC', 'flight-controller', PX))
    expect(fc.filter((p) => p.kind !== 'signal').map((p) => p.id)).toEqual([
      'Telem1', 'Telem2', 'Telem3', 'GPS1', 'GPS2', 'I2C', 'CAN1', 'CAN2', 'DSM RC', 'PPM/SBUS RC', 'USB', 'Power1', 'Power2',
    ])
    expect(fc.filter((p) => p.kind === 'signal')).toHaveLength(16) // stated PWM outputs
    expect(portsOf(part('ESC', 'esc', lib('Tekko32 F4 4in1 50A ESC (AM32)'))).map((p) => p.id)).toEqual([
      'power', 'sig1', 'sig2', 'sig3', 'sig4', 'out1', 'out2', 'out3', 'out4',
    ])
    expect(portsOf(part('PM', 'payload', PM02)).find((p) => p.id === 'sense')!.kind).toBe('adc')
    expect(portsOf(part('PM', 'payload', lib('PM08-CAN'))).find((p) => p.id === 'sense')!.kind).toBe('can')
    expect(portsOf(part('GPS', 'payload', lib('M10 GPS')))).toEqual([{ id: 'data', label: 'UART', kind: 'uart', side: 'right' }])
    expect(portsOf(part('Prop', 'propeller', null))).toEqual([])
    expect(portsOf(part('Payload', 'payload', null))).toEqual([]) // unlinked payload: unknown connector
  })

  it('connect only same kinds, on different parts', () => {
    const esc = part('ESC', 'esc', T45)
    const motor = part('Motor', 'motor', null)
    const [power, , out] = portsOf(esc)
    const phases = portsOf(motor)[0]!
    expect(canConnect({ part: esc, port: out! }, { part: motor, port: phases })).toBe(true)
    expect(canConnect({ part: esc, port: power! }, { part: motor, port: phases })).toBe(false)
    expect(canConnect({ part: esc, port: out! }, { part: esc, port: out! })).toBe(false)
  })
})

describe('auto-wire', () => {
  it('wires a hex: power chain, motor n ↔ output n ↔ PWM n, GPS → GPS1, radio → Telem1, sense → Power1', () => {
    const { parts } = hex()
    const { wires, notes } = autoWire(parts, id)
    expect(notes).toEqual([])
    const d = describeWires(parts, wires)
    expect(d).toContain('Battery 1/power → Power module/in')
    for (let i = 1; i <= 6; i++) {
      expect(d).toContain(`Power module/out → ESC ${i}/power`)
      expect(d).toContain(`ESC ${i}/out1 → Motor ${i}/phases`)
      expect(d).toContain(`Flight controller 1/PWM${i} → ESC ${i}/sig1`)
    }
    expect(d).toContain('Power module/sense → Flight controller 1/Power1')
    expect(d).toContain('GPS/data → Flight controller 1/GPS1')
    expect(d).toContain('Radio/data → Flight controller 1/Telem1')
    expect(wires).toHaveLength(1 + 6 * 3 + 3)
    expect(wiringFindings(parts, wires)).toEqual([]) // the harness passes its own checks
  })

  it('keeps PX4 numbering when a motor is missing, and says what it could not wire', () => {
    const parts = [part('ESC', 'esc', lib('Tekko32 F4 4in1 50A ESC (AM32)')), part('M1', 'motor', null, 1), part('M3', 'motor', null, 3)]
    const { wires, notes } = autoWire(parts, id)
    expect(describeWires(parts, wires)).toEqual(['ESC/out1 → M1/phases', 'ESC/out3 → M3/phases'])
    expect(notes).toEqual(['No battery: ESC power was not wired.', 'No flight controller: ESC signals were not wired.'])
    const two = autoWire([part('B1', 'battery', null), part('B2', 'battery', null), part('E', 'esc', null)], id)
    expect(two.notes[0]).toBe('2 batteries: series or parallel is your choice, so only B1 was wired.')
  })
})

describe('wiring checks', () => {
  it('moving the GPS onto the telemetry port is a port conflict naming both devices', () => {
    const { parts, by } = hex()
    let doc: AssemblyDocument = { frame: { motorDiagonal: 0.55, armWidth: 0.02, armThickness: 0.004, plateSize: 0.15 }, motors: {}, parts: [], wires: autoWire(parts, id).wires }
    const gpsWire = doc.wires!.find((w) => w.from.partId === by('GPS').id)!
    doc = movePort(doc, gpsWire.id, 'to', 'Telem1')
    const f = wiringFindings(parts, doc.wires!)
    expect(f).toEqual([
      expect.objectContaining({ rule: 'port-conflict', severity: 'error', message: 'Telem1 on Flight controller 1 has 2 cables (GPS, Radio); it takes one.' }),
    ])
    expect(f[0]!.partIds).toEqual(expect.arrayContaining([by('Flight controller 1').id, by('GPS').id, by('Radio').id]))
  })

  it('flags wires to missing ports and between different kinds; warns about unwired parts once wiring starts', () => {
    const { parts, by } = hex()
    const fc = by('Flight controller 1')
    // A wire to a port the (now unlinked) flight controller no longer has.
    const unlinked = parts.map((p) => (p.id === fc.id ? { ...p, component: null } : p))
    const wires = autoWire(parts, id).wires
    expect(wiringFindings(unlinked, wires).map((x) => x.rule)).toContain('wire-port')
    const bad: Wire = { id: id(), from: { partId: by('ESC 1').id, port: 'power' }, to: { partId: by('Motor 1').id, port: 'phases' }, gaugeAwg: null, lengthMm: null, color: null }
    expect(wiringFindings(parts, [bad]).map((x) => x.rule)).toEqual(expect.arrayContaining(['wire-kind', 'unwired']))
    expect(wiringFindings(parts, [])).toEqual([]) // nothing wired yet: no "unwired" noise
    const partial = wires.filter((w) => !(w.to.partId === by('ESC 3').id && w.to.port === 'sig1'))
    expect(wiringFindings(parts, partial).map((x) => x.message)).toContain('ESC 3 output drives a motor but has no signal from the flight controller.')
  })

  it('wired ESC pairing lets the current check compare different ESCs motor by motor', () => {
    const weak = { ...T45, id: 'weak-esc', name: 'Test 15A', specs: { ...T45.specs, continuousCurrent: { value: 15, unit: 'A', source: 'user' } as SpecValue } } as Component
    const { parts, by } = hex()
    const mixed = parts.map((p) => (p.name === 'ESC 2' ? { ...p, component: weak } : p))
    const wires = autoWire(mixed, id).wires
    const input: CheckInput = {
      rotors: 6,
      motorMounts: [],
      frameTop: 0,
      escOfMotor: escOfMotor(mixed, wires),
      parts: mixed.map((p) => ({ ...p, motorMount: null, parentId: null, shape: { type: 'box', size: [0.01, 0.01, 0.01] }, center: [0, 0, 0], axis: [0, 0, 1] })),
    }
    const f = runChecks(input).filter((x) => x.rule === 'esc-current')
    expect(f).toEqual([expect.objectContaining({ severity: 'error', message: "ESC 2 (Test 15A) is rated 15 A, below Motor 2 (MN3110 KV700)'s maximum 21 A (Max continuous current (180 s))." })])
    expect(f[0]!.partIds).toEqual([by('ESC 2').id, by('Motor 2').id])
    const unwired = runChecks({ ...input, escOfMotor: {} }).filter((x) => x.rule === 'esc-current')
    expect(unwired[0]!.severity).toBe('cannot-check')
  })
})

/** A deliberately large assembly: `pairs` single ESCs and motors on one battery, PM02 and Pixhawk 6C. */
function large(pairs: number) {
  return [
    part('Battery 1', 'battery', lib('Tattu G-Tech 5200mAh 4S 35C')),
    part('Power module', 'payload', PM02),
    part('Flight controller 1', 'flight-controller', PX),
    ...Array.from({ length: pairs }, (_, i) => part(`ESC ${i + 1}`, 'esc', T45)),
    ...Array.from({ length: pairs }, (_, i) => part(`Motor ${i + 1}`, 'motor', lib('MN3110 KV700'), i + 1)),
    part('GPS', 'payload', lib('M10 GPS')),
    part('Radio', 'payload', lib('SiK Telemetry Radio V3 100mW')),
  ]
}

describe('wire index (3.8 performance)', () => {
  it('lists the same wires at every port as a scan of all wires, a wire looping on one port once', () => {
    const parts = large(40)
    const { wires } = autoWire(parts, id)
    expect(wires).toHaveLength(100) // 1 + 40 + 1 + 40 + 16 PWM + 2 peripherals
    const loop: Wire = { id: id(), from: { partId: parts[0]!.id, port: 'power' }, to: { partId: parts[0]!.id, port: 'power' }, gaugeAwg: null, lengthMm: null, color: null }
    const all = [...wires, loop]
    const at = wireIndex(all)
    for (const p of parts) for (const port of [...portsOf(p).map((x) => x.id), 'missing']) {
      const end = { partId: p.id, port }
      expect(at(end), `${p.name}/${port}`).toEqual(wiresAt(all, end))
    }
    expect(at({ partId: parts[0]!.id, port: 'power' }).filter((w) => w.id === loop.id)).toHaveLength(1)
  })

  it('checks and calculates the schema maximum of 2000 wires in linear time', () => {
    // 1 + 995 + 1 + 995 + 16 + 2 = 2010 > 2000, so 990 pairs: 1 + 990 + 1 + 990 + 16 + 2 = 2000.
    const parts = large(990)
    const { wires } = autoWire(parts, id)
    expect(wires).toHaveLength(2000)
    /** Median of five runs after a warm-up, so one slow run on a busy machine does not fail the test. */
    const time = (f: () => unknown) => {
      f()
      const runs = Array.from({ length: 5 }, () => {
        const t0 = performance.now()
        f()
        return performance.now() - t0
      }).sort((x, y) => x - y)
      return runs[2]!
    }
    const checks = time(() => wiringFindings(parts, wires))
    const pairing = time(() => escOfMotor(parts, wires))
    const calc = time(() => calculate(parts, wires, DEFAULT_LOAD_CASE))
    console.log(`2000 wires: wiringFindings ${checks.toFixed(1)} ms, escOfMotor ${pairing.toFixed(1)} ms, calculate ${calc.toFixed(1)} ms`)
    // Before 3.8, calculate took 105 ms here: it copied adjacency lists per cable and scanned all wires per port.
    // Linear work now: about 40–50 ms for calculate and under 25 ms for the checks when run alone on the
    // development machine, up to twice that with the whole suite running in parallel. The bound only
    // catches a return to quadratic work; the measured figures are in the DEVLOG.
    expect(checks).toBeLessThan(300)
    expect(pairing).toBeLessThan(300)
    expect(calc).toBeLessThan(300)
    // The findings are the expected ones: outputs 17…990 have no PWM left on the Pixhawk 6C.
    expect(wiringFindings(parts, wires).filter((f) => f.rule === 'unwired')).toHaveLength(990 - 16)
  })
})

describe('wiring edits', () => {
  it('add (no duplicates), move a port, place a box, remove; deleting a part removes its wires and position', () => {
    const a = id()
    const b = id()
    const base: AssemblyDocument = {
      frame: { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.12 },
      motors: {},
      parts: [a, b].map((pid) => ({ id: pid, name: pid, kind: 'custom' as const, shape: { type: 'box' as const, size: [0.01, 0.01, 0.01] as [number, number, number] }, parentId: null, mountId: null, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], mass: null })),
    }
    let doc = addWire(base, { partId: a, port: 'x' }, { partId: b, port: 'y' }, 'w1')
    expect(addWire(doc, { partId: b, port: 'y' }, { partId: a, port: 'x' }, 'w2')).toBe(doc) // same cable reversed
    doc = movePort(doc, 'w1', 'to', 'z')
    expect(doc.wires![0]!.to).toEqual({ partId: b, port: 'z' })
    doc = placeNode(doc, a, 10.4, 20.6)
    expect(doc.schematic).toEqual({ [a]: { x: 10, y: 21 } })
    const deleted = deletePart(doc, a)
    expect(deleted.wires).toEqual([])
    expect(deleted.schematic).toEqual({})
    expect(removeWire(doc, 'w1').wires).toEqual([])
  })
})
