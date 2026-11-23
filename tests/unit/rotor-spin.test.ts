import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { Quaternion, Vector3 } from 'three'
import type { AssemblyDocument, AssemblyPart } from '../../electron/ipc/contract'
import { buildFrame, type FrameGeometry } from '../../src/three/frame-geometry'
import { worldMatrix } from '../../src/features/workshop/assembly-ops'
import { demoFrame } from '../../src/features/flight/FakeFlightSource'
import type { FlightFrame } from '../../src/features/flight/frame'
import { integrateRotorAngle, ROTOR_BLUR_THRESHOLD_RADPS, ROTOR_TAU, rotorIsBlurred, wrapRotorAngle } from '../../src/features/flight/rotor-spin'

describe('rotor angle integration (radians, seconds)', () => {
  it('integrates actual speed with opposite signs for CW/CCW viewed from above', () => {
    expect(integrateRotorAngle(1, 6, 0.1, 'ccw')).toBeCloseTo(1.6, 12)
    expect(integrateRotorAngle(1, 6, 0.1, 'cw')).toBeCloseTo(0.4, 12)
    expect(integrateRotorAngle(0, 1, Math.PI / 2, 'cw')).toBeCloseTo(3 * Math.PI / 2, 12)
  })
  it('wraps in both directions and through many revolutions', () => {
    for (const angle of [-100 * ROTOR_TAU - 0.3, -ROTOR_TAU, 0, ROTOR_TAU, 100 * ROTOR_TAU + 0.3]) {
      expect(wrapRotorAngle(angle)).toBeGreaterThanOrEqual(0)
      expect(wrapRotorAngle(angle)).toBeLessThan(ROTOR_TAU)
    }
    expect(wrapRotorAngle(-0.3)).toBeCloseTo(ROTOR_TAU - 0.3, 12)
    expect(integrateRotorAngle(0.2, 600, 1 / 60, 'ccw')).toBeCloseTo((0.2 + 10) % ROTOR_TAU, 12)
    expect(integrateRotorAngle(0.2, 600, 1 / 60, 'cw')).toBeCloseTo(wrapRotorAngle(0.2 - 10), 12)
  })
  it('is independent of render partitioning, including variable speed', () => {
    for (const spin of ['cw', 'ccw'] as const) {
      let angle = 0.3
      for (let i = 0; i < 60; i++) angle = integrateRotorAngle(angle, 7, 1 / 60, spin)
      expect(angle).toBeCloseTo(integrateRotorAngle(0.3, 7, 1, spin), 12)
      angle = integrateRotorAngle(angle, 3, 0.2, spin)
      expect(angle).toBeCloseTo(wrapRotorAngle(0.3 + (spin === 'cw' ? -1 : 1) * 7.6), 12)
    }
  })
  it('holds stopped rotors and ignores invalid speeds or elapsed intervals', () => {
    expect(integrateRotorAngle(1, 0, 1, 'ccw')).toBe(1)
    for (const dt of [0, -1, NaN, Infinity]) expect(integrateRotorAngle(1, 10, dt, 'ccw')).toBe(1)
    for (const speed of [NaN, Infinity, -Infinity]) expect(integrateRotorAngle(1, speed, 1, 'ccw')).toBe(1)
  })
})

describe('propeller display sampling', () => {
  it('derives the named threshold from two blades at 60 Hz: 900 rpm', () => {
    expect(ROTOR_BLUR_THRESHOLD_RADPS * 60 / ROTOR_TAU).toBeCloseTo(900, 12)
    expect(rotorIsBlurred(ROTOR_BLUR_THRESHOLD_RADPS - 0.01, 1 / 60, 2)).toBe(false)
    expect(rotorIsBlurred(ROTOR_BLUR_THRESHOLD_RADPS, 1 / 60, 2)).toBe(true)
    expect(rotorIsBlurred(-600, 1 / 60, 2)).toBe(true)
    expect(rotorIsBlurred(600, 1 / 60, 2)).toBe(true)
    expect(rotorIsBlurred(0, 1 / 60, 2)).toBe(false)
  })
  it('switches sooner for slower displays or more blades and recovers on spin-down', () => {
    expect(rotorIsBlurred(60, 1 / 60, 2)).toBe(false)
    expect(rotorIsBlurred(60, 1 / 30, 2)).toBe(true)
    expect(rotorIsBlurred(60, 1 / 60, 4)).toBe(true)
    expect(rotorIsBlurred(600, 1 / 144, 2)).toBe(true)
    expect(rotorIsBlurred(10, 1 / 60, 2)).toBe(false)
  })
})

it('matches props by their motor parent in telemetry order, preserving hub pose, tilt, spin and attachments', async () => {
  // As in flight-view-render.test.ts, use the existing React transform for TSX.
  const server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-rotor-render-test'),
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false },
  })
  try {
    const module = await server.ssrLoadModule('/src/features/flight/FlightViewport.tsx') as {
      flightRotorModels: (doc: AssemblyDocument, geo: FrameGeometry, components: object, assets: object) => {
        rotors: { prop: AssemblyPart; motorIndex: number; spin: string; position: Vector3; orientation: Quaternion; axis: Vector3; discOrientation: Quaternion; radius: number; localDoc: AssemblyDocument; childrenDoc: AssemblyDocument }[]
        stationary: AssemblyDocument
      }
      FlightViewport: ComponentType<{ frame: FlightFrame; doc: AssemblyDocument; geo: FrameGeometry }>
    }
    // Synthetic assembly dimensions and overrides; these are test inputs.
    const part = (id: string, kind: AssemblyPart['kind'], parentId: string | null, mountId: string | null): AssemblyPart => ({
      id, name: 'Repeated name', kind, parentId, mountId, position: [0.01, 0, 0.02], rotation: [0, 0, 0, 1],
      shape: { type: 'cylinder', radius: 0.1, height: 0.01 }, mass: null,
    })
    const doc: AssemblyDocument = {
      frame: { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.1 },
      motors: { 'motor-1': { spin: 'cw', tilt: Math.PI / 6 } },
      parts: [part('prop-3', 'propeller', 'm3', null), part('m3', 'motor', null, 'motor-3'),
        part('child', 'custom', 'prop-1', null), part('prop-1', 'propeller', 'm1', null),
        part('loose', 'propeller', null, null), part('m1', 'motor', null, 'motor-1')],
    }
    const snapshot = JSON.stringify(doc)
    const geo = buildFrame('quad-x', doc.frame, doc.motors)
    const { rotors, stationary } = module.flightRotorModels(doc, geo, {}, {})
    expect(rotors.map((r) => [r.prop.id, r.motorIndex, r.spin])).toEqual([['prop-1', 0, 'cw'], ['prop-3', 2, 'cw']])
    expect(stationary.parts.map((p) => p.id)).toEqual(['m3', 'loose', 'm1'])
    const rotor = rotors[0]!
    expect(rotor.position.distanceTo(new Vector3().setFromMatrixPosition(worldMatrix(doc, geo, 'prop-1')))).toBeLessThan(1e-12)
    const direction = geo.motors[0]!.armDirection
    expect(rotor.axis.x).toBeCloseTo(direction[1] * 0.5, 12)
    expect(rotor.axis.y).toBeCloseTo(-direction[0] * 0.5, 12)
    expect(rotor.axis.z).toBeCloseTo(Math.cos(Math.PI / 6), 12)
    expect(new Vector3(0, 0, 1).applyQuaternion(rotor.discOrientation).distanceTo(rotor.axis)).toBeLessThan(1e-12)
    expect(rotor.radius).toBe(0.1)
    expect(rotor.localDoc.parts.map((p) => p.id)).toEqual(['prop-1'])
    expect(rotor.childrenDoc.parts[0]).toMatchObject({ id: 'child', parentId: null })
    expect(rotor.localDoc.parts[0]).toMatchObject({ parentId: null, mountId: null, position: [0, 0, 0], rotation: [0, 0, 0, 1] })
    expect(JSON.stringify(doc)).toBe(snapshot)
    const html = renderToStaticMarkup(createElement(module.FlightViewport, { frame: demoFrame(0), doc, geo }))
    expect(html).toContain('Propeller motion blur: translucent discs')
    expect(html).toContain('94.2')
    expect(html).toContain('900 rpm')
  } finally {
    await server.close()
  }
})
