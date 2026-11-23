/**
 * The Engineering Analysis page's values (src/features/analysis/analysis.ts) are the results of the existing
 * functions for the same build: there is no second implementation. A fixture quad (the seed's MN3110 KV470
 * motors, P13*4.4 propellers and a Tattu 4S pack, with the values no source states entered as a user would)
 * is compared with the source functions; the missing-data states are checked on an empty and a partial build.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Component, QuantityValue } from '../../electron/ipc/component-fields'
import type { AssemblyDocument, FrameParams } from '../../electron/ipc/contract'
import { calculate, DEFAULT_LOAD_CASE } from '../../src/domain/electrical'
import { horizontalOffset, massFindings } from '../../src/domain/mass'
import { propulsionDefinition } from '../../src/domain/propulsion'
import { wiringFindings } from '../../src/domain/wiring'
import { analyse } from '../../src/features/analysis/analysis'
import { thrustIndicator } from '../../src/features/flight/indicators'
import { airDensityFor, conditionBlockers, EMPTY_CONDITIONS } from '../../src/features/flight/readiness'
import { addPart, updatePart } from '../../src/features/workshop/assembly-ops'
import { linkedComponent } from '../../src/features/workshop/links'
import { massState } from '../../src/features/workshop/mass-input'
import { propulsionState } from '../../src/features/workshop/propulsion-input'
import { wiringParts } from '../../src/features/workshop/wiring-input'
import { buildFrame } from '../../src/three/frame-geometry'

const seed = JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as { components: Component[] }
const named = (name: string) => seed.components.find((c) => c.name === name)!
const withSpec = (c: Component, key: string, spec: QuantityValue): Component => ({ ...c, specs: { ...c.specs, [key]: spec } })

const motor = withSpec(withSpec(named('MN3110 KV470'), 'rotorInertia', { value: 150, unit: 'g·cm²', source: 'measured' }), 'referenceDensity', { value: 1.225, unit: 'kg/m³', source: 'user' })
const battery = withSpec(named('Tattu G-Tech 5200mAh 4S 35C'), 'internalResistance', { value: 12, unit: 'mΩ', source: 'measured' })
const prop = named('P13*4.4 CF propeller')
const components = Object.fromEntries([motor, battery, prop].map((c) => [c.id, c]))

const frame: FrameParams = { motorDiagonal: 0.55, armWidth: 0.02, armThickness: 0.004, plateSize: 0.1 }
const geo = buildFrame('quad-x', frame)
const empty: AssemblyDocument = { frame, frameMass: null, motors: {}, parts: [] }

function quad(flight?: AssemblyDocument['flight']): AssemblyDocument {
  let doc: AssemblyDocument = { ...empty, frameMass: { valueKg: 0.3, source: 'user' }, ...(flight ? { flight } : {}) }
  for (let n = 1; n <= 4; n++) {
    const m = addPart(doc, 'motor', { kind: 'mount', id: `motor-${n}` }, frame.armThickness, `m${n}`)
    const p = addPart(m.doc, 'propeller', { kind: 'part', id: `m${n}` }, frame.armThickness, `p${n}`)
    doc = updatePart(updatePart(p.doc, `m${n}`, { componentId: motor.id }), `p${n}`, { componentId: prop.id })
  }
  const b = addPart(doc, 'battery', { kind: 'mount', id: 'plate-bottom' }, frame.armThickness, 'batt')
  return updatePart(b.doc, 'batt', { componentId: battery.id })
}
const sea = { ambientAltitudeM: 0, temperatureC: null, cutoffType: 'voltageV' as const, cutoffValue: 12 }

describe('a fixture build: every value is the source function’s result', () => {
  const doc = quad(sea)
  const a = analyse(doc, geo, components, {}, 25)

  it('mass properties, CoM offset and hover balance', () => {
    const source = massState(doc, geo, components, {})
    expect(a.mass).toEqual(source)
    expect(a.mass.mp.com).not.toBeNull()
    expect(a.mass.mp.totalMassKg).toBeGreaterThan(0.3)
    expect(a.comOffsetM).toBe(horizontalOffset(source.mp.com!))
    expect(a.hoverFindings).toEqual(massFindings(source.mp, source.motors, source.hover, 25))
    expect(a.tolerancePct).toBe(25)
  })

  it('maximum T/W is the flight page’s indicator at the flight conditions’ air density', () => {
    const propulsion = propulsionState(doc, geo, components)
    const definition = propulsionDefinition(propulsion.motors, linkedComponent(doc.parts.find((p) => p.kind === 'battery')!, components))
    const air = airDensityFor(0, null)
    expect(a.airDensityKgM3).toBe(air)
    expect(a.thrust).toEqual(thrustIndicator(definition, propulsion.ready, a.mass.mp.totalMassKg, true, air))
    expect(a.thrust.detail).toContain('Maximum T/W')
  })

  it('each motor’s reference density and its source come from the propulsion fit', () => {
    expect(a.motorDensities).toHaveLength(4)
    const source = propulsionState(doc, geo, components).motors.map((m) => m.fit?.referenceDensity ?? null)
    expect(a.motorDensities.map((m) => m.density)).toEqual(source)
    expect(a.motorDensities[0]!.density).toMatchObject({ kgM3: 1.225, from: 'field' })
  })

  it('electrical totals and checks are electrical.ts and wiring.ts on the build’s wiring', () => {
    const parts = wiringParts(doc, geo, components)
    expect(a.electrical).toEqual(calculate(parts, [], DEFAULT_LOAD_CASE))
    expect(a.loadCase).toBe(DEFAULT_LOAD_CASE)
    expect(a.wiringFindings).toEqual(wiringFindings(parts, []))
  })

  it('readiness is the Ready-to-fly checklist and the conditions’ blockers', () => {
    expect(a.ready).toEqual(propulsionState(doc, geo, components).ready)
    expect(a.conditionBlockers).toEqual(conditionBlockers(sea))
    expect(a.conditionBlockers).toEqual([])
  })
})

describe('missing data is stated, not filled in', () => {
  it('a complete build without flight conditions: no T/W, an air density of null, both conditions listed with their links', () => {
    const a = analyse(quad(), geo, components, {}, 25)
    expect(a.conditions).toEqual(EMPTY_CONDITIONS)
    expect(a.airDensityKgM3).toBeNull()
    expect(a.thrust.state).toBe('unknown')
    expect(a.thrust.detail).toContain('ambient altitude')
    expect(a.conditionBlockers.map((b) => [b.id, b.link])).toEqual([
      ['flight-altitude', { to: 'flight-field', elementId: 'flight-altitude' }],
      ['flight-cutoff', { to: 'flight-field', elementId: 'flight-cutoff-value' }],
    ])
    // The build's own values are unaffected by the missing conditions.
    expect(a.mass).toEqual(massState(quad(), geo, components, {}))
  })

  it('an empty build: no CoM, inertia or hover balance; the frame is listed without a mass; no electrical result', () => {
    const a = analyse(empty, geo, components, {}, 25)
    expect(a.mass.mp.com).toBeNull()
    expect(a.mass.mp.inertia).toBeNull()
    expect(a.mass.hover).toBeNull()
    expect(a.comOffsetM).toBeNull()
    expect(a.mass.mp.missingMass).toEqual([{ id: 'frame', name: 'Frame' }])
    expect(a.hoverFindings).toEqual([])
    expect(a.thrust.state).toBe('unknown')
    expect(a.electrical.battery).toBeNull()
    expect(a.electrical.problem).not.toBeNull()
    expect(a.ready.length).toBeGreaterThan(0)
  })

  it('a part without a mass is listed with its id (the page links to it) and the CoM leaves it out', () => {
    const added = addPart({ ...empty, frameMass: { valueKg: 0.3, source: 'user' } }, 'payload', { kind: 'mount', id: 'plate-top' }, frame.armThickness, 'pay')
    const a = analyse(added.doc, geo, components, {}, 25)
    expect(a.mass.mp.missingMass).toEqual([{ id: 'pay', name: added.part.name }])
    expect(a.mass.mp.com).not.toBeNull()
    expect(a.hoverFindings.map((f) => f.severity)).toEqual(['cannot-check'])
  })

  it('a motor reference density that no source states is null for that motor', () => {
    const noDensity = { ...components, [motor.id]: named('MN3110 KV470') }
    const a = analyse(quad(sea), geo, noDensity, {}, 25)
    expect(a.motorDensities.every((m) => m.density === null)).toBe(true)
    expect(a.thrust.state).toBe('unknown')
  })
})
