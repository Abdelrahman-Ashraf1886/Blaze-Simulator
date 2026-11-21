/**
 * Steady-state electrical calculations for a wired assembly. Pure: no React, no three.js.
 *
 * Model (documented here and in the Electrical Designer's "Method" section)
 * - Load case: every motor draws either its stated maximum current, or one current the
 *   user enters. Motor currents are DC supply currents, as manufacturer test tables
 *   state them; the ESC's own losses and the avionics (flight controller, peripherals)
 *   are not included. A motor with neither value makes everything upstream of it
 *   "not calculated", never a guess.
 * - Power network: battery → (power module) → ESCs over the power cables. It must be a
 *   tree (one path from the battery to each ESC); a loop or two batteries in one
 *   network are refused, because their current split needs values nobody has entered.
 *   The current in a cable is the sum of the loads downstream of it (Kirchhoff's
 *   current law). A power module passes current through; its shunt is not modelled.
 * - Cable resistance: a power cable has two conductors (+ and −), so the current
 *   flows through twice its length:
 *     R = ρ(T) · 2L / A,  ρ(T) = ρ₂₀ · (1 + α₂₀ · (T − 20 °C)).
 *   Copper (IEC 60028, International Annealed Copper Standard; NIST Handbook 100):
 *     ρ₂₀ = 1/58 Ω·mm²/m = 1.7241 × 10⁻⁸ Ω·m,  α₂₀ = 0.00393 K⁻¹.
 *   A from AWG per ASTM B258 (see units.ts). Voltage drop ΔV = I·R, loss P = I²·R.
 * - Battery: V_terminal = V_oc − I·R_int, loss I²·R_int (a Thevenin source). V_oc is
 *   series × cell voltage at full charge, or the nominal pack voltage (series × cell
 *   nominal when the pack voltage is not stated). R_int is the pack's stated internal
 *   resistance; without it the terminal voltage is "not specified".
 * - Voltage at an ESC = V_terminal − the drops along its path. A motor is supplied
 *   through its ESC: the phase cables and the ESC are not modelled (phase currents
 *   depend on commutation; Phase 4).
 */
import type { Component, QuantityValue } from '../../electron/ipc/component-fields'
import type { Wire, WireEnd } from '../../electron/ipc/contract'
import { toSI } from './units'
import { otherEnd, portsOf, wireIndex, type WiringPart } from './wiring'

/** Copper resistivity at 20 °C, Ω·m (IEC 60028: 1/58 Ω·mm²/m). */
export const COPPER_RESISTIVITY_20C = 1 / 58 / 1e6
/** Copper temperature coefficient of resistance at 20 °C, K⁻¹ (IEC 60028). */
export const COPPER_ALPHA_20C = 0.00393

export interface LoadCase {
  /** 'max': each motor at its stated maximum current; 'fixed': each motor at `motorCurrentA`. */
  mode: 'max' | 'fixed'
  motorCurrentA?: number
  /** Battery open-circuit voltage: at full charge, or nominal. */
  battery: 'full' | 'nominal'
  /** Conductor temperature, °C. */
  conductorTempC: number
}

export const DEFAULT_LOAD_CASE: LoadCase = {
  mode: 'max',
  battery: 'nominal',
  conductorTempC: 20,
}

/** A number, or why it is missing. */
export type Calc = { value: number; formula?: string } | { value: null; reason: string }

const ok = (value: number, formula?: string): Calc => ({ value, formula })
const missing = (reason: string): Calc => ({ value: null, reason })

export interface CableResult {
  wireId: string
  /** Upstream and downstream ends, as the current flows. */
  from: WireEnd
  to: WireEnd
  current: Calc
  resistance: Calc
  drop: Calc
  loss: Calc
}

export interface LoadResult {
  partId: string
  name: string
  current: Calc
  /** Drop from the battery terminals to this part. */
  drop: Calc
  voltage: Calc
}

export interface RatingResult {
  partId: string
  name: string
  /** What is rated, e.g. "Continuous current". */
  what: string
  current: Calc
  rated: Calc
  /** null when either side is missing. */
  within: boolean | null
}

export interface ElectricalResult {
  /** Set when the network cannot be calculated at all; the rest is then empty. */
  problem: string | null
  battery: {
    partId: string
    name: string
    openCircuit: Calc
    internalResistance: Calc
    current: Calc
    terminal: Calc
    loss: Calc
  } | null
  cables: CableResult[]
  escs: LoadResult[]
  motors: LoadResult[]
  ratings: RatingResult[]
  /** Battery and cable losses together; missing when any of them is. */
  totalLoss: Calc
}

// ---- helpers ------------------------------------------------------------------------------------

const role = (p: WiringPart) => p.component?.category ?? p.kind
const quantity = (c: Component | null, key: string): QuantityValue | null => {
  const s = c?.specs[key]
  return s && typeof s.value === 'number' && 'unit' in s ? (s as QuantityValue) : null
}
const si = (c: Component | null, key: string) => {
  const q = quantity(c, key)
  return q ? toSI(q.value, q.unit) : null
}
const int = (c: Component | null, key: string) => {
  const v = c?.specs[key]?.value
  return typeof v === 'number' ? v : null
}
const key = (e: WireEnd) => `${e.partId}/${e.port}`
const fmt = (n: number, digits = 4) => String(Number(n.toPrecision(digits)))

/** Copper resistivity at a temperature, Ω·m. */
export function copperResistivity(tempC: number): number {
  return COPPER_RESISTIVITY_20C * (1 + COPPER_ALPHA_20C * (tempC - 20))
}

/** Loop resistance of a two-conductor copper cable, Ω: R = ρ(T)·2L/A. */
export function cableResistance(gaugeAwg: number, lengthMm: number, tempC: number): number {
  return (copperResistivity(tempC) * 2 * (lengthMm / 1000)) / toSI(gaugeAwg, 'AWG')
}

/** Sums Calcs; missing as soon as one is. */
function sum(items: Calc[], what: string): Calc {
  let total = 0
  for (const c of items) {
    if (c.value === null) return missing(c.reason)
    total += c.value
  }
  return items.length === 0 ? ok(0, `no ${what}`) : ok(total)
}

// ---- calculation --------------------------------------------------------------------------------

export function calculate(parts: readonly WiringPart[], wires: readonly Wire[], load: LoadCase): ElectricalResult {
  const empty = (problem: string): ElectricalResult => ({
    problem,
    battery: null,
    cables: [],
    escs: [],
    motors: [],
    ratings: [],
    totalLoss: missing(problem),
  })
  const byId = new Map(parts.map((p) => [p.id, p]))
  // Ports built once per part, not once per wire end.
  const ports = new Map(parts.map((p) => [p.id, portsOf(p)]))
  const portKind = (e: WireEnd) => ports.get(e.partId)?.find((x) => x.id === e.port)?.kind
  const powerWires = wires.filter((w) => portKind(w.from) === 'power' && portKind(w.to) === 'power')

  const onPower = new Set(powerWires.flatMap((w) => [w.from.partId, w.to.partId]))
  const batteries = parts.filter((p) => role(p) === 'battery' && onPower.has(p.id))
  if (batteries.length === 0) return empty('No battery is wired, so there is no power network to calculate.')
  if (batteries.length > 1) return empty(`${batteries.length} batteries are wired: series or parallel packs need a current split that is not modelled.`)
  const battery = batteries[0]!

  // Motor currents for the load case.
  const motorCurrent = new Map<string, Calc>()
  const motors = parts.filter((p) => role(p) === 'motor')
  for (const m of motors) {
    if (load.mode === 'fixed') {
      motorCurrent.set(m.id, load.motorCurrentA !== undefined && Number.isFinite(load.motorCurrentA) ? ok(load.motorCurrentA, 'entered') : missing('No motor current entered.'))
    } else {
      const q = quantity(m.component, 'maxCurrent')
      motorCurrent.set(m.id, q ? ok(toSI(q.value, q.unit), q.condition ? `stated: ${q.condition}` : 'stated maximum') : missing(`${m.name}: maximum current not specified.`))
    }
  }

  // ESC load = the motors on its outputs.
  const escCurrent = new Map<string, Calc>()
  const motorsOfEsc = new Map<string, string[]>()
  const at = wireIndex(wires)
  for (const e of parts.filter((p) => role(p) === 'esc')) {
    const ms = (ports.get(e.id) ?? [])
      .filter((p) => p.kind === 'phases')
      .flatMap((p) => at({ partId: e.id, port: p.id }).map((w) => otherEnd(w, { partId: e.id, port: p.id }).partId))
      .filter((id) => motorCurrent.has(id))
    motorsOfEsc.set(e.id, ms)
    escCurrent.set(
      e.id,
      sum(
        ms.map((id) => motorCurrent.get(id)!),
        'motors',
      ),
    )
  }

  // Walk the power tree from the battery. Nodes are ports; a power module joins in ↔ out.
  const adjacency = new Map<string, { to: WireEnd; wire: Wire | null }[]>()
  // Lists are appended in place: copying them per cable made a power module feeding n ESCs O(n²).
  const append = <T,>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k)
    if (list) list.push(v)
    else m.set(k, [v])
  }
  const link = (a: WireEnd, b: WireEnd, wire: Wire | null) => {
    append(adjacency, key(a), { to: b, wire })
    append(adjacency, key(b), { to: a, wire })
  }
  for (const w of powerWires) link(w.from, w.to, w)
  for (const p of parts.filter((x) => role(x) === 'power-module')) link({ partId: p.id, port: 'in' }, { partId: p.id, port: 'out' }, null)

  const root: WireEnd = { partId: battery.id, port: 'power' }
  const order: WireEnd[] = []
  const parent = new Map<string, { from: WireEnd; wire: Wire | null }>()
  const seen = new Set<string>([key(root)])
  const usedWires = new Set<string>()
  // Breadth-first, so cables come out from the battery outwards, in wiring order.
  const queue = [root]
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!
    order.push(node)
    for (const { to, wire } of adjacency.get(key(node)) ?? []) {
      const edgeId = wire?.id ?? `pm:${to.partId}`
      if (usedWires.has(edgeId)) continue
      usedWires.add(edgeId)
      if (seen.has(key(to))) return empty('The power wiring has a loop (two paths to the same port), so the current split cannot be calculated. Remove one of the cables.')
      seen.add(key(to))
      parent.set(key(to), { from: node, wire })
      queue.push(to)
    }
  }

  // Downstream current of each node, in reverse walk order (children first).
  const below = new Map<string, Calc[]>()
  const nodeLoad = (n: WireEnd): Calc => (role(byId.get(n.partId)!) === 'esc' && n.port === 'power' ? (escCurrent.get(n.partId) ?? ok(0)) : ok(0))
  const through = new Map<string, Calc>()
  for (const n of [...order].reverse()) {
    const total = sum([nodeLoad(n), ...(below.get(key(n)) ?? [])], 'loads')
    through.set(key(n), total)
    const up = parent.get(key(n))
    if (up) append(below, key(up.from), total)
  }

  const cables: CableResult[] = []
  const dropTo = new Map<string, Calc>([[key(root), ok(0)]])
  for (const n of order) {
    const up = parent.get(key(n))
    if (!up) continue
    const current = through.get(key(n))!
    const upstream = dropTo.get(key(up.from))!
    if (!up.wire) {
      dropTo.set(key(n), upstream) // power module pass-through
      continue
    }
    const w = up.wire
    const resistance: Calc =
      w.gaugeAwg === null || w.lengthMm === null
        ? missing(`Set the gauge and length of the cable ${describe(byId, up.from)} → ${describe(byId, n)}.`)
        : ok(cableResistance(w.gaugeAwg, w.lengthMm, load.conductorTempC), `ρ(${fmt(load.conductorTempC)} °C)·2·${fmt(w.lengthMm)} mm / A(${fmt(w.gaugeAwg)} AWG)`)
    const drop =
      current.value !== null && resistance.value !== null ? ok(current.value * resistance.value, 'I·R') : missing(current.value === null ? current.reason : (resistance as { reason: string }).reason)
    const loss = current.value !== null && resistance.value !== null ? ok(current.value ** 2 * resistance.value, 'I²·R') : missing(drop.value === null ? drop.reason : '')
    cables.push({
      wireId: w.id,
      from: up.from,
      to: n,
      current,
      resistance,
      drop,
      loss,
    })
    dropTo.set(key(n), upstream.value !== null && drop.value !== null ? ok(upstream.value + drop.value) : missing(upstream.value === null ? upstream.reason : (drop as { reason: string }).reason))
  }

  // Battery.
  const total = through.get(key(root))!
  const series = int(battery.component, 'series')
  let openCircuit: Calc
  if (load.battery === 'full') {
    const cell = si(battery.component, 'cellVoltageMax')
    openCircuit =
      series !== null && cell !== null
        ? ok(series * cell, `${series} × ${fmt(cell)} V (full charge)`)
        : missing(`${battery.name}: ${series === null ? 'cells in series' : 'cell voltage at full charge'} not specified.`)
  } else {
    const pack = si(battery.component, 'packVoltageNominal')
    const cell = si(battery.component, 'cellVoltageNominal')
    openCircuit =
      pack !== null
        ? ok(pack, 'stated nominal pack voltage')
        : series !== null && cell !== null
          ? ok(series * cell, `${series} × ${fmt(cell)} V (nominal)`)
          : missing(`${battery.name}: nominal pack voltage not specified.`)
  }
  const rInt = si(battery.component, 'internalResistance')
  const internalResistance = rInt !== null ? ok(rInt, 'stated') : missing(`${battery.name}: internal resistance not specified, so the sag under load is not known.`)
  const terminal =
    openCircuit.value === null
      ? openCircuit
      : internalResistance.value === null
        ? internalResistance
        : total.value === null
          ? total
          : ok(openCircuit.value - total.value * internalResistance.value, 'V_oc − I·R_int')
  const batteryLoss =
    internalResistance.value !== null && total.value !== null
      ? ok(total.value ** 2 * internalResistance.value, 'I²·R_int')
      : missing(total.value === null ? total.reason : (internalResistance as { reason: string }).reason)

  const voltageAt = (n: WireEnd): Calc => {
    const d = dropTo.get(key(n))
    if (!d) return missing('Not connected to the battery.')
    if (d.value === null) return d
    return terminal.value === null ? terminal : ok(terminal.value - d.value, 'V_terminal − ΔV')
  }

  const escResults: LoadResult[] = parts
    .filter((p) => role(p) === 'esc')
    .map((e) => {
      const n = { partId: e.id, port: 'power' }
      const reached = dropTo.has(key(n))
      return {
        partId: e.id,
        name: e.name,
        current: escCurrent.get(e.id)!,
        drop: reached ? dropTo.get(key(n))! : missing('Not connected to the battery.'),
        voltage: voltageAt(n),
      }
    })
  const escOf = new Map([...motorsOfEsc].flatMap(([esc, ms]) => ms.map((m) => [m, esc] as const)))
  const escResultOf = new Map(escResults.map((x) => [x.partId, x]))
  const motorResults: LoadResult[] = motors.map((m) => {
    const esc = escOf.get(m.id)
    const e = esc ? escResultOf.get(esc) : undefined
    return {
      partId: m.id,
      name: m.name,
      current: motorCurrent.get(m.id)!,
      drop: e ? e.drop : missing(`${m.name} is not on an ESC output.`),
      voltage: e ? e.voltage : missing(`${m.name} is not on an ESC output.`),
    }
  })

  // Ratings for this load case.
  const ratings: RatingResult[] = []
  const rate = (p: WiringPart, what: string, current: Calc, rated: Calc) =>
    ratings.push({
      partId: p.id,
      name: p.name,
      what,
      current,
      rated,
      within: current.value !== null && rated.value !== null ? current.value <= rated.value : null,
    })
  const capacity = si(battery.component, 'capacity')
  const cRate = si(battery.component, 'cRateContinuous')
  rate(
    battery,
    'Continuous discharge',
    total,
    capacity !== null && cRate !== null ? ok(capacity * cRate, 'C rating × capacity') : missing(`${battery.name}: ${capacity === null ? 'capacity' : 'continuous C rating'} not specified.`),
  )
  for (const pm of parts.filter((p) => role(p) === 'power-module')) {
    const n = { partId: pm.id, port: 'in' }
    if (!seen.has(key(n))) continue
    const rated = si(pm.component, 'continuousCurrent')
    rate(pm, 'Continuous current', through.get(key(n))!, rated !== null ? ok(rated, 'stated') : missing(`${pm.name}: continuous current not specified.`))
  }
  for (const e of parts.filter((p) => role(p) === 'esc')) {
    const rated = si(e.component, 'continuousCurrent')
    for (const m of motorsOfEsc.get(e.id) ?? []) {
      rate(e, `Output to ${byId.get(m)!.name}`, motorCurrent.get(m)!, rated !== null ? ok(rated, 'stated, per output') : missing(`${e.name}: continuous current not specified.`))
    }
  }

  return {
    problem: null,
    battery: {
      partId: battery.id,
      name: battery.name,
      openCircuit,
      internalResistance,
      current: total,
      terminal,
      loss: batteryLoss,
    },
    cables,
    escs: escResults,
    motors: motorResults,
    ratings,
    totalLoss: sum([batteryLoss, ...cables.map((c) => c.loss)], 'losses'),
  }
}

function describe(byId: Map<string, WiringPart>, e: WireEnd): string {
  return byId.get(e.partId)?.name ?? 'a removed part'
}
