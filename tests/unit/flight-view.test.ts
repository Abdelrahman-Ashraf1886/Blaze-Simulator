import { afterEach, describe, expect, it, vi } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import { hoverBalance, massProperties, STANDARD_GRAVITY, type MotorInput } from '../../src/domain/mass'
import type { Finding } from '../../src/domain/checks'
import { IDEAL_MAP, steadyState, type PropulsionDefinition, type ReadyItem } from '../../src/domain/propulsion'
import type { MassState } from '../../src/features/workshop/mass-input'
import { demoFrame, FakeFlightSource } from '../../src/features/flight/FakeFlightSource'
import { frameToPose, type FlightFrame } from '../../src/features/flight/frame'
import { mapSticks, MAX_TILT_RAD, MAX_VERTICAL_SPEED_MPS, MAX_YAW_RATE_RADPS, updateHeadingHold } from '../../src/features/flight/sticks'
import { airDensityFor } from '../../src/features/flight/readiness'
import { collisionIndicator, instabilityIndicator, layoutIndicator, massIndicator, thrustIndicator, type Indicator } from '../../src/features/flight/indicators'

const motors: MotorInput[] = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([x, y], i) => ({
  partId: `motor-${i}`, name: `Motor ${i}`, position: [x!, y!, 0], thrustAxis: [0, 0, 1], spin: i % 2 ? 'cw' : 'ccw',
}))
function mass(x = 0, missing = false): MassState {
  const mp = massProperties([{ id: 'payload', name: 'Payload', massKg: missing ? null : 1, model: 'solid', position: [x, 0, 0], quaternion: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.1, 0.1, 0.1] } }])
  return { mp, motors, hover: mp.com ? hoverBalance(motors, mp.com, mp.totalMassKg) : null }
}
const sticks = (...keys: string[]) => mapSticks(new Set(keys))
function saturated(timeS: number, negative = false): FlightFrame {
  const f = demoFrame(timeS)
  f.control!.saturation = { positive: [!negative, false, false, false], negative: [false, negative, false, false] }
  return f
}
const sustained = (start: number, end: number) => Array.from({ length: Math.round((end - start) * 20) + 1 }, (_, i) => saturated(start + i / 20, i % 2 === 0))

describe('keyboard stick mapping in body axes', () => {
  it('captures heading at start, follows yaw rate input, then holds the release heading through drift', () => {
    const idle = new Set<string>()
    const left = new Set(['KeyA'])
    const start = updateHeadingHold(null, idle, 0.4)
    expect(updateHeadingHold(start, idle, 0.6).headingRad).toBe(0.4)
    const turning = updateHeadingHold(start, left, 0.8)
    expect(turning.headingRad).toBe(0.8)
    const stillTurning = updateHeadingHold(turning, left, 1.1)
    expect(stillTurning.headingRad).toBe(1.1)
    const released = updateHeadingHold(stillTurning, idle, 1.2)
    expect(released.headingRad).toBe(1.2)
    expect(updateHeadingHold(released, idle, 1.5).headingRad).toBe(1.2)
    expect(mapSticks(idle, released.headingRad)).toEqual(mapSticks(idle, 1.2))
    expect(updateHeadingHold(released, new Set(['KeyD']), -3).headingRad).toBe(-3)
    expect(updateHeadingHold(turning, new Set(['KeyA', 'KeyD']), 0.9)).toEqual({ headingRad: 0.9, yawActive: false })
    expect(start).toEqual({ headingRad: 0.4, yawActive: false })
  })
  it('centres all released sticks and cancels opposing keys', () => {
    expect(sticks()).toEqual({ attitude: [0, 0, 0, 1], verticalVelocityMps: 0, yawRateRadps: 0 })
    expect(sticks('KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight')).toEqual(sticks())
  })
  it('maps throttle and yaw to velocity/rate with the documented signs', () => {
    expect(sticks('KeyW', 'KeyA')).toMatchObject({ verticalVelocityMps: MAX_VERTICAL_SPEED_MPS, yawRateRadps: MAX_YAW_RATE_RADPS })
    expect(sticks('KeyS', 'KeyD')).toMatchObject({ verticalVelocityMps: -MAX_VERTICAL_SPEED_MPS, yawRateRadps: -MAX_YAW_RATE_RADPS })
  })
  it('tilts forward toward +X and right toward -Y', () => {
    expect(new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...sticks('ArrowUp').attitude)).x).toBeGreaterThan(0)
    expect(new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...sticks('ArrowRight').attitude)).y).toBeLessThan(0)
    expect(sticks('ArrowLeft').attitude[0]).toBeLessThan(0)
    expect(sticks('ArrowDown').attitude[1]).toBeLessThan(0)
  })
  it('keeps every arrow combination inside the 30 degree tilt cone with a unit quaternion', () => {
    const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
    for (let mask = 0; mask < 16; mask++) {
      const q = sticks(...arrows.filter((_, i) => mask & (1 << i))).attitude
      expect(Math.hypot(...q)).toBeCloseTo(1, 12)
      const up = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...q))
      expect(Math.acos(up.z)).toBeLessThanOrEqual(MAX_TILT_RAD + 1e-12)
    }
  })
  it('composes yaw about world +Z without swapping axes', () => {
    const q = mapSticks(new Set(), Math.PI / 2).attitude
    const nose = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...q))
    expect(nose.x).toBeCloseTo(0)
    expect(nose.y).toBeCloseTo(1)
    expect(nose.z).toBe(0)
  })
})

describe('frame to pose boundary', () => {
  it('keeps the body origin distinct from world CoM, Z-up, x/y/z/w', () => {
    const f = demoFrame(0)
    f.positionM = [1, 2, 3]
    f.comM = [4, 5, 6]
    f.quaternion = [0, 0, Math.SQRT1_2, Math.SQRT1_2]
    const pose = frameToPose(f)
    expect(pose.position).toEqual([1, 2, 3])
    expect(pose.comWorld).toEqual([4, 5, 6])
    const forward = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...pose.quaternion))
    expect(forward.x).toBeCloseTo(0)
    expect(forward.y).toBeCloseTo(1)
    expect(forward.z).toBe(0)
    pose.position[0] = 100
    expect(f.positionM[0]).toBe(1)
  })
  it('transforms the demo build CoM once into world coordinates', () => {
    const f = demoFrame(Math.PI, 6, [1, 0, 0])
    const expected = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...f.quaternion)).add(new Vector3(...f.positionM))
    expect(f.comM).toEqual(expected.toArray())
    expect(f.motors).toHaveLength(6)
  })
})

describe('flight indicators', () => {
  it('warns only from the configured hover-share margin; offset in mm is informational', () => {
    expect(massIndicator(mass(0), 10).state).toBe('ok')
    expect(massIndicator(mass(0.03), 100).state).toBe('ok')
    expect(massIndicator(mass(0.03), 100).detail).toContain('30.0 mm.')
    expect(massIndicator(mass(0.03), 0).state).toBe('warning')
    expect(massIndicator(mass(0.01), 0).state).toBe('warning')
    expect(massIndicator(mass(0.01), 10).state).toBe('ok')
    expect(massIndicator(mass(0, true), 10).state).toBe('unknown')
  })
  it('uses motor count and prop handedness findings plus hover support feasibility', () => {
    expect(layoutIndicator([], mass(), 4).state).toBe('ok')
    expect(layoutIndicator([], mass(), 0).state).toBe('warning')
    const finding: Finding = { id: 'count', rule: 'motor-count', severity: 'warning', message: 'Missing motor', partIds: [] }
    expect(layoutIndicator([finding], mass(), 3).state).toBe('warning')
    expect(layoutIndicator([{ ...finding, rule: 'prop-hand' }], mass(), 4).state).toBe('warning')
    expect(layoutIndicator([{ ...finding, rule: 'prop-hand', severity: 'cannot-check' }], mass(), 4).state).toBe('unknown')
    expect(layoutIndicator([], mass(2), 4).state).toBe('warning')
    expect(layoutIndicator([], mass(0, true), 4).state).toBe('unknown')
  })
  it('counts only contacts active at the sample time (end is exclusive)', () => {
    const f = demoFrame(2)
    f.contacts = [{ part: 'leg', object: 'ground', startS: 2, endS: null }]
    expect(collisionIndicator(f).state).toBe('warning')
    f.contacts[0]!.endS = 2
    expect(collisionIndicator(f).state).toBe('ok')
    f.contacts[0]!.startS = 3
    f.contacts[0]!.endS = null
    expect(collisionIndicator(f).state).toBe('ok')
  })
  // Synthetic stated coefficients; the equal-motor case has an independent
  // closed-form reference: each motor sees N times the pack resistance.
  const propulsion: PropulsionDefinition = {
    version: 1,
    motors: Array.from({ length: 4 }, (_, i) => ({ partId: `m${i}`, kvRadPerSV: 50, resistanceOhm: 0.2, noLoadCurrentA: 0.1, thrustCoefNs2: 1e-4, torqueCoefNms2: 1e-5, inertiaKgM2: 1e-4, referenceDensityKgM3: 1.225, throttleMap: [[1, 0.8]] })),
    battery: { openCircuitVoltageV: 12, internalResistanceOhm: 0.05, capacityC: 1000 },
  }
  const reference = steadyState({ kv: 50, kt: 0.02, resistance: 0.2, noLoadCurrent: 0.1, noLoadCondition: null }, 1e-5, 12, 1, 4 * 0.05, { ...IDEAL_MAP, points: [{ throttle: 1, effectiveDuty: 0.8 }] })
  const supportedMass = 4 * 1e-4 * reference.omega ** 2 / STANDARD_GRAVITY
  it('uses full-throttle capability above/below the physical hover floor with shared sag and throttle maps', () => {
    expect(thrustIndicator(propulsion, [], supportedMass / 1.1, true, 1.225)).toMatchObject({ state: 'ok', detail: expect.stringContaining('Maximum T/W 1.10') })
    expect(thrustIndicator(propulsion, [], supportedMass / 0.9, true, 1.225)).toMatchObject({ state: 'warning', detail: expect.stringContaining('Maximum T/W 0.90') })
    expect(thrustIndicator(propulsion, [], supportedMass / 1.1, true, 1.225).detail).toContain('physical hover floor 1.0')
    const highSag = { ...propulsion, battery: { ...propulsion.battery, internalResistanceOhm: 0.5 } }
    expect(thrustIndicator(highSag, [], supportedMass / 1.1, true, 1.225).state).toBe('warning')
  })
  it('uses the coefficients the engine flies: at 3000 m, k_T and k_Q scale by the density ratio and the steady solver finds the new speed', () => {
    const rho0 = 1.225 // the motors' reference density in this fixture
    const rho3 = airDensityFor(3000, null) // ISA at 3000 m
    const ratio = rho3 / rho0
    const massKg = supportedMass
    const at = (rho: number) => thrustIndicator(propulsion, [], massKg, true, rho)
    const tw = (d: Indicator) => Number(/Maximum T\/W (\d+\.\d+)/.exec(d.detail)![1])
    expect(tw(at(rho0))).toBeCloseTo(1.0, 2) // sea level: the unscaled capability
    // Independent: the same pack with both coefficients scaled by r, solved with the steady-state solver.
    const scaled = steadyState({ kv: 50, kt: 0.02, resistance: 0.2, noLoadCurrent: 0.1, noLoadCondition: null }, 1e-5 * ratio, 12, 1, 4 * 0.05, { ...IDEAL_MAP, points: [{ throttle: 1, effectiveDuty: 0.8 }] })
    const expected = (4 * 1e-4 * ratio * scaled.omega ** 2) / (massKg * STANDARD_GRAVITY)
    expect(tw(at(rho3))).toBeCloseTo(expected, 2)
    // Thin air costs thrust, but less than the density ratio: the rotors spin faster (the torque load fell too).
    expect(scaled.omega).toBeGreaterThan(reference.omega)
    expect(tw(at(rho3))).toBeLessThan(0.95) // ≈ 0.92 here: well under sea level's 1.0
    expect(tw(at(rho3))).toBeGreaterThan(ratio)
    expect(at(rho3).detail).toContain(`air density ${rho3.toFixed(3)} kg/m³`)
  })
  it('scales each motor by its own reference density', () => {
    // Motors whose data was taken at 0.9 kg/m³ lose nothing at 0.9 kg/m³, whatever the others were taken at.
    const own = structuredClone(propulsion)
    for (const m of own.motors) m.referenceDensityKgM3 = 0.9
    const tw = (d: Indicator) => Number(/Maximum T\/W (\d+\.\d+)/.exec(d.detail)![1])
    expect(tw(thrustIndicator(own, [], supportedMass, true, 0.9))).toBeCloseTo(tw(thrustIndicator(propulsion, [], supportedMass, true, 1.225)), 6)
    const mixed = structuredClone(own)
    mixed.motors[0]!.referenceDensityKgM3 = 1.225
    expect(tw(thrustIndicator(mixed, [], supportedMass, true, 0.9))).toBeLessThan(tw(thrustIndicator(own, [], supportedMass, true, 0.9)))
  })
  it('is unknown, saying why, when the flight air density is not entered', () => {
    const d = thrustIndicator(propulsion, [], supportedMass, true, null)
    expect(d.state).toBe('unknown')
    expect(d.detail).toContain('ambient altitude')
    expect(d.detail).toContain('propeller data')
  })
  it('sums unlike motors at one shared pack voltage', () => {
    const mixed = structuredClone(propulsion)
    mixed.motors[0]!.kvRadPerSV = 70
    mixed.motors[1]!.throttleMap = [[1, 0.6]]
    const terminalV = 8
    const states = mixed.motors.map((m) => steadyState({ kv: m.kvRadPerSV, kt: 1 / m.kvRadPerSV, resistance: m.resistanceOhm, noLoadCurrent: m.noLoadCurrentA, noLoadCondition: null }, m.torqueCoefNms2, terminalV, 1, 0, { ...IDEAL_MAP, points: m.throttleMap!.map(([throttle, effectiveDuty]) => ({ throttle, effectiveDuty })) }))
    mixed.battery.openCircuitVoltageV = terminalV + mixed.battery.internalResistanceOhm * states.reduce((sum, s) => sum + s.supplyCurrent, 0)
    const thrustN = states.reduce((sum, s, i) => sum + mixed.motors[i]!.thrustCoefNs2 * s.omega ** 2, 0)
    expect(thrustIndicator(mixed, [], thrustN / STANDARD_GRAVITY / 1.2, true, 1.225).detail).toContain('Maximum T/W 1.20')
  })
  it('reports incomplete propulsion as unknown with the checklist reason, and requires complete mass', () => {
    const missing: ReadyItem = { id: 'component:pack:internalResistance', label: 'Battery internal resistance', detail: 'Enter measured pack resistance.', link: { to: 'component', componentId: 'pack', field: 'internalResistance' } }
    expect(thrustIndicator(propulsion, [missing], 1, true, 1.225)).toEqual({ state: 'unknown', detail: 'Battery internal resistance: Enter measured pack resistance.' })
    expect(thrustIndicator(null, [], 1, true, 1.225).state).toBe('unknown')
    expect(thrustIndicator(propulsion, [], 1, false, 1.225).state).toBe('unknown')
    expect(thrustIndicator(propulsion, [], 0, true, 1.225).state).toBe('unknown')
    const unrelated: ReadyItem[] = [
      { id: 'body-cd', label: 'Drag', detail: 'Missing', link: { to: 'body-drag', axis: 'x' } },
      { id: 'ground-friction', label: 'Friction', detail: 'Missing', link: { to: 'environment', elementId: 'ground-friction' } },
    ]
    expect(thrustIndicator(propulsion, unrelated, supportedMass / 1.1, true, 1.225).state).toBe('ok')
  })
  it('requires at least one second of contiguous saturation, including negative axes', () => {
    expect(instabilityIndicator(sustained(0, 0.95)).state).toBe('ok')
    expect(instabilityIndicator(sustained(0, 1)).state).toBe('warning')
    expect(instabilityIndicator([...sustained(0, 1), demoFrame(1.05)]).state).toBe('ok')
    expect(instabilityIndicator([saturated(0), saturated(1)]).state).toBe('ok')
    expect(instabilityIndicator([...sustained(0, 1), saturated(0)]).state).toBe('ok')
    expect(instabilityIndicator([...sustained(0, 1), { ...saturated(1.05), control: null }]).state).toBe('unknown')
    expect(instabilityIndicator([]).state).toBe('unknown')
  })
})

describe('deterministic fake flight source lifecycle', () => {
  afterEach(() => vi.useRealTimers())
  it('publishes ordered fixed steps, asks for setpoints, and stops at charge cutoff', () => {
    vi.useFakeTimers()
    const source = new FakeFlightSource()
    const frames: FlightFrame[] = []
    const provider = vi.fn(() => sticks('KeyW'))
    source.subscribe((f) => frames.push(f))
    source.start(provider)
    expect(frames.map((f) => f.timeS)).toEqual([0])
    vi.advanceTimersByTime(10_000)
    expect(frames).toHaveLength(201)
    expect(frames.at(-1)!.ended).toBe('chargeCutoff')
    expect(provider).toHaveBeenCalledTimes(201)
    vi.advanceTimersByTime(1000)
    expect(frames).toHaveLength(201)
    source.start(provider)
    expect(frames.at(-1)).toEqual(frames[0])
    source.stop()
  })
  it('stops, restarts and unsubscribes without leaking timers or mutating scripts', () => {
    vi.useFakeTimers()
    const script = [demoFrame(0), { ...demoFrame(0.05), ended: 'voltageCutoff' as const }]
    const source = new FakeFlightSource(script)
    const listener = vi.fn((f: FlightFrame) => { f.positionM[0] = 99 })
    const unsubscribe = source.subscribe(listener)
    source.start(() => sticks())
    source.stop(); source.stop()
    vi.advanceTimersByTime(500)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(script[0]!.positionM[0]).toBe(0)
    source.start(() => sticks())
    vi.advanceTimersByTime(50)
    expect(listener.mock.calls.at(-1)![0].ended).toBe('voltageCutoff')
    expect(vi.getTimerCount()).toBe(0)
    unsubscribe()
    source.start(() => sticks())
    vi.advanceTimersByTime(200)
    expect(listener).toHaveBeenCalledTimes(3)
    source.stop()
  })
  it('handles null controls and contact history without changing the boundary data', () => {
    vi.useFakeTimers()
    const f = { ...demoFrame(0), control: null, contacts: [{ part: 'leg', object: 'box', startS: 0, endS: null }] }
    const source = new FakeFlightSource([f])
    const listener = vi.fn()
    source.subscribe(listener)
    source.start(() => sticks())
    expect(listener).toHaveBeenCalledWith(f)
    expect(vi.getTimerCount()).toBe(0)
    new FakeFlightSource([]).start(() => sticks())
    expect(vi.getTimerCount()).toBe(0)
  })
  it('honours stop called reentrantly by a subscriber or setpoint provider', () => {
    vi.useFakeTimers()
    const source = new FakeFlightSource()
    const second = vi.fn()
    const unsubscribe = source.subscribe(() => source.stop())
    source.subscribe(second)
    source.start(() => sticks())
    expect(second).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    unsubscribe()
    source.start(() => { source.stop(); return sticks() })
    expect(second).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
