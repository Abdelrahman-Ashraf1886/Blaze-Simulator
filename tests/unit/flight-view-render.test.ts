import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { massProperties, type MassProperties } from '../../src/domain/mass'
import { demoFrame } from '../../src/features/flight/FakeFlightSource'
import { windArrow, type FlightFrame } from '../../src/features/flight/frame'
import type { Indicator } from '../../src/features/flight/indicators'

// The repo's unit runner is Node-only, with no DOM/testing-library setup and no JSX
// in its Node tsconfig. Use the existing Vite React transform for this SSR render test.
it('renders all diagnostic groups, contacts, units and end reasons from a frame', async () => {
  const server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-flight-render-test'),
    plugins: [
      react(),
      {
        name: 'flight-test-router',
        resolveId: (id) => id === 'virtual:flight-test-router' ? '\0virtual:flight-test-router' : undefined,
        load: (id) => id === '\0virtual:flight-test-router' ? 'export { MemoryRouter } from "react-router"' : undefined,
      },
    ],
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
      FlightModeStatus: ComponentType<{ frame: FlightFrame }>
    }
    const renderMode = () => renderToStaticMarkup(createElement(FlightModeStatus, { frame }))
    expect(renderMode()).toContain('Awaiting diagnostics')
    frame.flightLoop = {
      mode: 'stabilized',
      requestedMode: 'position',
      takeoffState: 'rampUp',
      autoMode: 'hold',
      commandFinished: true,
      landState: { freefall: false, groundContact: true, maybeLanded: true, landed: false },
      positionSetpointM: [null, null, null],
      velocitySetpointMps: [0, null, 1],
      accelerationSetpointMps2: [null, null, 0],
      velocityIntegral: [null, 0, 1],
      hoverThrust: { estimate: 0.5, standardDeviation: 0.1, valid: false },
      saturation: { positive: [false, false, false, false], negative: [false, false, false, false] },
    }
    expect(renderMode()).toContain('Finished')
    expect(renderMode()).toContain('Ramping up')
    expect(renderMode()).toContain('Landed no')

    const controls = await server.ssrLoadModule('/src/features/flight/FlightControls.tsx') as {
      FlightInputSelector: ComponentType<typeof selectorProps>
      FlightPauseControls: ComponentType<typeof pauseProps>
      FlightCommandControls: ComponentType<typeof commandProps>
    }
    const { MemoryRouter } = await server.ssrLoadModule('virtual:flight-test-router') as typeof import('react-router')
    const pad = { id: 'Test pad', index: 0, connection: 0, calibrated: false }
    const selectorProps = {
      options: [pad], selected: pad, locked: false, mode: 'attitudeHold', onChange: () => {},
    }
    const selector = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(controls.FlightInputSelector, selectorProps)))
    for (const text of ['Keyboard', 'Needs calibration', 'href="/input"', 'Attitude hold uses keyboard only']) {
      expect(selector).toContain(text)
    }
    const pauseProps = {
      paused: 'blur', blocker: 'disconnect', device: true, sticks: null, onToggle: () => {},
    }
    const pause = renderToStaticMarkup(createElement(controls.FlightPauseControls, pauseProps))
    for (const text of ['Resume', 'disabled', 'Input device disconnected', 'Live sticks unavailable']) expect(pause).toContain(text)
    const commandProps = {
      command: { type: 'land' }, height: '', paused: false, onHeight: () => {}, onCommand: () => {},
    }
    const commands = renderToStaticMarkup(createElement(controls.FlightCommandControls, commandProps))
    for (const text of ['MIS_TAKEOFF_ALT (2.5 m)', 'm above start', '>Takeoff<', '>Hold<', '>Land<', '>Manual<']) {
      expect(commands).toContain(text)
    }
    const loop = render()
    for (const label of ['Position setpoint', 'Velocity setpoint', 'Acceleration setpoint', 'Velocity integral', 'Hover thrust estimate', 'Hover thrust standard deviation', 'Invalid', '0.000 / — / 1.000']) {
      expect(loop).toContain(label)
    }
    for (const label of ['Ramping up', 'Freefall no', 'Ground contact yes', 'Maybe landed yes', 'Landed no']) {
      expect(renderMode()).toContain(label)
    }
    frame.flightLoop.mode = 'position'
    expect(renderMode()).toContain('>Position</span>')
    expect(renderMode()).not.toContain('fell back')

    frame.environmentLoads = {
      windComWorldMps: [-3, 4, 0], groundEffectAddedThrustN: 0.25,
      windAboveRange: true, windInvalid: true,
      groundEffectStatus: [
        { type: 'applied', belowTestedRange: true }, { type: 'inactive' },
        { type: 'invalidInput', reason: 'hubHeight' }, { type: 'invalidWind' }, { type: 'nonFiniteThrust' },
      ],
    }
    const loads = render()
    for (const text of [
      'Wind at CoM', '-3.000 / 4.000 / 0.000', 'Ground-effect added thrust', '0.250',
      '1 applied / 1 inactive / 1 invalid inputs / 1 invalid wind / 1 non-finite thrust',
      'held wind at the top of the profile', 'A wind calculation failed', 'skipped ground-effect thrust', 'below the tested height range on 1 motor',
    ]) expect(loads).toContain(text)
    frame.environmentLoads = { ...frame.environmentLoads, windAboveRange: false, windInvalid: false, groundEffectStatus: [] }
    expect(render()).not.toContain('skipped ground-effect thrust')

    const { FlightEnvironmentSummary } = await server.ssrLoadModule('/src/features/flight/FlightSetup.tsx') as {
      FlightEnvironmentSummary: ComponentType<{
        environment: Pick<import('../../src/features/flight/readiness').EnginePayload, 'environment' | 'wind' | 'groundEffect'>
        terrainId?: string
      }>
    }
    const summary = (props: React.ComponentProps<typeof FlightEnvironmentSummary>) =>
      renderToStaticMarkup(createElement(FlightEnvironmentSummary, props))
    expect(summary({ environment: { environment: { ground: { friction: 0, restitution: 0 }, obstacles: [] } } })).toContain('Ground plane · Wind off · Ground effect off')
    expect(summary({ environment: { environment: { ground: null, obstacles: [] } } })).toContain('Free space')
    expect(summary({ terrainId: 'slope.asc', environment: {
      environment: {
        ground: null, obstacles: [],
        terrain: { rows: 2, columns: 2, cellSizeM: 1, heightsM: [2, 3, 0, 1], cornerM: [-1, -1], friction: 0, restitution: 0 },
      },
      wind: { fromDeg: 90, mean: { kind: 'constant', speedMps: 4 }, gust: null },
      groundEffect: [0.1],
    } })).toContain('Terrain (slope.asc) · Wind on · Ground effect on')
  } finally {
    await server.close()
  }
})

it('uses world XYZ for the wind arrow and hides it at zero speed', () => {
  expect(windArrow([-3, 0, 4])).toEqual({ direction: [-0.6, 0, 0.8], speedMps: 5 })
  expect(windArrow([0, 0, 0])).toBeNull()
})
