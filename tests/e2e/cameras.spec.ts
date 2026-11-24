import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopApi, FlightStartInput, FlightStepInput } from '../../electron/ipc/contract'
import { createProject, launchApp } from './helpers'

// The existing 4.7 test quad and session settings (tests/unit/flight-live.test.ts:21–38,200–208).
const arm = 0.15
const mount = (partId: string, x: number, y: number, spin: 'cw' | 'ccw') => ({
  partId, position: [x, y, 0], thrustAxis: [0, 0, 1], spin,
})
const inertia = [0.01, 0.01, 0.02, 0, 0, 0]
const start: FlightStartInput = {
  vehicle: {
    version: 1,
    parts: [{ partId: 'body', massKg: 1, com: [0, 0, 0], inertia, pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, shape: { type: 'box', halfExtents: [0.05, 0.05, 0.02] } }],
    motors: [mount('m1', arm, -arm, 'ccw'), mount('m2', -arm, arm, 'ccw'), mount('m3', arm, arm, 'cw'), mount('m4', -arm, -arm, 'cw')],
    totalMassKg: 1, com: [0, 0, 0], inertia, missingMass: [],
  },
  propulsion: {
    version: 1,
    motors: ['m1', 'm2', 'm3', 'm4'].map((partId) => ({ partId, kvRadPerSV: 100, resistanceOhm: 0.1, noLoadCurrentA: 0.5, thrustCoefNs2: 2e-5, torqueCoefNms2: 1e-7, inertiaKgM2: 2e-5, referenceDensityKgM3: 1.225 })),
    battery: { openCircuitVoltageV: 10, internalResistanceOhm: 0.01, capacityC: 18720 },
  },
  aero: { cdBody: [1, 1, 1], areaM2: [0.01, 0.01, 0.01] },
  environment: { ground: { friction: 0.5, restitution: 0 }, obstacles: [] },
  airDensityKgM3: 1.225, cutoff: { type: 'chargeMah', value: 1000 }, startPositionM: [0, 0, 0.02],
}

test('switches views during an engine session, preserves its frames, and links a missing FPV field', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'blaze-camera-'))
  const { app, page } = await launchApp(userData)
  try {
    // Connection timeout follows tests/e2e/app.spec.ts:49.
    await expect(page.getByTestId('status-bar').getByTestId('engine-state')).toHaveAttribute('data-state', 'connected', { timeout: 15_000 })
    const name = 'Camera views'
    await createProject(page, name)
    const projectId = await page.evaluate(async (projectName) => {
      const api = (window as unknown as { api: DesktopApi }).api
      const projects = await api.projects.list()
      if (!projects.ok) throw new Error(projects.error.message)
      const project = projects.data.find((entry) => entry.name === projectName)!
      const loaded = await api.assembly.load(project.id)
      if (!loaded.ok) throw new Error(loaded.error.message)
      const { revision, frame, motors } = loaded.data
      const camera = { id: crypto.randomUUID(), kind: 'camera' as const, shape: { type: 'box' as const, size: [0.05, 0.05, 0.02] as [number, number, number] },
        parentId: null, mountId: null, position: [0, 0, 0.02] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], mass: null }
      const saved = await api.assembly.save({ projectId: project.id, baseRevision: revision, frame, motors,
        parts: [{ ...camera, name: 'Lens missing' }, { ...camera, id: crypto.randomUUID(), name: 'Ready lens', cameraFovDeg: 72 }] })
      if (!saved.ok) throw new Error(saved.error.message)
      location.hash = `#/flight/${project.id}`
      return project.id
    }, name)
    const view = page.getByRole('combobox', { name: 'Camera view' })
    const part = page.getByRole('combobox', { name: 'FPV camera part' })
    await expect(view).toHaveValue('Follow')
    await part.selectOption({ label: 'Lens missing' })
    await expect(view.getByRole('option', { name: 'FPV (unavailable)' })).toBeDisabled()
    await page.getByRole('link', { name: 'Set vertical FOV on Lens missing' }).click()
    await expect(page.getByTestId('part-camera-fov')).toHaveValue('')
    await page.evaluate((id) => { location.hash = `#/flight/${id}` }, projectId)
    await part.selectOption({ label: 'Ready lens' })
    // Same input and chunk size as tests/unit/flight-live.test.ts:565,576–579.
    const step: FlightStepInput = { steps: 25, setpoint: { attitude: [0, 0, 0, 1], yawRateRadps: 0, climbRateMps: 0 } }
    async function replay(mode: string) {
      const started = await page.evaluate((input) => (window as unknown as { api: DesktopApi }).api.engine.flightStart(input), start)
      expect(started.ok).toBe(true)
      try {
        await view.selectOption(mode)
        await expect(page.getByTestId('flight-viewport')).toHaveAttribute('data-camera', mode)
        const frames = []
        for (let index = 0; index < 4; index++) {
          const frame = await page.evaluate((input) => (window as unknown as { api: DesktopApi }).api.engine.flightStep(input), step)
          if (!frame.ok) throw new Error(frame.error.message)
          frames.push(frame.data)
        }
        return frames
      } finally {
        const ended = await page.evaluate(() => (window as unknown as { api: DesktopApi }).api.engine.flightEnd())
        expect(ended.ok).toBe(true)
      }
    }
    const baseline = await replay('Follow')
    for (const mode of ['Chase', 'Orbit', 'Fixed', 'FPV']) expect(await replay(mode)).toEqual(baseline)
    await view.selectOption('Chase')
    const fov = page.getByTestId('flight-camera-fovDeg')
    await fov.fill('72')
    await fov.press('Enter')
    await page.reload()
    await expect(view).toHaveValue('Follow')
    await view.selectOption('Chase')
    await expect(fov).toHaveValue('72')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
