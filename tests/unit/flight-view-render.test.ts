import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { massProperties, type MassProperties } from '../../src/domain/mass'
import { demoFrame } from '../../src/features/flight/FakeFlightSource'
import type { FlightFrame } from '../../src/features/flight/frame'
import type { Indicator } from '../../src/features/flight/indicators'

// The repo's unit runner is Node-only, with no DOM/testing-library setup and no JSX
// in its Node tsconfig. Use the existing Vite React transform for this SSR render test.
it('renders all diagnostic groups, contacts, units and end reasons from a frame', async () => {
  const server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-flight-render-test'),
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': resolve('src') } },
    // No file watcher: see rotor-spin.test.ts (the main checkout's root holds .claude/worktrees).
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  try {
    const module = await server.ssrLoadModule('/src/features/flight/DebugPanel.tsx') as {
      DebugPanel: ComponentType<{ frame: FlightFrame; mass: MassProperties; indicators: Record<string, Indicator> }>
    }
    const frame = demoFrame(10)
    frame.contacts = [{ part: 'Landing leg', object: 'Ground', startS: 9, endS: null }]
    frame.linearVelocityMps = [1, 2, 3]
    frame.armTorqueNm = { x: 0.123, y: 0.234, z: 0.345 }
    const mass = massProperties([{ id: 'payload', name: 'Payload', massKg: 0.5, position: [0.01, 0.02, 0.03], quaternion: [0, 0, 0, 1], model: 'solid', shape: { type: 'box', halfExtents: [0.1, 0.1, 0.1] } }])
    const render = () => renderToStaticMarkup(createElement(module.DebugPanel, { frame, mass, indicators: { Collisions: { state: 'warning', detail: '1 active contact.' } } }))
    const html = render()
    for (const text of ['Demo telemetry', 'Current build mass', '500.0', 'CoM (body)', 'Ixx / Iyy / Izz', 'Ixy / Ixz / Iyz', 'Total thrust', 'Motor 1', 'Motor 4', 'Drag torque (air)', 'Arm', 'Drag reaction', 'Spin-up reaction', 'Rotor gyro', 'Total', '0.123 / 0.234 / 0.345', 'Linear (world)', 'Angular (body)', 'Pack voltage', 'Pack current', 'Charge used', 'Air density', 'Landing leg', 'Ground', 'Charge cut-off', 'N·m', 'kg·m²', 'deg/s', 'mAh']) expect(html).toContain(text)
    frame.ended = 'voltageCutoff'
    frame.control = null
    expect(render()).toContain('Voltage cut-off')
    expect(render()).toContain('Unavailable')

    const { FlightModeStatus } = await server.ssrLoadModule('/src/features/flight/FlightModeStatus.tsx') as {
      FlightModeStatus: ComponentType<{ frame: FlightFrame; linearThrottle: boolean }>
    }
    const renderMode = (linearThrottle: boolean) => renderToStaticMarkup(createElement(FlightModeStatus, { frame, linearThrottle }))
    expect(renderMode(false)).toContain('Awaiting diagnostics')
    frame.flightLoop = {
      mode: 'stabilized',
      requestedMode: 'position',
      positionSetpointM: [null, null, null],
      velocitySetpointMps: [0, null, 1],
      accelerationSetpointMps2: [null, null, 0],
      velocityIntegral: [null, 0, 1],
      hoverThrust: { estimate: 0.5, standardDeviation: 0.1, valid: false },
      saturation: { positive: [false, false, false, false], negative: [false, false, false, false] },
    }
    const loop = render()
    for (const label of ['Position setpoint', 'Velocity setpoint', 'Acceleration setpoint', 'Velocity integral', 'Hover thrust estimate', 'Hover thrust standard deviation', 'Invalid', '0.000 / — / 1.000']) {
      expect(loop).toContain(label)
    }
    expect(renderMode(false)).toContain('Position fell back to Stabilized on ground contact.')
    expect(renderMode(false)).toContain('Centred throttle commands hover thrust with no altitude or position hold.')
    expect(renderMode(true)).toContain('mid-range thrust (linear throttle curve)')
    frame.flightLoop.mode = 'position'
    expect(renderMode(false)).toContain('>Position</span>')
    expect(renderMode(false)).not.toContain('fell back')
  } finally {
    await server.close()
  }
})
