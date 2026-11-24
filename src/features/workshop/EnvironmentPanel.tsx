import { Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { MAX_OBSTACLES, type AssemblyDocument, type AssetInfo, type DropTestInput, type DropTestResult, type EnvironmentDoc, type LegacyBoxObstacleDoc, type ObstacleDoc, type SurfaceValues } from '../../../electron/ipc/contract'
import { NumberField, numberParser } from '@/components/number-field'
import { Button } from '@/components/ui/button'
import { lowestPoint } from '@/domain/collisions'
import { EMPTY_ENVIRONMENT } from '@/domain/environment'
import { vehicleDefinition } from '@/domain/mass'
import { getApi } from '@/services/api'
import { useSystem } from '@/stores/system'
import type { FrameGeometry } from '@/three/frame-geometry'
import { useAssembly } from './assembly-store'
import { useAssets } from './asset-store'
import { useComponentIndex } from './component-index'
import { massState } from './mass-input'
import { ChoiceField } from './environment/fields'
import { ObstacleFields } from './environment/ObstacleFields'
import { newObstacle } from './environment/obstacles'
import { TerrainSection } from './environment/TerrainSection'
import { startEnvironment, type StartEnvironment } from './environment/start-environment'
import { selectTerrain, useTerrainGrid } from './environment/terrain-preview'

const edit = (label: string, recipe: (d: AssemblyDocument) => AssemblyDocument) => useAssembly.getState().edit(label, recipe)
const setEnv = (label: string, change: (e: EnvironmentDoc) => EnvironmentDoc) =>
  edit(label, (d) => ({ ...d, environment: change(d.environment ?? EMPTY_ENVIRONMENT) }))

/** Empty text clears the value (not set); otherwise a number in [min, max]. */
const optional = (min: number, max: number) => (text: string) => {
  if (text.trim() === '') return { ok: true as const, value: null }
  return numberParser(min, max, '', 0.001)(text)
}
const show = (v: number | null) => (v === null ? '' : String(v))
const mm = (m: number) => String(Math.round(m * 1e4) / 10)

/**
 * The project's flight environment: the ground's and each obstacle's friction and
 * restitution (the user's entries; no defaults), obstacles, what is still missing, and
 * a drop test that sends all of it to the engine.
 */
export function EnvironmentPanel({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const env = doc.environment ?? EMPTY_ENVIRONMENT
  const assets = useAssets((s) => s.assets)
  const [shape, setShape] = useState<'box' | 'cylinder' | 'hull'>('box')
  const terrainId = env.terrain?.assetId
  const terrain = useTerrainGrid(terrainId)
  const grid = terrain?.grid
  const ready = useMemo(() => startEnvironment(env, assets, terrain), [env, assets, terrain])
  return (
    <div data-testid="environment-panel">
      {!env.terrain && <>
        <h3 className="mb-1 text-[12px] font-medium text-fg-muted">Ground (z = 0)</h3>
        <SurfaceFields id="ground" values={env.ground} onCommit={(key, v) => setEnv(`Set ground ${key}`, (e) => ({ ...e, ground: { ...e.ground, [key]: v } }))} />
      </>}
      <TerrainSection selectedId={terrainId} grid={grid} readError={terrain?.error}
        onSelect={(id) => setEnv(id === null ? 'Remove terrain' : 'Select terrain', (e) => ({ ...e, terrain: selectTerrain(e.terrain, id) }))} />
      {env.terrain && <SurfaceFields id="terrain" values={env.terrain} onCommit={(key, v) =>
        setEnv(`Set terrain ${key}`, (e) => e.terrain ? { ...e, terrain: { ...e.terrain, [key]: v } } : e)} />}
      <h3 className="mb-1 mt-3 text-[12px] font-medium text-fg-muted">Obstacles</h3>
      {env.obstacles.length === 0 && <p className="border-t border-line py-1.5 text-[12px] text-fg-subtle">None.</p>}
      {env.obstacles.map((o, i) => <ObstacleRow key={o.id} o={o} index={i} parts={doc.parts} assets={assets} />)}
      <ChoiceField id="obstacle-shape" label="New obstacle shape" value={shape}
        options={[[ 'box', 'Box'], ['cylinder', 'Vertical cylinder'], ['hull', 'Convex hull']]}
        onChange={(kind) => setShape(kind === 'cylinder' || kind === 'hull' ? kind : 'box')} />
      <Button
        size="sm"
        variant="ghost"
        className="mt-1"
        data-testid="add-obstacle"
        disabled={env.obstacles.length >= MAX_OBSTACLES}
        onClick={() =>
          setEnv('Add obstacle', (e) => e.obstacles.length >= MAX_OBSTACLES ? e : ({
            ...e,
            obstacles: [...e.obstacles, newObstacle(crypto.randomUUID(), e.obstacles.length, shape)],
          }))
        }
      >
        <Plus /> Add obstacle
      </Button>
      <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
        Friction and restitution are the coefficients of the contact between the drone and that surface. No source states
        them, so nothing is assumed: the simulation will not start until each one is entered.
      </p>
      {ready.ok ? (
        <p className="mt-2 text-[12px] text-ok" data-testid="environment-ready">
          Environment complete.
        </p>
      ) : (
        <ul className="mt-2 space-y-0.5 text-[12px] text-warn" data-testid="environment-missing">
          {ready.missing.map((m) => (
            <li key={m.field} data-field={m.field}>
              {m.message}
            </li>
          ))}
        </ul>
      )}
      <DropTest doc={doc} geo={geo} env={ready} />
    </div>
  )
}

function SurfaceFields({ id, values, onCommit }: { id: string; values: { friction: number | null; restitution: number | null }; onCommit: (key: 'friction' | 'restitution', v: number | null) => void }) {
  return (
    <>
      <NumberField
        key={`${id}-friction:${values.friction}`}
        id={`${id}-friction`}
        label="Friction coefficient"
        initial={show(values.friction)}
        placeholder="not set"
        parse={optional(0, 10)}
        onCommit={(v) => onCommit('friction', v)}
      />
      <NumberField
        key={`${id}-restitution:${values.restitution}`}
        id={`${id}-restitution`}
        label="Restitution"
        initial={show(values.restitution)}
        placeholder="not set"
        parse={optional(0, 1)}
        onCommit={(v) => onCommit('restitution', v)}
      />
    </>
  )
}

function ObstacleRow({ o, index, parts, assets }: {
  o: ObstacleDoc
  index: number
  parts: AssemblyDocument['parts']
  assets: Readonly<Record<string, AssetInfo>>
}) {
  const replace = (label: string, next: ObstacleDoc) =>
    setEnv(`${label} of ${o.name}`, (e) => ({ ...e, obstacles: e.obstacles.map((x) => x.id === o.id ? next : x) }))
  const update = (label: string, patch: Partial<SurfaceValues & { name: string }>) => replace(label, { ...o, ...patch })
  const id = `obstacle-${index + 1}`
  return (
    <div className="border-t border-line py-1" data-testid="obstacle">
      <div className="flex items-center justify-between gap-2">
        <input
          aria-label="Obstacle name"
          data-testid={`${id}-name`}
          defaultValue={o.name}
          key={o.name}
          onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== o.name && update('Rename', { name: e.target.value.trim().slice(0, 80) })}
          className="h-7 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-2 text-[12.5px] text-fg"
        />
        <button
          type="button"
          title={`Remove ${o.name}`}
          data-testid={`${id}-remove`}
          onClick={() => setEnv(`Remove ${o.name}`, (e) => ({ ...e, obstacles: e.obstacles.filter((x) => x.id !== o.id) }))}
          className="text-fg-subtle hover:text-fault"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {o.type === undefined
        ? <LegacyBoxFields id={id} o={o} update={(label, patch) => replace(label, { ...o, ...patch })} />
        : <ObstacleFields id={id} obstacle={o} parts={parts} assets={assets} onChange={replace} />}
      <SurfaceFields id={id} values={o} onCommit={(key, v) => update(`Set ${key}`, { [key]: v })} />
    </div>
  )
}

function LegacyBoxFields({ id, o, update }: {
  id: string
  o: LegacyBoxObstacleDoc
  update: (label: string, patch: Partial<LegacyBoxObstacleDoc>) => void
}) {
  const vec = (key: 'center' | 'size', i: number, v: number) => {
    const next = [...o[key]] as [number, number, number]
    next[i] = v / 1000
    update(key === 'center' ? 'Move' : 'Resize', { [key]: next })
  }
  return <>
      {(['X', 'Y', 'Z'] as const).map((axis, i) => (
        <NumberField key={`c${i}:${o.center[i]}`} id={`${id}-center-${axis.toLowerCase()}`} label={`Centre ${axis}`} unit="mm" initial={mm(o.center[i]!)} parse={numberParser(-1e6, 1e6, 'mm')} onCommit={(v) => vec('center', i, v)} />
      ))}
      {(['X', 'Y', 'Z'] as const).map((axis, i) => (
        <NumberField key={`s${i}:${o.size[i]}`} id={`${id}-size-${axis.toLowerCase()}`} label={`Size ${axis}`} unit="mm" initial={mm(o.size[i]!)} parse={numberParser(0.1, 1e6, 'mm')} onCommit={(v) => vec('size', i, v)} />
      ))}
      <NumberField
        key={`yaw:${o.yaw}`}
        id={`${id}-yaw`}
        label="Yaw"
        unit="°"
        initial={String(Math.round(((o.yaw * 180) / Math.PI) * 10) / 10)}
        parse={numberParser(-360, 360, '°')}
        onCommit={(deg) => update('Turn', { yaw: (deg * Math.PI) / 180 })}
      />
  </>
}

/** Release from rest at the given vertical clearance above first ground contact. */
function DropTest({ doc, geo, env }: { doc: AssemblyDocument; geo: FrameGeometry; env: StartEnvironment }) {
  const components = useComponentIndex()
  const assets = useAssets((s) => s.assets)
  const engine = useSystem((s) => s.engine)
  // Test parameters, shown and editable; not physical values.
  const [clearanceM, setClearance] = useState(0.2)
  const [durationS, setDuration] = useState(2)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: true; r: DropTestResult } | { ok: false; message: string } | null>(null)
  const { mp, motors } = massState(doc, geo, components, assets)
  const vehicle = vehicleDefinition(mp, motors)
  const blocked = !env.ok
    ? 'Resolve the environment checklist first.'
    : !vehicle
      ? 'Every part needs a mass first (see Mass).'
      : engine?.state !== 'connected'
        ? 'The engine is not connected.'
        : null
  const names = new Map(doc.parts.map((p) => [p.id, p.name]))
  const nameOf = (id: string) => names.get(id) ?? (id === 'frame:plate' ? 'Frame plate' : id.startsWith('frame:arm-') ? `Frame arm ${id.slice(10)}` : id)

  const run = async () => {
    if (blocked || !env.ok || !vehicle) return
    const start: Pick<DropTestInput, 'startPositionM' | 'startClearanceM'> = env.environment.terrain
      ? { startPositionM: [0, 0, 0], startClearanceM: clearanceM }
      : { startPositionM: [0, 0, 0 + (clearanceM - lowestPoint(vehicle.parts.map((p) => ({ shape: p.shape, ...p.pose }))))] }
    setRunning(true)
    try {
      const res = await getApi().engine.dropTest({ vehicle, environment: env.environment, ...start, durationS })
      setResult(res.ok ? { ok: true, r: res.data } : { ok: false, message: res.error.message })
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }

  const speed = (v: number[]) => Math.hypot(...v)
  return (
    <div className="mt-3" data-testid="drop-test">
      <h3 className="mb-1 text-[12px] font-medium text-fg-muted">Drop test (engine)</h3>
      {doc.flight?.wind?.kind === 'wind' && <p className="text-[12px] text-fg-subtle">The drop test runs without wind or propulsion.</p>}
      <NumberField key={`clear:${clearanceM}`} id="drop-clearance" label={env.ok && env.environment.terrain ? 'Ground clearance' : 'Release height (lowest point)'} unit="mm" initial={mm(clearanceM)} parse={numberParser(0, 10_000, 'mm')} onCommit={(v) => setClearance(v / 1000)} />
      <NumberField key={`dur:${durationS}`} id="drop-duration" label="Duration" unit="s" initial={String(durationS)} parse={numberParser(0.1, 10, 's')} onCommit={setDuration} />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" data-testid="run-drop-test" disabled={blocked !== null || running} onClick={() => void run()} title={blocked ?? undefined}>
          {running ? 'Running…' : 'Run drop test'}
        </Button>
        {blocked && <span className="text-[12px] text-fg-subtle">{blocked}</span>}
      </div>
      {result && !result.ok && (
        <p role="alert" className="mt-2 text-[12px] text-fault" data-testid="drop-test-error">
          {result.message}
        </p>
      )}
      {result?.ok && (
        <div className="mt-2 text-[12px] text-fg-muted" data-testid="drop-test-result">
          <p>
            After {result.r.durationS} s: frame origin at <span className="num" data-testid="drop-z">{mm(result.r.state.positionM[2])}</span> mm
            (released at {mm(result.r.startZM)} mm), speed <span className="num" data-testid="drop-speed">{speed(result.r.state.linearVelocityMps).toExponential(1)}</span> m/s,
            turn rate <span className="num">{speed(result.r.state.angularVelocityRadps).toExponential(1)}</span> rad/s.
          </p>
          <ul className="mt-1" data-testid="drop-contacts">
            {result.r.contacts.length === 0 && <li>No contacts.</li>}
            {result.r.contacts.slice(0, 20).map((c, i) => (
              <li key={i} data-testid="drop-contact" className="num">
                {nameOf(c.partId)} · {c.with} · {c.startS.toFixed(3)} s → {c.endS === null ? 'end' : `${c.endS.toFixed(3)} s`}
              </li>
            ))}
            {result.r.contacts.length > 20 && <li>… {result.r.contacts.length - 20} more</li>}
            {result.r.contactsDropped > 0 && <li>{result.r.contactsDropped} more not recorded</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
