import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { expect, it, vi } from 'vitest'
import seed from '../../database/seed/components.v1.json'
import type { Component } from '../../electron/ipc/component-fields'
import type { AssemblyPart, FlightSensorsDoc } from '../../electron/ipc/contract'
import { GYRO_REFERENCE, px4GyroDefaults, sensorSources, type SensorSources } from '../../src/features/flight/sensors/settings'

it('renders off, recorded, and fly-on-gyro settings with provenance and explicit suggestions', async () => {
  const server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-sensor-form-test'),
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  try {
    const { SensorSection } = await server.ssrLoadModule('/src/features/flight/sensors/SensorSection.tsx') as {
      SensorSection: ComponentType<{
        settings?: FlightSensorsDoc; sources: SensorSources; mountOf: () => AssemblyPart['position']; onChange: () => void
      }>
    }
    const pixhawk = (seed.components as unknown as Component[]).find(({ name }) => name === 'Pixhawk 6C')!
    const fc: AssemblyPart = {
      id: 'fc', name: pixhawk.name, kind: 'flight-controller', componentId: pixhawk.id,
      shape: { type: 'box', size: [0.04, 0.03, 0.01] }, position: [0.04, 0, 0.02],
      parentId: null, mountId: null, rotation: [0, 0, 0, 1], mass: null,
    }
    const sources = sensorSources([fc], { [pixhawk.id]: pixhawk })
    const onChange = vi.fn()
    const render = (settings?: FlightSensorsDoc) => renderToStaticMarkup(createElement(SensorSection, {
      settings, sources, mountOf: () => fc.position, onChange,
    }))
    const blank = (html: string, id: string) => expect(html).toMatch(new RegExp(`<input[^>]*id="${id}"[^>]*value=""`))
    const off = render()
    expect(off).toContain('Sensors · Off')
    expect(off).not.toContain('sensor-notice')
    expect(off).not.toContain('flight-sensor-seed')

    const active = { gyro: {}, accelerometer: {}, gps: {}, barometer: {} } as const
    const recorded = render({ ...active, mode: 'recorded' })
    expect(recorded).toContain('Sensors · Recorded only')
    expect(recorded).toContain('Rate loop uses true rates')
    expect(recorded).toContain('value="fc" selected=""')
    expect(recorded).toContain('2.8 mdps/√Hz')
    expect(recorded).toContain('invensense.tdk.com')
    expect(recorded).toContain('Use flight controller position (0.04, 0, 0.02 m)')
    expect(recorded).toContain('EKF2_GPS_DELAY (suggestion) · 110 ms')
    expect(recorded).not.toContain('Use PX4 v1.13.3 defaults')
    for (const id of ['seed', 'gps-delayMs', 'accelerometer-mountPositionM']) blank(recorded, `flight-sensor-${id}`)

    const flying = render({ ...active, mode: 'flyOnGyro' })
    expect(flying).toContain('Sensors · Fly on gyro')
    expect(flying).toContain('Rate loop uses modelled gyro')
    expect(flying).toContain('Noise without vibration looks too good')
    expect(flying).toContain('Use PX4 v1.13.3 defaults')
    for (const [path, ref] of [
      ['gyroCutoffHz', GYRO_REFERENCE.gyroCutoffHz], ['dgyroCutoffHz', GYRO_REFERENCE.dgyroCutoffHz],
      ['notch0-frequencyHz', GYRO_REFERENCE.notch0.frequencyHz], ['notch0-bandwidthHz', GYRO_REFERENCE.notch0.bandwidthHz],
      ['notch1-frequencyHz', GYRO_REFERENCE.notch1.frequencyHz], ['notch1-bandwidthHz', GYRO_REFERENCE.notch1.bandwidthHz],
    ] as const) {
      blank(flying, `flight-sensor-flyOnGyro-${path}`)
      expect(flying).toContain(ref.name)
      expect(flying).toContain(`${ref.min}–${ref.max} Hz`)
    }
    const filled = render({ ...active, mode: 'flyOnGyro', gyroFilters: px4GyroDefaults() })
    expect(filled).toMatch(/id="flight-sensor-flyOnGyro-gyroCutoffHz"[^>]*value="40"/)
    expect(filled).toMatch(/id="flight-sensor-flyOnGyro-notch0-frequencyHz"[^>]*value="0"/)
    expect(onChange).not.toHaveBeenCalled()
  } finally {
    await server.close()
  }
})
