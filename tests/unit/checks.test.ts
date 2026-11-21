import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Component, SpecValue } from '../../electron/ipc/component-fields'
import type { AssemblyDocument, PartKind, PartShape } from '../../electron/ipc/contract'
import { PROP_CLEARANCE, RULES, report, runChecks, summary, type CheckInput, type CheckPart, type Vec3 } from '../../src/domain/checks'
import { allFindings } from '../../src/features/workshop/findings'
import { buildFrame } from '../../src/three/frame-geometry'

const seed = JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as { components: Component[] }
const lib = (name: string) => ({ ...seed.components.find((c) => c.name === name)!, origin: 'built-in' }) as Component
/** A test-only user component (not a real product). */
const own = (category: Component['category'], name: string, specs: Record<string, SpecValue>) =>
  ({ id: randomUUID(), category, name, manufacturer: 'Test', notes: null, specs, origin: 'user', schemaVersion: 1, revision: 0, createdAt: '', updatedAt: '' }) as Component
const user = (value: number, unit?: string) => ({ value, ...(unit ? { unit } : {}), source: 'user' }) as SpecValue

const MOUNTS = [
  { id: 'motor-1', number: 1, spin: 'ccw' as const },
  { id: 'motor-2', number: 2, spin: 'ccw' as const },
  { id: 'motor-3', number: 3, spin: 'cw' as const },
  { id: 'motor-4', number: 4, spin: 'cw' as const },
]
const UP: Vec3 = [0, 0, 1]
const disc = (radius: number, height = 0.008): PartShape => ({ type: 'cylinder', radius, height })

function p(kind: PartKind, component: Component | null, over: Partial<CheckPart> = {}): CheckPart {
  return {
    id: randomUUID(),
    name: `${kind} ${Math.random().toString(36).slice(2, 5)}`,
    kind,
    component,
    motorMount: null,
    parentId: null,
    shape: { type: 'box', size: [0.05, 0.05, 0.05] },
    center: [0, 0, 0.05],
    axis: UP,
    ...over,
  }
}
const input = (parts: CheckPart[], frameTop = 0.004): CheckInput => ({ rotors: 4, motorMounts: MOUNTS, frameTop, parts })

/** Four motors (one per mount) with props on them, plus optional extras. */
/** Motors at `reach` from the centre: 0.225 m is a 450 mm motor-to-motor diagonal. */
function quad(motor: Component | null, prop: Component | null, extras: CheckPart[] = [], propRadius = 0.127, reach = 0.225) {
  const parts: CheckPart[] = []
  MOUNTS.forEach((m, i) => {
    const a = (Math.PI / 4) * (2 * i + 1)
    const motorPart = p('motor', motor, { name: `Motor ${m.number}`, motorMount: m, center: [Math.cos(a) * reach, Math.sin(a) * reach, 0.02] })
    parts.push(motorPart)
    parts.push(
      p('propeller', prop, {
        name: `Propeller ${m.number}`,
        motorMount: m,
        parentId: motorPart.id,
        shape: disc(propRadius),
        center: [Math.cos(a) * reach, Math.sin(a) * reach, 0.045],
      }),
    )
  })
  return [...parts, ...extras]
}
const rules = (parts: CheckPart[]) => runChecks(input(parts)).map((f) => `${f.severity}:${f.rule}`)

const MN700 = lib('MN3110 KV700')
const TEKKO4IN1 = lib('Tekko32 F4 4in1 50A ESC (AM32)')
const TATTU = lib('Tattu G-Tech 5200mAh 4S 35C')
const P13 = lib('P13*4.4 CF propeller')

describe('compatibility checks', () => {
  it('a sound build with the built-in parts has no errors or warnings', () => {
    // 13" props on a 550 mm quad: adjacent motors 389 mm apart, discs need 330 mm.
    const parts = quad(MN700, P13, [p('esc', TEKKO4IN1), p('battery', TATTU)], 0.1651, 0.275)
    expect(runChecks(input(parts)).filter((x) => x.severity !== 'cannot-check')).toEqual([])
    // The same props on a 450 mm quad overlap (motors 318 mm apart): the check catches it.
    const tight = runChecks(input(quad(MN700, P13, [], 0.1651, 0.225))).filter((x) => x.rule === 'prop-clearance')
    expect(tight).toHaveLength(4)
    expect(tight[0]!.message).toMatch(/overlap by 12 mm\.$/)
  })

  it('motor-count: empty mounts warn, two motors on one mount is an error', () => {
    const two = quad(MN700, null).filter((x) => x.kind === 'motor').slice(0, 2)
    expect(runChecks(input(two))).toEqual([
      expect.objectContaining({ rule: 'motor-count', severity: 'warning', message: 'Motor mounts 3, 4 have no motor (4 needed).' }),
    ])
    const doubled = [...quad(MN700, null).filter((x) => x.kind === 'motor'), p('motor', MN700, { name: 'Extra', motorMount: MOUNTS[0] })]
    expect(rules(doubled)).toContain('error:motor-count')
  })

  it('battery-cells: a 6S battery with a 4S-max ESC is an error naming both; in-range passes', () => {
    const esc4s = own('esc', 'Test ESC 4S', { format: { value: 'single', source: 'user' } as SpecValue, cellsMin: user(2), cellsMax: user(4), continuousCurrent: user(30, 'A') })
    const bat6s = own('battery', 'Test 6S pack', { series: user(6), capacity: user(1300, 'mAh'), cRateContinuous: user(100, 'C') })
    const escPart = p('esc', esc4s, { name: 'ESC 1' })
    const batPart = p('battery', bat6s, { name: 'Battery 1' })
    const f = runChecks(input([escPart, batPart])).filter((x) => x.rule === 'battery-cells')
    expect(f).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'Battery 1 (Test 6S pack) is 6S, but ESC 1 (Test ESC 4S) is rated for at most 4S (Test ESC 4S: 4).',
        partIds: [batPart.id, escPart.id],
      }),
    ])
    expect(runChecks(input([p('esc', TEKKO4IN1), p('battery', TATTU)])).filter((x) => x.rule === 'battery-cells')).toEqual([])
    // Below the minimum: the Tekko 4in1 needs at least 4S.
    const bat3s = own('battery', 'Test 3S', { series: user(3) })
    expect(rules([p('esc', TEKKO4IN1), p('battery', bat3s)])).toContain('error:battery-cells')
  })

  it('battery-cells: cannot check with two batteries, or with a part that states no range', () => {
    expect(runChecks(input([p('esc', TEKKO4IN1), p('battery', TATTU), p('battery', TATTU)]))[0]).toMatchObject({
      severity: 'cannot-check',
      message: 'Cannot check cell ranges: 2 batteries: whether they are in series or parallel is set by the wiring (Electrical Designer).',
    })
    expect(runChecks(input([p('esc', null, { name: 'ESC 1' }), p('battery', TATTU)])).map((f) => f.message)).toContain(
      'Cannot check ESC 1 against the 4S battery: no cell range stated (not linked to a component).',
    )
  })

  it('esc-outputs: one 4-in-1 covers four motors; one single ESC does not', () => {
    expect(rules(quad(MN700, null, [p('esc', TEKKO4IN1)]))).not.toContain('error:esc-outputs')
    expect(rules(quad(MN700, null, [p('esc', lib('Tekko32 F4 45A ESC (AM32)'))]))).toContain('error:esc-outputs')
    expect(rules(quad(MN700, null, [p('esc', null)]))).toContain('cannot-check:esc-outputs')
  })

  it('esc-current: the ESC must cover the motor maximum; mixed ESCs cannot be paired yet', () => {
    expect(rules(quad(lib('MN3110 KV780'), null, [p('esc', TEKKO4IN1)]))).not.toContain('error:esc-current') // 50 A ≥ 26 A
    const weak = own('esc', 'Test 20A', { format: { value: '4-in-1', source: 'user' } as SpecValue, continuousCurrent: user(20, 'A') })
    const f = runChecks(input(quad(MN700, null, [p('esc', weak)]))).find((x) => x.rule === 'esc-current')!
    expect(f.severity).toBe('error')
    expect(f.message).toBe("Test 20A is rated 20 A per motor, below MN3110 KV700's maximum 21 A (Max continuous current (180 s)).")
    expect(rules(quad(MN700, null, [p('esc', TEKKO4IN1), p('esc', weak)]))).toContain('cannot-check:esc-current')
  })

  it('battery-current: C × capacity (calculated) must cover all motors at their maximum', () => {
    // Tattu 5200 mAh × 35 C = 182 A ≥ 4 × 21 A.
    expect(rules(quad(MN700, null, [p('battery', TATTU)]))).not.toContain('error:battery-current')
    const small = own('battery', 'Test 1000 20C', { series: user(4), capacity: user(1000, 'mAh'), cRateContinuous: user(20, 'C') })
    const f = runChecks(input(quad(MN700, null, [p('battery', small, { name: 'Battery 1' })]))).find((x) => x.rule === 'battery-current')!
    expect(f).toMatchObject({ severity: 'error' })
    expect(f.message).toBe('Battery 1 (Test 1000 20C) can supply 20 A continuously (calculated: 20 C × 1000 mAh), below the 84 A of 4 motors at their stated maximum.')
    const noC = own('battery', 'No C', { series: user(4), capacity: user(1000, 'mAh') })
    expect(rules(quad(MN700, null, [p('battery', noC)]))).toContain('cannot-check:battery-current')
  })

  it('prop-bore: smaller than the shaft is an error, larger needs an adapter, equal passes', () => {
    // APC 10x4.5MR: 1/4 in (6.35 mm) bore on the MN3110's 4 mm shaft.
    const adapter = runChecks(input(quad(MN700, lib('10x4.5MR')))).filter((f) => f.rule === 'prop-bore')
    expect(adapter).toHaveLength(1) // four identical pairs, one finding
    expect(adapter[0]).toMatchObject({ severity: 'warning' })
    expect(adapter[0]!.partIds).toHaveLength(8)
    expect(adapter[0]!.message).toBe('4 × 10x4.5MR have a 0.25 in bore on the 4 mm shaft of 4 × MN3110 KV700: an adapter ring or prop adapter is needed.')
    // A single pair names the parts.
    const one = quad(MN700, lib('10x4.5MR')).slice(0, 2)
    expect(runChecks(input(one)).find((f) => f.rule === 'prop-bore')!.message).toBe(
      'Propeller 1 (10x4.5MR) has a 0.25 in bore on the 4 mm shaft of Motor 1 (MN3110 KV700): an adapter ring or prop adapter is needed.',
    )
    const tight = own('propeller', 'Test 3mm bore', { boreDiameter: user(3, 'mm') })
    expect(rules(quad(MN700, tight))).toContain('error:prop-bore')
    const exact = own('propeller', 'Test 4mm bore', { boreDiameter: user(4, 'mm') })
    expect(rules(quad(MN700, exact))).not.toContain('error:prop-bore')
  })

  it('prop-hand: a CW prop on a CCW mount is an error; matching or sold as a pair passes', () => {
    const cw = own('propeller', 'Test CW', { hand: { value: 'cw', source: 'user' } as SpecValue })
    const f = runChecks(input(quad(MN700, cw))).filter((x) => x.rule === 'prop-hand')
    expect(f.map((x) => x.message)).toEqual([
      'Propeller 1 (Test CW) turns CW but motor mount 1 spins CCW.',
      'Propeller 2 (Test CW) turns CW but motor mount 2 spins CCW.',
    ])
    expect(rules(quad(MN700, P13))).not.toContain('error:prop-hand') // P13 is sold as a pair
  })

  it('prop-clearance: overlap is an error, under 10 mm a warning; discs at different heights are not compared', () => {
    const two = (gapAt: number, dz = 0) => [
      p('propeller', null, { name: 'A', shape: disc(0.127), center: [0, 0, 0.05] }),
      p('propeller', null, { name: 'B', shape: disc(0.127), center: [gapAt, 0, 0.05 + dz] }),
    ]
    expect(runChecks(input(two(0.24)))).toEqual([expect.objectContaining({ severity: 'error', message: 'A and B overlap by 14 mm.' })])
    expect(runChecks(input(two(0.26)))).toEqual([expect.objectContaining({ severity: 'warning', message: 'A and B are only 6 mm apart at the tips.' })])
    expect(runChecks(input(two(0.254 + PROP_CLEARANCE + 0.001)))).toEqual([])
    expect(runChecks(input(two(0.24, 0.05)))).toEqual([]) // stacked 50 mm apart
  })

  it('prop-frame: a disc reaching below the frame top is an error', () => {
    const low = p('propeller', null, { name: 'Low', shape: disc(0.127), center: [0, 0, 0.002] })
    expect(runChecks(input([low], 0.004))).toEqual([expect.objectContaining({ rule: 'prop-frame', severity: 'error', message: "Low's swept disc reaches 6 mm below the top of the frame." })])
  })

  it('prop-bore and prop-hand say "cannot check" when a part is unlinked or states no hand (3.8)', () => {
    // Unlinked propellers and motors: one finding per rule, naming the parts.
    const bare = runChecks(input(quad(null, null)))
    expect(bare.find((f) => f.rule === 'prop-bore')).toMatchObject({
      severity: 'cannot-check',
      message: 'Cannot check the bore of Propeller 1, Propeller 2, Propeller 3 and Propeller 4: the propellers and their motors are not linked to a component.',
    })
    expect(bare.find((f) => f.rule === 'prop-hand')).toMatchObject({
      severity: 'cannot-check',
      message: 'Cannot check the rotation of Propeller 1, Propeller 2, Propeller 3 and Propeller 4: they are not linked to a component.',
    })
    // Linked propellers on unlinked motors: only the motor side is named.
    expect(runChecks(input(quad(null, P13).slice(0, 2))).find((f) => f.rule === 'prop-bore')!.message).toBe('Cannot check the bore of Propeller 1: its motor is not linked to a component.')
    // A linked APC 10x4.5MR states no hand in its cited data, so rotation cannot be checked; the bore can.
    const apc = runChecks(input(quad(MN700, lib('10x4.5MR')).slice(0, 2)))
    expect(apc.find((f) => f.rule === 'prop-hand')!.message).toBe('Cannot check the rotation of Propeller 1: 10x4.5MR states no hand (CW, CCW or pair).')
    expect(apc.filter((f) => f.rule === 'prop-bore').map((f) => f.severity)).toEqual(['warning'])
    // A prop sold as a pair, on linked motors: nothing to report about rotation.
    expect(runChecks(input(quad(MN700, P13))).filter((f) => f.rule === 'prop-hand')).toEqual([])
    // A propeller not on a motor mount has no spin to compare with: not a rotor, not checked.
    const loose = p('propeller', null, { name: 'Spare', shape: disc(0.127), center: [1, 1, 0.05] })
    expect(runChecks(input([loose])).filter((f) => f.rule === 'prop-hand')).toEqual([])
  })

  it('prop-frame: a disc above the frame top passes', () => {
    const high = p('propeller', null, { name: 'High', shape: disc(0.127), center: [0, 0, 0.05] })
    expect(runChecks(input([high], 0.004)).filter((f) => f.rule === 'prop-frame')).toEqual([])
  })

  /**
   * Acceptance (Phase 3): every check has passing and failing inputs, and says
   * "cannot check" when data it needs is missing. One row per assembly rule; the
   * wiring rules are covered the same way in wiring.test.ts. Geometric rules
   * (prop-clearance, prop-frame) and motor-count need no stated data, so they have
   * no "cannot check" case.
   */
  it('covers every rule with a passing, a failing and (where data can be missing) a cannot-check input', () => {
    const weakEsc = own('esc', 'Test 20A', { format: { value: '4-in-1', source: 'user' } as SpecValue, continuousCurrent: user(20, 'A') })
    const smallBat = own('battery', 'Test 1000 20C', { series: user(4), capacity: user(1000, 'mAh'), cRateContinuous: user(20, 'C') })
    const cw = own('propeller', 'Test CW', { hand: { value: 'cw', source: 'user' } as SpecValue })
    const onMount = (rule: string, parts: CheckPart[]) => runChecks(input(parts)).filter((f) => f.rule === rule).map((f) => f.severity)
    const fails = (sev: string[]) => sev.includes('error') || sev.includes('warning')
    const table: Record<string, { pass: CheckPart[]; fail: CheckPart[]; cannot?: CheckPart[] }> = {
      'motor-count': { pass: quad(MN700, null), fail: quad(MN700, null).filter((x) => x.kind === 'motor').slice(0, 3) },
      'battery-cells': { pass: [p('esc', TEKKO4IN1), p('battery', TATTU)], fail: [p('esc', TEKKO4IN1), p('battery', own('battery', '3S', { series: user(3) }))], cannot: [p('esc', null), p('battery', TATTU)] },
      'esc-outputs': { pass: quad(MN700, null, [p('esc', TEKKO4IN1)]), fail: quad(MN700, null, [p('esc', lib('Tekko32 F4 45A ESC (AM32)'))]), cannot: quad(MN700, null, [p('esc', null)]) },
      'esc-current': { pass: quad(MN700, null, [p('esc', TEKKO4IN1)]), fail: quad(MN700, null, [p('esc', weakEsc)]), cannot: quad(null, null, [p('esc', TEKKO4IN1)]) },
      'battery-current': { pass: quad(MN700, null, [p('battery', TATTU)]), fail: quad(MN700, null, [p('battery', smallBat)]), cannot: quad(null, null, [p('battery', TATTU)]) },
      'prop-bore': { pass: quad(MN700, own('propeller', '4mm', { boreDiameter: user(4, 'mm') })), fail: quad(MN700, own('propeller', '3mm', { boreDiameter: user(3, 'mm') })), cannot: quad(MN700, P13) },
      'prop-hand': { pass: quad(MN700, P13), fail: quad(MN700, cw), cannot: quad(MN700, lib('10x4.5MR')) },
      'prop-clearance': { pass: quad(MN700, P13, [], 0.1651, 0.275), fail: quad(MN700, P13, [], 0.1651, 0.225) },
      'prop-frame': { pass: [p('propeller', null, { shape: disc(0.127), center: [0, 0, 0.05] })], fail: [p('propeller', null, { shape: disc(0.127), center: [0, 0, 0.002] })] },
    }
    const wiringRules = ['wire-port', 'wire-kind', 'port-conflict', 'unwired']
    expect(Object.keys(table).sort()).toEqual(Object.keys(RULES).filter((r) => !wiringRules.includes(r)).sort())
    for (const [rule, cases] of Object.entries(table)) {
      expect(fails(onMount(rule, cases.pass)), `${rule}: pass case`).toBe(false)
      expect(fails(onMount(rule, cases.fail)), `${rule}: fail case`).toBe(true)
      if (cases.cannot) expect(onMount(rule, cases.cannot), `${rule}: cannot-check case`).toContain('cannot-check')
    }
  })

  it('the workshop and the designer share one findings computation per document', () => {
    const doc: AssemblyDocument = { frame: { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.12 }, motors: {}, parts: [] }
    const geo = buildFrame('quad-x', doc.frame, doc.motors)
    const first = allFindings(doc, geo, {})
    expect(allFindings(doc, geo, {})).not.toBe(first) // a different component index is a different input
    const index = {}
    const a = allFindings(doc, geo, index)
    expect(allFindings(doc, geo, index)).toBe(a)
    expect(allFindings({ ...doc }, geo, index)).not.toBe(a) // an edit makes a new document
  })

  it('report: Markdown with counts, sections and the rules that ran', () => {
    const f = runChecks(input(quad(MN700, lib('10x4.5MR'), [p('esc', lib('Tekko32 F4 45A ESC (AM32)'))])))
    expect(summary(f)).toMatchObject({ error: 1, warning: 1 })
    const md = report('Test quad', f, '2026-11-21 12:00')
    expect(md).toContain('# Compatibility report: Test quad')
    expect(md).toContain('1 error, 1 warning')
    expect(md).toContain('## Errors\n\n- 4 motors but the ESCs provide 1 output.')
    expect(md).toContain('- **prop-hand**: ')
    expect(report('Empty', [], 'now')).toContain('No problems found')
  })
})
