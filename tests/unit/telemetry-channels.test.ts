import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FlightSessionStartResultSchema, FlightSessionStepResultSchema, isEngineResponse,
} from '../../electron/main/engine/protocol'
import { telemetryChannels } from '../../src/domain/telemetry-channels'

const binary = join(__dirname, '../../simulation-engine/target/release', process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine')

function vehicleLoad(motorCount: number) {
  // Adapt the 4.7 fixture (flight-live.test.ts:31-46) into a regular polygon with the same arm length.
  const radius = Math.hypot(0.15, 0.15)
  const motors = Array.from({ length: motorCount }, (_, i) => {
    const angle = 2 * Math.PI * i / motorCount
    return {
      partId: `m${i}`, position: [radius * Math.cos(angle), radius * Math.sin(angle), 0],
      thrustAxis: [0, 0, 1], spin: i % 2 === 0 ? 'cw' : 'ccw',
    }
  })
  const inertia = [0.01, 0.01, 0.02, 0, 0, 0]
  return {
    type: 'vehicle.load',
    vehicle: {
      version: 1, motors, totalMassKg: 1, com: [0, 0, 0], inertia, missingMass: [],
      parts: [{
        partId: 'body', massKg: 1, com: [0, 0, 0], inertia, pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
        shape: { type: 'box', halfExtents: [0.05, 0.05, 0.02] },
      }],
    },
    propulsion: {
      version: 1,
      // Reverse the propulsion order to exercise the mapping by part ID.
      motors: motors.map(({ partId }) => ({
        partId, kvRadPerSV: 100, resistanceOhm: 0.1, noLoadCurrentA: 0.5, thrustCoefNs2: 2e-5,
        torqueCoefNms2: 1e-7, inertiaKgM2: 2e-5, referenceDensityKgM3: 1.225,
      })).reverse(),
      battery: { openCircuitVoltageV: 10, internalResistanceOhm: 0.01, capacityC: 18720 },
    },
  }
}

describe('telemetry channel table against the real engine', () => {
  it.each([[4, false], [6, false], [4, true], [6, true]] as const)(
    'matches both controllers with %i motors and sensors enabled = %s', (count, enabled) => {
    const sensors = enabled ? {
      seed: 0, gyro: null, accelerometer: null, barometer: null,
      gps: { positionSigmaHorizontalM: null, positionSigmaVerticalM: null, velocitySigmaMps: null, periodSteps: 2, delaySteps: null },
    } : undefined
    const start = {
      type: 'flight.session.start', environment: { ground: null, obstacles: [] },
      cutoff: { type: 'chargeMah', value: 1000 }, airDensityKgM3: 1.225, sampleEverySteps: 1, sensors,
    }
    const inputs = [
      vehicleLoad(count),
      start,
      { type: 'flight.session.step', steps: 1, setpoint: {} },
      { ...start, controller: { mode: 'rates' } },
      { type: 'flight.session.step', steps: 1, setpoint: { bodyRadps: [0, 0, 0], collective: 0.5 } },
      { type: 'shutdown' },
    ]
    const child = spawnSync(binary, {
      input: inputs.map((input, id) => JSON.stringify({ ...input, id }) + '\n').join(''),
      encoding: 'utf8',
    })
    if (child.error) throw child.error
    expect(child.status, child.stderr).toBe(0)
    const results = child.stdout.trim().split('\n').map((line, id) => {
      const reply: unknown = JSON.parse(line)
      if (!isEngineResponse(reply) || !reply.ok) throw new Error(line)
      expect(reply.id).toBe(id)
      return reply.result
    })
    expect(results[0]).toMatchObject({ valid: true })
    for (const [kind, id] of [['attitudeHold', 1], ['flightLoop', 3]] as const) {
      const initial = FlightSessionStartResultSchema.parse(results[id])
      const next = FlightSessionStepResultSchema.parse(results[id + 1])
      const table = telemetryChannels(count, kind, enabled)
      if (enabled) {
        const gpsZ = table.findIndex(({ name }) => name === 'sensor.gps.position.z')
        expect(gpsZ).toBeGreaterThanOrEqual(0)
        expect(initial.samples?.rows[0]?.[gpsZ]).toBeNull()
        expect(next.samples?.rows[0]?.[gpsZ]).toBe(next.diagnostic.state.comM[2])
      }
      expect(initial.channels).toEqual(table.map(({ name }) => name))
      expect(new Set(initial.channels).size).toBe(table.length)
      expect(initial.samples?.steps).toEqual([0])
      expect(next.samples?.steps).toEqual([1])
      for (const row of [...initial.samples!.rows, ...next.samples!.rows]) {
        expect(row).toHaveLength(table.length)
        for (const [{ kind, ...channel }, value] of table.map((channel, i) => [channel, row[i]] as const)) {
          if (value === null) continue
          expect(Number.isFinite(value), channel.name).toBe(true)
          if (kind === 'flag') expect([0, 1]).toContain(value)
          if ('values' in channel) expect(channel.values[value!]).toBeDefined()
        }
      }
      const row = initial.samples!.rows[0]!
      expect(FlightSessionStartResultSchema.safeParse({ ...initial, samples: undefined }).success).toBe(false)
      expect(FlightSessionStartResultSchema.safeParse({ ...initial, samples: { steps: [0], rows: [row.slice(1)] } }).success).toBe(false)
      expect(FlightSessionStepResultSchema.safeParse({ ...next, samples: { steps: [1], rows: [[Infinity]] } }).success).toBe(false)
    }
  })
})
