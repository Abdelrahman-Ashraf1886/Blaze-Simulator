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
    server: { middlewareMode: true, hmr: false },
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
    for (const text of ['Demo telemetry', 'Current build mass', '500.0', 'CoM (body)', 'Ixx / Iyy / Izz', 'Ixy / Ixz / Iyz', 'Total thrust', 'Motor 1', 'Motor 4', 'Shaft torque', 'Arm', 'Reaction', 'Rotor gyro', 'Total', '0.123 / 0.234 / 0.345', 'Linear (world)', 'Angular (body)', 'Pack voltage', 'Pack current', 'Charge used', 'Air density', 'Landing leg', 'Ground', 'Charge cut-off', 'N·m', 'kg·m²', 'deg/s', 'mAh']) expect(html).toContain(text)
    frame.ended = 'voltageCutoff'
    frame.control = null
    expect(render()).toContain('Voltage cut-off')
    expect(render()).toContain('Unavailable')
  } finally {
    await server.close()
  }
})
