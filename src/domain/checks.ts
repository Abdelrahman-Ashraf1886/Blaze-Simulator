/**
 * Compatibility checks for an assembly. Pure: no React, no three.js. The workshop
 * builds a `CheckInput` (linked components, world positions) and shows the findings.
 *
 * Principles
 * - Only stated values are compared. A check that needs a value nobody has entered
 *   reports `cannot-check` and says which value is missing; it never assumes one.
 * - Values are compared in SI (`toSI`), so "1300 mAh" and "1.3 Ah" agree.
 * - Each message names the parts, states both numbers with their conditions, and
 *   says why it matters.
 * - Checks that need wiring (port conflicts, unwired parts) are in wiring.ts; current
 *   ratings for a load case and cable drops are in electrical.ts.
 */
import type { Component, QuantityValue, SpecValue } from '../../electron/ipc/component-fields'
import type { PartKind, PartShape } from '../../electron/ipc/contract'
import { toSI } from './units'

export type Severity = 'error' | 'warning' | 'cannot-check'
export type Vec3 = readonly [number, number, number]

export interface Finding {
  /** Stable for a given rule and set of parts, so the UI can key and dismiss it. */
  id: string
  rule: RuleId
  severity: Severity
  message: string
  partIds: string[]
}

export type RuleId =
  | 'motor-count'
  | 'battery-cells'
  | 'esc-current'
  | 'esc-outputs'
  | 'battery-current'
  | 'prop-bore'
  | 'prop-hand'
  | 'prop-clearance'
  | 'prop-frame'
  | 'wire-port'
  | 'wire-kind'
  | 'port-conflict'
  | 'unwired'
  | 'hover-balance'

/** Minimum tip-to-tip gap before a warning, in metres (10 mm). */
export const PROP_CLEARANCE = 0.01

/** One sentence per rule: what it compares and why. Shown in the report. */
export const RULES: Record<RuleId, string> = {
  'motor-count': 'Every motor mount of the frame layout needs exactly one motor.',
  'battery-cells': 'The battery\'s cell count must lie within the cell range of every motor and ESC; outside it the parts are over-volted or under-powered.',
  'esc-current': 'An ESC\'s continuous current per motor must cover the motor\'s maximum current, or the ESC overheats at full throttle.',
  'esc-outputs': 'The ESCs must provide one output per motor (a 4-in-1 ESC provides four).',
  'battery-current': 'The battery\'s continuous current (C rating × capacity) must cover all motors at their maximum current together.',
  'prop-bore': 'The propeller\'s bore must fit the motor shaft: smaller does not fit, larger needs an adapter.',
  'prop-hand': 'A propeller\'s rotation must match its motor\'s spin, or it pushes air the wrong way.',
  'prop-clearance': `Swept propeller discs at the same height must not overlap; less than ${PROP_CLEARANCE * 1000} mm between tips is flagged.`,
  'prop-frame': 'A propeller disc must be above the top of the frame.',
  'wire-port': 'Every wire must end on a port the part has (relinking a part can remove ports).',
  'wire-kind': 'A wire may only join ports of the same kind (power to power, motor phases to an ESC output, UART to UART…).',
  'port-conflict': 'A point-to-point port (UART, RC, ESC signal, motor phases, power sense) takes one cable; power, CAN and I²C are shared buses.',
  'unwired': 'Once wiring has started: the battery and power module must be connected, every ESC powered, every motor on an ESC output, every used ESC output given a signal, every peripheral connected, and the flight controller powered.',
  'hover-balance': 'To hover level, the thrust of the motors must hold the weight with no roll or pitch moment about the centre of mass. A motor whose share is far above the mean has less headroom for control; a centre of mass outside the motors cannot be held at all.',
}


export interface CheckPart {
  id: string
  name: string
  kind: PartKind
  component: Component | null
  /** Motor mount the part (or the part it sits on) is attached to, if any. */
  motorMount: { id: string; number: number; spin: 'cw' | 'ccw' } | null
  parentId: string | null
  /** Shape as drawn (linked size applied), in the part's own frame. */
  shape: PartShape
  /** World position of the part's origin and its local +Z axis in the world. */
  center: Vec3
  axis: Vec3
}

export interface CheckInput {
  /** From the wiring, when present: which ESC part drives each motor part. */
  escOfMotor?: Readonly<Record<string, string>>
  rotors: number
  motorMounts: { id: string; number: number }[]
  /** World height of the top of the frame (arms and plate). */
  frameTop: number
  parts: CheckPart[]
}

// ---- helpers --------------------------------------------------------------------------------

const quantity = (s: SpecValue | undefined): QuantityValue | null =>
  s && typeof s.value === 'number' && 'unit' in s ? (s as QuantityValue) : null
const si = (c: Component | null, key: string) => {
  const q = c ? quantity(c.specs[key]) : null
  return q ? toSI(q.value, q.unit) : null
}
const count = (c: Component | null, key: string) => {
  const v = c?.specs[key]?.value
  return typeof v === 'number' ? v : null
}
const text = (c: Component | null, key: string) => {
  const v = c?.specs[key]?.value
  return typeof v === 'string' ? v : null
}
/** "21 A (Max continuous current (180 s))" — the value as stated, with its condition. */
const stated = (c: Component, key: string) => {
  const s = c.specs[key] as (QuantityValue & { condition?: string }) | undefined
  if (!s) return '?'
  const v = 'unit' in s && s.unit ? `${round(s.value)} ${s.unit}` : String(s.value)
  return s.condition ? `${v} (${s.condition})` : v
}
const round = (n: number) => String(Number(n.toPrecision(6)))
/** "0.25 in" — the value in the unit its source states, without the condition. */
const asStated = (c: Component, key: string) => {
  const s = c.specs[key] as QuantityValue | undefined
  return s ? `${round(s.value)} ${s.unit}` : '?'
}
/** Metres as millimetres to 0.1 mm, e.g. 0.0120019 → "12". */
const mm = (m: number) => String(Math.round(m * 10_000) / 10)
const label = (p: CheckPart) => (p.component ? `${p.name} (${p.component.name})` : p.name)
const fid = (rule: RuleId, ids: string[], extra = '') => `${rule}:${[...ids].sort().join(',')}${extra ? `:${extra}` : ''}`

function finding(rule: RuleId, severity: Severity, message: string, parts: CheckPart[], extra = ''): Finding {
  const partIds = parts.map((p) => p.id)
  return { id: fid(rule, partIds, extra), rule, severity, message, partIds }
}

// ---- rules ------------------------------------------------------------------------------------

function motorCount(input: CheckInput): Finding[] {
  const motors = input.parts.filter((p) => p.kind === 'motor')
  const byMount = new Map<string, CheckPart[]>()
  for (const m of motors) if (m.motorMount) byMount.set(m.motorMount.id, [...(byMount.get(m.motorMount.id) ?? []), m])
  const out: Finding[] = []
  const empty = input.motorMounts.filter((mm) => !byMount.has(mm.id))
  if (empty.length > 0 && motors.length > 0) {
    out.push(
      finding('motor-count', 'warning', `Motor mount${empty.length > 1 ? 's' : ''} ${empty.map((m) => m.number).join(', ')} ${empty.length > 1 ? 'have' : 'has'} no motor (${input.rotors} needed).`, [], empty.map((m) => m.id).join(',')),
    )
  }
  for (const [mount, list] of byMount) {
    if (list.length > 1) {
      out.push(finding('motor-count', 'error', `${list.map((p) => p.name).join(' and ')} are both on motor mount ${list[0]!.motorMount!.number}.`, list, mount))
    }
  }
  return out
}

/** The single battery's cell count, or a reason it cannot be known yet. */
function batteryCells(input: CheckInput): { part: CheckPart; cells: number } | { reason: string; parts: CheckPart[] } | null {
  const batteries = input.parts.filter((p) => p.kind === 'battery')
  if (batteries.length === 0) return null
  if (batteries.length > 1) return { reason: `${batteries.length} batteries: whether they are in series or parallel is set by the wiring (Electrical Designer)`, parts: batteries }
  const b = batteries[0]!
  const cells = count(b.component, 'series')
  if (cells === null) return { reason: `${label(b)} has no stated cell count (S)`, parts: [b] }
  return { part: b, cells }
}

function batteryCellRange(input: CheckInput): Finding[] {
  const bat = batteryCells(input)
  if (!bat) return []
  const consumers = input.parts.filter((p) => p.kind === 'motor' || p.kind === 'esc')
  if (consumers.length === 0) return []
  if ('reason' in bat) return [finding('battery-cells', 'cannot-check', `Cannot check cell ranges: ${bat.reason}.`, bat.parts)]
  const out: Finding[] = []
  // One finding per component model, not per motor: four identical motors give one message.
  const groups = new Map<string, CheckPart[]>()
  for (const p of consumers) groups.set(p.component?.id ?? `own:${p.id}`, [...(groups.get(p.component?.id ?? `own:${p.id}`) ?? []), p])
  for (const parts of groups.values()) {
    const p = parts[0]!
    const what = parts.length > 1 ? `${parts.length} × ${p.component?.name ?? p.name}` : label(p)
    const lo = count(p.component, 'cellsMin')
    const hi = count(p.component, 'cellsMax')
    if (lo === null && hi === null) {
      out.push(finding('battery-cells', 'cannot-check', `Cannot check ${what} against the ${bat.cells}S battery: no cell range stated${p.component ? '' : ' (not linked to a component)'}.`, parts))
      continue
    }
    if (hi !== null && bat.cells > hi) {
      out.push(finding('battery-cells', 'error', `${label(bat.part)} is ${bat.cells}S, but ${what} is rated for at most ${hi}S (${p.component!.name}: ${stated(p.component!, 'cellsMax')}).`, [bat.part, ...parts]))
    } else if (lo !== null && bat.cells < lo) {
      out.push(finding('battery-cells', 'error', `${label(bat.part)} is ${bat.cells}S, but ${what} needs at least ${lo}S (${p.component!.name}: ${stated(p.component!, 'cellsMin')}).`, [bat.part, ...parts]))
    }
  }
  return out
}

function escOutputs(input: CheckInput): Finding[] {
  const motors = input.parts.filter((p) => p.kind === 'motor')
  const escs = input.parts.filter((p) => p.kind === 'esc')
  if (motors.length === 0 || escs.length === 0) return []
  let outputs = 0
  const unknown: CheckPart[] = []
  for (const e of escs) {
    const f = text(e.component, 'format')
    if (f === '4-in-1') outputs += 4
    else if (f === 'single') outputs += 1
    else unknown.push(e)
  }
  if (unknown.length > 0) {
    return [finding('esc-outputs', 'cannot-check', `Cannot count ESC outputs: ${unknown.map(label).join(', ')} ${unknown.length > 1 ? 'have' : 'has'} no stated format (single or 4-in-1).`, unknown)]
  }
  if (outputs < motors.length) {
    return [finding('esc-outputs', 'error', `${motors.length} motors but the ESCs provide ${outputs} output${outputs === 1 ? '' : 's'}.`, escs)]
  }
  return []
}

function escCurrent(input: CheckInput): Finding[] {
  const motors = input.parts.filter((p) => p.kind === 'motor')
  const escs = input.parts.filter((p) => p.kind === 'esc')
  if (motors.length === 0 || escs.length === 0) return []
  const models = new Set(escs.map((e) => e.component?.id ?? `own:${e.id}`))
  if (models.size > 1) {
    // Different ESCs: pair them through the wiring when every motor is wired.
    const wiring = input.escOfMotor ?? {}
    const byId = new Map(escs.map((e) => [e.id, e]))
    if (!motors.every((m) => byId.has(wiring[m.id] ?? ''))) {
      return [finding('esc-current', 'cannot-check', 'Cannot pair ESCs with motors: the ESCs differ and not every motor is wired to one yet (Electrical Designer).', escs)]
    }
    return motors.flatMap((m) => {
      const esc = byId.get(wiring[m.id]!)!
      const escA = si(esc.component, 'continuousCurrent')
      const motorA = si(m.component, 'maxCurrent')
      if (escA === null || motorA === null) {
        return [finding('esc-current', 'cannot-check', `Cannot check ${label(esc)} driving ${label(m)}: no stated ${escA === null ? 'ESC continuous current' : 'motor maximum current'}.`, [esc, m])]
      }
      return escA < motorA
        ? [finding('esc-current', 'error', `${label(esc)} is rated ${stated(esc.component!, 'continuousCurrent')}, below ${label(m)}'s maximum ${stated(m.component!, 'maxCurrent')}.`, [esc, m])]
        : []
    })
  }
  const esc = escs[0]!
  const escA = si(esc.component, 'continuousCurrent')
  if (escA === null) return [finding('esc-current', 'cannot-check', `Cannot check ESC current: ${label(esc)} has no stated continuous current.`, [esc])]
  const out: Finding[] = []
  const groups = new Map<string, CheckPart[]>()
  for (const m of motors) groups.set(m.component?.id ?? `own:${m.id}`, [...(groups.get(m.component?.id ?? `own:${m.id}`) ?? []), m])
  for (const parts of groups.values()) {
    const m = parts[0]!
    const motorA = si(m.component, 'maxCurrent')
    const what = parts.length > 1 ? `${parts.length} × ${m.component?.name ?? m.name}` : label(m)
    if (motorA === null) {
      out.push(finding('esc-current', 'cannot-check', `Cannot check ESC current for ${what}: no stated maximum current.`, parts))
    } else if (escA < motorA) {
      out.push(
        finding('esc-current', 'error', `${esc.component!.name} is rated ${stated(esc.component!, 'continuousCurrent')} per motor, below ${m.component!.name}'s maximum ${stated(m.component!, 'maxCurrent')}.`, [...escs, ...parts]),
      )
    }
  }
  return out
}

function batteryCurrent(input: CheckInput): Finding[] {
  const bat = batteryCells(input)
  const motors = input.parts.filter((p) => p.kind === 'motor')
  if (!bat || motors.length === 0) return []
  if ('reason' in bat && bat.parts.length > 1) return [finding('battery-current', 'cannot-check', `Cannot check battery current: ${bat.reason}.`, bat.parts)]
  const b = 'reason' in bat ? bat.parts[0]! : bat.part
  const c = si(b.component, 'cRateContinuous')
  const q = si(b.component, 'capacity')
  if (c === null || q === null) {
    return [finding('battery-current', 'cannot-check', `Cannot check battery current: ${label(b)} has no stated ${c === null ? 'continuous C rating' : 'capacity'}.`, [b])]
  }
  const missing = motors.filter((m) => si(m.component, 'maxCurrent') === null)
  if (missing.length > 0) {
    return [finding('battery-current', 'cannot-check', `Cannot check battery current: ${missing.length} motor${missing.length > 1 ? 's have' : ' has'} no stated maximum current.`, missing)]
  }
  const available = c * q // calculated: C rating × capacity
  const demand = motors.reduce((s, m) => s + si(m.component, 'maxCurrent')!, 0)
  if (available < demand) {
    return [
      finding(
        'battery-current',
        'error',
        `${label(b)} can supply ${round(available)} A continuously (calculated: ${stated(b.component!, 'cRateContinuous')} × ${stated(b.component!, 'capacity')}), below the ${round(demand)} A of ${motors.length} motors at their stated maximum.`,
        [b, ...motors],
      ),
    ]
  }
  return []
}

/** Propeller and the motor it is attached to (directly). */
function propMotorPairs(input: CheckInput): [CheckPart, CheckPart][] {
  const byId = new Map(input.parts.map((p) => [p.id, p]))
  return input.parts.flatMap((p) => {
    const parent = p.kind === 'propeller' && p.parentId ? byId.get(p.parentId) : undefined
    return parent?.kind === 'motor' ? [[p, parent] as [CheckPart, CheckPart]] : []
  })
}

function propBore(input: CheckInput): Finding[] {
  // Identical prop/motor pairs give one finding ("4 × 10x4.5MR on 4 × MN3110 KV700").
  const groups = new Map<string, [CheckPart, CheckPart][]>()
  const unlinked: [CheckPart, CheckPart][] = []
  for (const pair of propMotorPairs(input)) {
    const [prop, motor] = pair
    if (!prop.component || !motor.component) {
      unlinked.push(pair)
      continue
    }
    const key = `${prop.component.id}|${motor.component.id}`
    groups.set(key, [...(groups.get(key) ?? []), pair])
  }
  const out: Finding[] = []
  if (unlinked.length > 0) {
    // Missing data is said, not skipped: one finding for every pair with an unlinked part.
    const one = unlinked.length === 1
    const props = unlinked.some(([prop]) => !prop.component)
    const motors = unlinked.some(([, motor]) => !motor.component)
    const what = [props && (one ? 'the propeller' : 'the propellers'), motors && (one ? 'its motor' : 'their motors')].filter(Boolean).join(' and ')
    const be = one && !(props && motors) ? 'is' : 'are'
    out.push(finding('prop-bore', 'cannot-check', `Cannot check the bore of ${names(unlinked.map(([prop]) => prop))}: ${what} ${be} not linked to a component.`, unlinked.flat(), 'unlinked'))
  }
  return out.concat([...groups.values()].flatMap((pairs) => {
    const [prop, motor] = pairs[0]!
    const parts = pairs.flat()
    const n = pairs.length
    const props = n > 1 ? `${n} × ${prop.component!.name}` : label(prop)
    const motors = n > 1 ? `${n} × ${motor.component!.name}` : label(motor)
    const bore = si(prop.component, 'boreDiameter')
    const shaft = si(motor.component, 'shaftDiameter')
    if (bore === null || shaft === null) {
      return [finding('prop-bore', 'cannot-check', `Cannot check ${props} on ${motors}: no stated ${bore === null ? 'propeller bore' : 'motor shaft diameter'}.`, parts)]
    }
    const have = n > 1 ? 'have' : 'has'
    if (bore + 1e-6 < shaft) {
      return [finding('prop-bore', 'error', `${props} ${have} a ${asStated(prop.component!, 'boreDiameter')} bore, smaller than the ${asStated(motor.component!, 'shaftDiameter')} shaft of ${motors}: it does not fit.`, parts)]
    }
    if (bore - shaft > 1e-4) {
      return [finding('prop-bore', 'warning', `${props} ${have} a ${asStated(prop.component!, 'boreDiameter')} bore on the ${asStated(motor.component!, 'shaftDiameter')} shaft of ${motors}: an adapter ring or prop adapter is needed.`, parts)]
    }
    return []
  }))
}

/** "Propeller 1", "Propeller 1 and Propeller 2", "Propeller 1, Propeller 2 and 3 more". */
function names(parts: readonly CheckPart[]): string {
  const n = parts.map((p) => p.name)
  if (n.length <= 2) return n.join(' and ')
  if (n.length <= 4) return `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`
  return `${n.slice(0, 3).join(', ')} and ${n.length - 3} more`
}

function propHand(input: CheckInput): Finding[] {
  // Propellers on a motor mount (whose spin is set) that cannot be compared, by reason.
  const unlinked: CheckPart[] = []
  const unstated: CheckPart[] = []
  const errors = propMotorPairs(input).flatMap(([prop, motor]) => {
    const hand = text(prop.component, 'hand')
    const spin = motor.motorMount?.spin
    if (!spin) return []
    if (!hand) {
      ;(prop.component ? unstated : unlinked).push(prop)
      return []
    }
    if (hand === 'pair') return []
    if (hand !== spin) {
      return [
        finding('prop-hand', 'error', `${label(prop)} turns ${hand.toUpperCase()} but motor mount ${motor.motorMount!.number} spins ${spin.toUpperCase()}.`, [prop, motor]),
      ]
    }
    return []
  })
  const be = (ps: CheckPart[]) => (ps.length === 1 ? 'is' : 'are')
  if (unlinked.length > 0) {
    errors.push(finding('prop-hand', 'cannot-check', `Cannot check the rotation of ${names(unlinked)}: ${unlinked.length === 1 ? 'it' : 'they'} ${be(unlinked)} not linked to a component.`, unlinked, 'unlinked'))
  }
  if (unstated.length > 0) {
    const models = [...new Set(unstated.map((p) => p.component!.name))]
    errors.push(finding('prop-hand', 'cannot-check', `Cannot check the rotation of ${names(unstated)}: ${models.join(', ')} ${models.length === 1 ? 'states' : 'state'} no hand (CW, CCW or pair).`, unstated, 'unstated'))
  }
  return errors
}

// ---- geometry ----------------------------------------------------------------------------------

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])

interface Disc {
  part: CheckPart
  radius: number
  thickness: number
}

function discs(input: CheckInput): Disc[] {
  return input.parts.flatMap((p) =>
    p.kind === 'propeller' && p.shape.type === 'cylinder' ? [{ part: p, radius: p.shape.radius, thickness: p.shape.height }] : [],
  )
}

/**
 * Two swept discs at (about) the same height overlap when the distance between
 * their axes, measured in the disc plane, is less than the sum of their radii.
 * Discs far apart along the axis (stacked coaxial props) are not compared. Discs
 * tilted more than 20° from each other are compared the same way; this is an
 * approximation and the message says so.
 */
function propClearance(input: CheckInput): Finding[] {
  const ds = discs(input)
  const out: Finding[] = []
  for (let i = 0; i < ds.length; i++)
    for (let j = i + 1; j < ds.length; j++) {
      const a = ds[i]!
      const b = ds[j]!
      const d = sub(b.part.center, a.part.center)
      const along = dot(d, a.part.axis)
      if (Math.abs(along) > (a.thickness + b.thickness) / 2 + PROP_CLEARANCE) continue // different heights
      const inPlane = len(sub(d, [a.part.axis[0] * along, a.part.axis[1] * along, a.part.axis[2] * along]))
      const gap = inPlane - a.radius - b.radius
      const tilted = dot(a.part.axis, b.part.axis) < Math.cos((20 * Math.PI) / 180)
      const note = tilted ? ' (approximate: the discs are tilted relative to each other)' : ''
      if (gap < 0) {
        out.push(finding('prop-clearance', 'error', `${a.part.name} and ${b.part.name} overlap by ${mm(-gap)} mm${note}.`, [a.part, b.part]))
      } else if (gap < PROP_CLEARANCE) {
        out.push(finding('prop-clearance', 'warning', `${a.part.name} and ${b.part.name} are only ${mm(gap)} mm apart at the tips${note}.`, [a.part, b.part]))
      }
    }
  return out
}

function propFrame(input: CheckInput): Finding[] {
  return discs(input).flatMap((d) => {
    const bottom = d.part.center[2] - (d.thickness / 2) * Math.abs(d.part.axis[2]) - d.radius * Math.hypot(d.part.axis[0], d.part.axis[1])
    return bottom < input.frameTop - 1e-6
      ? [finding('prop-frame', 'error', `${d.part.name}'s swept disc reaches ${mm(input.frameTop - bottom)} mm below the top of the frame.`, [d.part])]
      : []
  })
}

// ---- entry point ------------------------------------------------------------------------------------

const ORDER: Record<Severity, number> = { error: 0, warning: 1, 'cannot-check': 2 }

export function runChecks(input: CheckInput): Finding[] {
  return [
    ...motorCount(input),
    ...batteryCellRange(input),
    ...escOutputs(input),
    ...escCurrent(input),
    ...batteryCurrent(input),
    ...propBore(input),
    ...propHand(input),
    ...propClearance(input),
    ...propFrame(input),
  ].sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
}

export function summary(findings: readonly Finding[]): Record<Severity, number> {
  const s: Record<Severity, number> = { error: 0, warning: 0, 'cannot-check': 0 }
  for (const f of findings) s[f.severity]++
  return s
}

/** The findings as a Markdown report (copied from the Checks panel). */
export function report(projectName: string, findings: readonly Finding[], when: string): string {
  const s = summary(findings)
  const lines = [
    `# Compatibility report: ${projectName}`,
    '',
    `${when} · ${s.error} error${s.error === 1 ? '' : 's'}, ${s.warning} warning${s.warning === 1 ? '' : 's'}, ${s['cannot-check']} not checkable`,
    '',
  ]
  const title: Record<Severity, string> = { error: 'Errors', warning: 'Warnings', 'cannot-check': 'Could not check' }
  for (const sev of ['error', 'warning', 'cannot-check'] as const) {
    const list = findings.filter((f) => f.severity === sev)
    if (list.length === 0) continue
    lines.push(`## ${title[sev]}`, '')
    for (const f of list) lines.push(`- ${f.message}`)
    lines.push('')
  }
  if (findings.length === 0) lines.push('No problems found by the checks below.', '')
  lines.push('## Checks run', '')
  for (const [id, text] of Object.entries(RULES)) lines.push(`- **${id}**: ${text}`)
  lines.push('', 'Values come from the linked components and are compared as stated by their sources. Wiring checks apply once the project is wired in the Electrical Designer.')
  return `${lines.join('\n')}\n`
}
