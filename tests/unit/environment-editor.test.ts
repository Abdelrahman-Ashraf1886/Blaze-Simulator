import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createElement, Fragment, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { expect, it, vi } from 'vitest'
import type { Assembly, AssetInfo, DesktopApi, FlightConditionsDoc, ObstacleDoc, SaveAssemblyInput } from '../../electron/ipc/contract'
import { saveAssemblySchema } from '../../electron/ipc/schemas'
import { EMPTY_ENVIRONMENT, simEnvironment } from '../../src/domain/environment'
import { parseAsciiGrid } from '../../src/domain/terrain'
import { createAssemblyStore } from '../../src/features/workshop/assembly-store'
import { hullPoints, newObstacle } from '../../src/features/workshop/environment/obstacles'
import { terrainMeshData } from '../../src/features/workshop/environment/terrain-mesh'
import { selectTerrain } from '../../src/features/workshop/environment/terrain-preview'

const gridResult = parseAsciiGrid([
  'ncols 3', 'nrows 2', 'xllcorner 100', 'yllcorner 200', 'cellsize 2', 'NODATA_VALUE -9999',
  '1 4 9', '2 7 11',
].join('\n'), 'm')
if (!gridResult.ok) throw new Error(gridResult.reason)
const grid = gridResult.grid

it('places northern rows first on sample centres and triangulates SW to NE', () => {
  const { origin, positions, indices } = terrainMeshData(grid)
  expect(origin).toEqual([100, 200, 0])
  expect([...positions]).toEqual([1, 3, 1, 3, 3, 4, 5, 3, 9, 1, 1, 2, 3, 1, 7, 5, 1, 11])
  expect([...indices]).toEqual([3, 1, 0, 3, 4, 1, 4, 2, 1, 4, 5, 2])
})

it('leaves new values empty and preserves terrain coefficients when switching grids', () => {
  expect(newObstacle('c', 0, 'cylinder')).toEqual({
    id: 'c', name: 'Obstacle 1', type: 'cylinder', center: null, yaw: null, radius: null, height: null,
    friction: null, restitution: null,
  })
  expect(newObstacle('h', 1, 'hull')).toMatchObject({ type: 'hull', assetId: null, units: null, upAxis: null })
  expect(newObstacle('b', 2, 'box')).toMatchObject({ center: [1, 0, 0.1], size: [0.4, 0.4, 0.2], yaw: 0 })
  expect(selectTerrain(undefined, 'a')).toEqual({ assetId: 'a', friction: null, restitution: null })
  expect(selectTerrain({ assetId: 'a', friction: 0.6, restitution: 0 }, 'b')).toEqual({ assetId: 'b', friction: 0.6, restitution: 0 })
  expect(selectTerrain({ assetId: 'a', friction: 0.6, restitution: 0 }, null)).toBeNull()
})

it('places the hull preview at the same scale and axes as the collision hull', () => {
  const model: AssetInfo = {
    id: 'asset', filename: 'hull.glb', format: 'glb', bytes: 128, triangles: 4, importedAt: 'now', warnings: [],
    bounds: { min: [10, 20, 30], max: [30, 40, 50] },
    hull: { points: [[10, 20, 30], [30, 20, 30], [10, 40, 30], [10, 20, 50]], reason: null },
  }
  const obstacle = {
    id: 'hull', name: 'Hull', type: 'hull', assetId: model.id, units: 'mm', upAxis: 'y',
    center: [1, 2, 3], yaw: 0, friction: 0, restitution: 0,
  } satisfies ObstacleDoc
  const preview = hullPoints(obstacle, model)
  expect(preview?.[0]).toEqual([-0.01, 0.01, -0.01])
  const result = simEnvironment({ ground: { friction: 0, restitution: 0 }, obstacles: [obstacle] }, { models: { asset: model } })
  expect(result).toMatchObject({ ok: true, environment: { obstacles: [{ points: preview }] } })
})

it('round-trips environment edits through the assembly store and IPC save schema', async () => {
  const projectId = '5d40ad6c-ceaf-4568-ad4e-49a4e1f519f0'
  const gridId = 'a'.repeat(64)
  const obstacle = newObstacle('94e05521-dcc0-4861-9ba0-1ab372261cf2', 0, 'cylinder')
  const legacy: FlightConditionsDoc = { ambientAltitudeM: null, temperatureC: null, cutoffType: 'voltageV', cutoffValue: null }
  let saved: Assembly = {
    projectId, revision: 0, updatedAt: 'now',
    frame: { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.12 },
    motors: {}, parts: [], flight: legacy,
  }
  const save = vi.fn(async (input: SaveAssemblyInput) => {
    const { baseRevision, ...doc } = saveAssemblySchema.parse(JSON.parse(JSON.stringify(input)))
    saved = { ...doc, revision: baseRevision + 1, updatedAt: 'now' }
    return { ok: true as const, data: { revision: saved.revision, updatedAt: saved.updatedAt } }
  })
  const api = { assembly: { load: async () => ({ ok: true, data: saved }), save } } as unknown as DesktopApi
  const store = createAssemblyStore(() => api)
  await store.getState().load(projectId)
  await store.getState().flush()
  expect(save).not.toHaveBeenCalled()
  expect(store.getState().doc).not.toHaveProperty('environment')
  expect(store.getState().doc?.flight).toEqual(legacy)

  const wind = { kind: 'wind', fromDeg: 0, mean: { kind: 'constant', speedMps: 2.5 }, gust: { kind: 'none' } } as const
  store.getState().edit('Set wind', (doc) => ({ ...doc, flight: { ...legacy, wind } }))
  store.getState().edit('Set ground effect', (doc) => ({ ...doc, flight: { ...doc.flight!, groundEffect: false } }))
  store.getState().edit('Select grid and add obstacle', (doc) => ({
    ...doc, environment: { ...EMPTY_ENVIRONMENT, terrain: selectTerrain(undefined, gridId), obstacles: [obstacle] },
  }))
  store.getState().undo()
  expect(store.getState().doc).not.toHaveProperty('environment')
  store.getState().redo()
  const edited = store.getState().doc
  await store.getState().flush()
  const reopened = createAssemblyStore(() => api)
  await reopened.getState().load(projectId)
  expect(reopened.getState().doc).toEqual(edited)
  expect(save).toHaveBeenCalledOnce()
})

it('renders the wind, ground effect, grid and hull controls on the server', async () => {
  const server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-environment-render-test'),
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  try {
    const base = '/src/features/workshop/environment/'
    const { WindSection, GroundEffectSection } = await server.ssrLoadModule(base + 'FlightEnvironmentSections.tsx') as {
      WindSection: ComponentType<{ wind: FlightConditionsDoc['wind']; onChange: () => void }>
      GroundEffectSection: ComponentType<{ value: FlightConditionsDoc['groundEffect']; onChange: () => void }>
    }
    const { TerrainSection } = await server.ssrLoadModule(base + 'TerrainSection.tsx') as {
      TerrainSection: ComponentType<{ selectedId: string; grid: typeof grid; onSelect: () => void }>
    }
    const { ObstacleFields, parseObstacleVector } = await server.ssrLoadModule(base + 'ObstacleFields.tsx') as {
      ObstacleFields: ComponentType<{ id: string; obstacle: ObstacleDoc; parts: []; assets: object; onChange: () => void }>
      parseObstacleVector: (text: string, constraint: { accepts: (value: number) => boolean; message: string }) => { ok: boolean }
    }
    const constraint = { accepts: Number.isFinite, message: 'Enter finite coordinates.' }
    expect(parseObstacleVector('1 -2 0,5', constraint)).toEqual({ ok: true, value: [1, -2, 0.5] })
    expect(parseObstacleVector('1 2', constraint).ok).toBe(false)
    const onChange = vi.fn()
    const hull = newObstacle('h', 0, 'hull')
    if (hull.type !== 'hull') throw new Error('Expected a hull')
    const markup = renderToStaticMarkup(createElement(Fragment, null,
      createElement(WindSection, {
        wind: { kind: 'wind', fromDeg: null, mean: { kind: 'shear', speedAt20FtMps: null, roughness: { kind: 'custom', lengthM: null } },
          gust: { kind: 'discrete', amplitudeMps: null, lengthM: null, startS: null }, turbulence: { kind: 'dryden', seed: null } },
        onChange,
      }),
      createElement(GroundEffectSection, { value: undefined, onChange }),
      createElement(TerrainSection, { selectedId: 'grid', grid, onSelect: onChange }),
      createElement(ObstacleFields, { id: 'obstacle', obstacle: hull, parts: [], assets: {}, onChange }),
    ))
    expect(markup).toContain('clockwise from world +X')
    expect(markup).toContain('body drag only')
    expect(markup).toContain('Category C (terminal phases)')
    expect(markup).toContain('wind-roughness-length')
    expect(markup).toContain('wind-gust-start')
    expect(markup).toContain('wind-turbulence-seed')
    expect(markup).toContain('does not model hovering flight')
    expect(markup).toContain('stops changing at zero airspeed')
    expect(markup).toContain('Required')
    expect(markup).toContain('interaction between rotors is not modelled')
    expect(markup).toContain('<option value="" selected="">Unset</option><option value="true">On</option><option value="false">Off</option>')
    expect(markup).toContain('3 columns × 2 rows · 2 m cells')
    expect(markup).toContain('Elevation 1 to 11 m')
    expect(markup).toContain('(100, 200)')
    expect(markup).toContain('convex hull is what collides')
    expect(onChange).not.toHaveBeenCalled()
  } finally {
    await server.close()
  }
})
