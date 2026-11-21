/**
 * Electrical wiring: the ports each part offers, which ports may be joined, the
 * auto-wired reference harness, and the wiring checks. Pure: no React, no three.js.
 *
 * A wire stands for a whole cable: a power lead (+ and −), the three motor phases,
 * an ESC signal (+ ground), or a peripheral's connector cable.
 *
 * Ports come from the part's kind and its linked component:
 * - battery: power out;
 * - power module: power in, power out, and a sense connector (analog → the flight
 *   controller's ADC power port, digital → CAN);
 * - ESC: power in; one motor output and one signal input per channel (4-in-1: 4);
 * - motor: phases;
 * - flight controller: the ports its component lists (names as on the board), plus
 *   "PWM 1…n" outputs (n = stated PWM outputs). Unlinked: a generic set;
 * - peripheral: one connector of the port type its component requires.
 */
import type { Component } from '../../electron/ipc/component-fields'
import type { PartKind, Wire, WireEnd } from '../../electron/ipc/contract'
import type { Finding, RuleId } from './checks'

export type PortKind = 'power' | 'phases' | 'signal' | 'uart' | 'can' | 'i2c' | 'rc' | 'usb' | 'adc'

export interface Port {
  id: string
  label: string
  kind: PortKind
  /** Side of the part's box in the schematic. */
  side: 'left' | 'right'
}

/** Ports that take one cable only. Power, CAN and I²C are shared buses. */
export const POINT_TO_POINT: ReadonlySet<PortKind> = new Set(['phases', 'signal', 'uart', 'rc', 'adc', 'usb'])

export const PORT_KIND_LABELS: Record<PortKind, string> = {
  power: 'Power',
  phases: 'Motor phases',
  signal: 'ESC signal',
  uart: 'UART',
  can: 'CAN',
  i2c: 'I²C',
  rc: 'RC',
  usb: 'USB',
  adc: 'Power sense',
}

export interface WiringPart {
  id: string
  name: string
  kind: PartKind
  component: Component | null
  /** Motor mount number for motors (1…n), used to pair motors with ESC outputs. */
  motorNumber?: number | null
}

const value = (c: Component | null, key: string) => c?.specs[key]?.value

/** Electrical role: the linked component's category wins over the part kind. */
function role(p: WiringPart): string {
  return p.component?.category ?? p.kind
}

export function escChannels(p: WiringPart): number {
  return value(p.component, 'format') === '4-in-1' ? 4 : 1
}

const GENERIC_FC: Port[] = [
  { id: 'Power', label: 'Power', kind: 'adc', side: 'left' },
  { id: 'TELEM', label: 'TELEM', kind: 'uart', side: 'right' },
  { id: 'GPS', label: 'GPS', kind: 'uart', side: 'right' },
  { id: 'RC', label: 'RC', kind: 'rc', side: 'right' },
  { id: 'CAN', label: 'CAN', kind: 'can', side: 'right' },
]

export function portsOf(p: WiringPart): Port[] {
  switch (role(p)) {
    case 'battery':
      return [{ id: 'power', label: 'Power out', kind: 'power', side: 'right' }]
    case 'power-module': {
      const sense = value(p.component, 'sensing')
      const ports: Port[] = [
        { id: 'in', label: 'Power in', kind: 'power', side: 'left' },
        { id: 'out', label: 'Power out', kind: 'power', side: 'right' },
      ]
      if (sense === 'analog') ports.push({ id: 'sense', label: 'Sense (analog)', kind: 'adc', side: 'right' })
      if (sense === 'digital') ports.push({ id: 'sense', label: 'Sense (CAN)', kind: 'can', side: 'right' })
      return ports
    }
    case 'esc': {
      const n = escChannels(p)
      return [
        { id: 'power', label: 'Power in', kind: 'power', side: 'left' },
        ...Array.from({ length: n }, (_, i) => ({ id: `sig${i + 1}`, label: n > 1 ? `Signal ${i + 1}` : 'Signal', kind: 'signal' as const, side: 'left' as const })),
        ...Array.from({ length: n }, (_, i) => ({ id: `out${i + 1}`, label: n > 1 ? `Motor ${i + 1}` : 'Motor', kind: 'phases' as const, side: 'right' as const })),
      ]
    }
    case 'motor':
      return [{ id: 'phases', label: 'Phases', kind: 'phases', side: 'left' }]
    case 'flight-controller': {
      const listed = value(p.component, 'ports')
      const base: Port[] = Array.isArray(listed)
        ? (listed as { name: string; type: PortKind }[]).map((x) => ({ id: x.name, label: x.name, kind: x.type, side: x.type === 'adc' ? 'left' : 'right' }))
        : GENERIC_FC
      const pwm = typeof value(p.component, 'pwmOutputs') === 'number' ? (value(p.component, 'pwmOutputs') as number) : 8
      return [...base, ...Array.from({ length: pwm }, (_, i) => ({ id: `PWM${i + 1}`, label: `PWM ${i + 1}`, kind: 'signal' as const, side: 'right' as const }))]
    }
    case 'peripheral': {
      const kind = value(p.component, 'requiredPort') as PortKind | undefined
      // Right side: peripherals sit left of the flight controller in the default layout.
      return kind ? [{ id: 'data', label: PORT_KIND_LABELS[kind], kind, side: 'right' }] : []
    }
    default:
      return []
  }
}

/** Whether a wire may join two ports: same kind, different parts. */
export function canConnect(a: { part: WiringPart; port: Port }, b: { part: WiringPart; port: Port }): boolean {
  return a.part.id !== b.part.id && a.port.kind === b.port.kind
}

const sameEnd = (a: WireEnd, b: WireEnd) => a.partId === b.partId && a.port === b.port
export const wiresAt = (wires: readonly Wire[], end: WireEnd) => wires.filter((w) => sameEnd(w.from, end) || sameEnd(w.to, end))

/**
 * The wires at each port, built in one pass, so the checks look a port up instead of
 * scanning every wire for every port (O(ports + wires) rather than O(ports × wires)).
 * Same result as wiresAt, in wire order; a wire from a port to itself is listed once.
 */
export function wireIndex(wires: readonly Wire[]): (end: WireEnd) => readonly Wire[] {
  const at = new Map<string, Wire[]>()
  // A port id never contains a newline (ids come from component port names and fixed ids).
  const key = (e: WireEnd) => `${e.partId}\n${e.port}`
  for (const w of wires) {
    for (const k of new Set([key(w.from), key(w.to)])) {
      const list = at.get(k)
      if (list) list.push(w)
      else at.set(k, [w])
    }
  }
  return (end) => at.get(key(end)) ?? []
}

export const otherEnd = (w: Wire, end: WireEnd) => (sameEnd(w.from, end) ? w.to : w.from)

// ---- Auto-wire -----------------------------------------------------------------------------------

const natural = (a: WiringPart, b: WiringPart) => a.name.localeCompare(b.name, undefined, { numeric: true })

/**
 * The reference harness, following PX4's convention (ESC output n drives motor n,
 * flight-controller PWM n drives the ESC input of motor n):
 * - battery → power module → every ESC (or battery → every ESC without a module);
 * - power-module sense → the flight controller's matching power port ("Power1" first);
 * - ESC outputs (ESCs by name, channels in order) → motors by motor-mount number;
 * - PWM n → the signal input of the ESC channel driving motor n;
 * - GPS → "GPS1", telemetry radio → "Telem1", RC receiver → an RC input, other
 *   peripherals → the first free port of their type.
 * Returns the wires and notes on what it could not wire.
 */
export function autoWire(parts: readonly WiringPart[], newId: () => string = () => crypto.randomUUID()): { wires: Wire[]; notes: string[] } {
  const wires: Wire[] = []
  const notes: string[] = []
  const used = new Set<string>()
  const key = (e: WireEnd) => `${e.partId}/${e.port}`
  const connect = (from: WireEnd, to: WireEnd) => {
    wires.push({ id: newId(), from, to, gaugeAwg: null, lengthMm: null, color: null })
    used.add(key(from))
    used.add(key(to))
  }
  const of = (r: string) => parts.filter((p) => role(p) === r).sort(natural)
  const batteries = of('battery')
  const pm = of('power-module')[0]
  const escs = of('esc')
  const fc = of('flight-controller')[0]
  const motors = of('motor').sort((a, b) => (a.motorNumber ?? 99) - (b.motorNumber ?? 99) || natural(a, b))

  // Power
  const battery = batteries[0]
  if (batteries.length > 1) notes.push(`${batteries.length} batteries: series or parallel is your choice, so only ${battery!.name} was wired.`)
  if (battery) {
    let source: WireEnd = { partId: battery.id, port: 'power' }
    if (pm) {
      connect(source, { partId: pm.id, port: 'in' })
      source = { partId: pm.id, port: 'out' }
    }
    for (const e of escs) connect(source, { partId: e.id, port: 'power' })
  } else if (escs.length > 0) {
    notes.push('No battery: ESC power was not wired.')
  }
  const fcPorts = fc ? portsOf(fc) : []
  const freePort = (kind: PortKind, prefer?: RegExp) => {
    const free = fcPorts.filter((p) => p.kind === kind && !used.has(`${fc!.id}/${p.id}`))
    return (prefer && free.find((p) => prefer.test(p.id))) ?? free[0]
  }
  if (fc && pm) {
    const sense = portsOf(pm).find((p) => p.id === 'sense')
    const target = sense && freePort(sense.kind, /power\s*1|^power$/i)
    if (sense && target) connect({ partId: pm.id, port: 'sense' }, { partId: fc.id, port: target.id })
    else notes.push(`${pm.name}: no matching power port on ${fc.name}.`)
  } else if (fc) {
    notes.push(`No power module: wire ${fc.name}'s power yourself.`)
  }

  // Motors and signals
  const outputs = escs.flatMap((e) => Array.from({ length: escChannels(e) }, (_, i) => ({ esc: e, ch: i + 1 })))
  // Motor n uses ESC output n and PWM n (by motor-mount number, so a missing motor leaves a gap).
  let unwired = 0
  motors.forEach((m, i) => {
    const n = m.motorNumber ?? i + 1
    const out = outputs[n - 1]
    if (!out) return void unwired++
    connect({ partId: out.esc.id, port: `out${out.ch}` }, { partId: m.id, port: 'phases' })
    const pwm = fc && freePort('signal', new RegExp(`^PWM${n}$`))
    if (fc && pwm?.id === `PWM${n}`) connect({ partId: fc.id, port: pwm.id }, { partId: out.esc.id, port: `sig${out.ch}` })
  })
  if (unwired > 0 && escs.length > 0) notes.push(`${motors.length} motors but only ${outputs.length} ESC outputs: ${unwired} motor(s) not wired.`)
  if (motors.length > 0 && escs.length === 0) notes.push('No ESC: motors were not wired.')
  if (motors.length > 0 && escs.length > 0 && !fc) notes.push('No flight controller: ESC signals were not wired.')

  // Peripherals
  for (const p of of('peripheral')) {
    const port = portsOf(p)[0]
    if (!port) {
      notes.push(`${p.name}: its component states no connector type.`)
      continue
    }
    if (!fc) {
      notes.push(`${p.name}: no flight controller to connect to.`)
      continue
    }
    const r = value(p.component, 'role')
    const prefer = r === 'gps' ? /gps\s*1|^gps$/i : r === 'telemetry-radio' ? /telem\s*1|^telem$/i : r === 'rc-receiver' ? /sbus|ppm|^rc$/i : undefined
    const target = freePort(port.kind, prefer)
    if (target) connect({ partId: p.id, port: 'data' }, { partId: fc.id, port: target.id })
    else notes.push(`${p.name}: no free ${PORT_KIND_LABELS[port.kind]} port on ${fc.name}.`)
  }
  return { wires, notes }
}

// ---- Wiring checks ------------------------------------------------------------------------------------

const f = (rule: RuleId, severity: Finding['severity'], message: string, partIds: string[], extra = ''): Finding => ({
  id: `${rule}:${[...partIds].sort().join(',')}${extra ? `:${extra}` : ''}`,
  rule,
  severity,
  message,
  partIds,
})

/**
 * - wire-port: a wire ends on a port the part no longer has (e.g. after relinking) — error;
 * - wire-kind: a wire joins ports of different kinds — error;
 * - port-conflict: a point-to-point port carries more than one cable — error;
 * - unwired: once wiring has started, parts left unconnected (battery, power-module
 *   input/output, ESC power, motor phases, used ESC outputs without a signal,
 *   peripherals, flight-controller power) — warning.
 */
export function wiringFindings(parts: readonly WiringPart[], wires: readonly Wire[]): Finding[] {
  const byId = new Map(parts.map((p) => [p.id, p]))
  const ports = new Map(parts.map((p) => [p.id, portsOf(p)]))
  const portOf = (e: WireEnd) => ports.get(e.partId)?.find((x) => x.id === e.port)
  const name = (e: WireEnd) => byId.get(e.partId)?.name ?? 'a removed part'
  const at = wireIndex(wires)
  const out: Finding[] = []

  for (const w of wires) {
    const a = portOf(w.from)
    const b = portOf(w.to)
    for (const [end, port] of [[w.from, a], [w.to, b]] as const) {
      if (!port) out.push(f('wire-port', 'error', `A wire ends on "${end.port}" of ${name(end)}, which that part no longer has. Rewire it or link the part again.`, [end.partId], w.id))
    }
    if (a && b && a.kind !== b.kind) {
      out.push(f('wire-kind', 'error', `A wire joins ${name(w.from)} ${a.label} (${PORT_KIND_LABELS[a.kind]}) to ${name(w.to)} ${b.label} (${PORT_KIND_LABELS[b.kind]}).`, [w.from.partId, w.to.partId], w.id))
    }
  }

  for (const p of parts) {
    for (const port of ports.get(p.id) ?? []) {
      if (!POINT_TO_POINT.has(port.kind)) continue
      const here = at({ partId: p.id, port: port.id })
      if (here.length > 1) {
        const others = here.map((w) => name(otherEnd(w, { partId: p.id, port: port.id })))
        out.push(f('port-conflict', 'error', `${port.label} on ${p.name} has ${here.length} cables (${others.join(', ')}); it takes one.`, [p.id, ...here.map((w) => otherEnd(w, { partId: p.id, port: port.id }).partId)], port.id))
      }
    }
  }

  if (wires.length === 0) return out
  const connected = (p: WiringPart, port: string) => at({ partId: p.id, port }).length > 0
  for (const p of parts) {
    const r = role(p)
    if (r === 'motor' && !connected(p, 'phases')) out.push(f('unwired', 'warning', `${p.name} is not connected to an ESC output.`, [p.id]))
    if (r === 'battery' && !connected(p, 'power')) out.push(f('unwired', 'warning', `${p.name} is not connected.`, [p.id]))
    if (r === 'power-module') {
      if (!connected(p, 'in')) out.push(f('unwired', 'warning', `${p.name} has no power input.`, [p.id], 'in'))
      if (!connected(p, 'out')) out.push(f('unwired', 'warning', `${p.name} powers nothing (its output is not connected).`, [p.id], 'out'))
    }
    if (r === 'esc') {
      if (!connected(p, 'power')) out.push(f('unwired', 'warning', `${p.name} has no power input.`, [p.id], 'power'))
      for (let ch = 1; ch <= escChannels(p); ch++) {
        if (connected(p, `out${ch}`) && !connected(p, `sig${ch}`)) {
          out.push(f('unwired', 'warning', `${p.name} ${escChannels(p) > 1 ? `output ${ch}` : 'output'} drives a motor but has no signal from the flight controller.`, [p.id], `sig${ch}`))
        }
      }
    }
    if (r === 'peripheral' && (ports.get(p.id) ?? []).length > 0 && !connected(p, 'data')) out.push(f('unwired', 'warning', `${p.name} is not connected.`, [p.id]))
    if (r === 'flight-controller') {
      const powerPorts = (ports.get(p.id) ?? []).filter((x) => x.kind === 'adc')
      if (powerPorts.length > 0 && !powerPorts.some((x) => connected(p, x.id))) out.push(f('unwired', 'warning', `${p.name} has no power input wired.`, [p.id], 'power'))
    }
  }
  return out
}

/** Which ESC drives each motor, from the wiring (motor part id → ESC part id). */
export function escOfMotor(parts: readonly WiringPart[], wires: readonly Wire[]): Record<string, string> {
  const out: Record<string, string> = {}
  const at = wireIndex(wires)
  for (const m of parts.filter((p) => role(p) === 'motor')) {
    const w = at({ partId: m.id, port: 'phases' })[0]
    if (w) out[m.id] = otherEnd(w, { partId: m.id, port: 'phases' }).partId
  }
  return out
}
