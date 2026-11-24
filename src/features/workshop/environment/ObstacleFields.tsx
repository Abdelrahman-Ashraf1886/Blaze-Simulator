import type { AssemblyDocument, AssetInfo, ObstacleDoc } from '../../../../electron/ipc/contract'
import { NumberField } from '@/components/number-field'
import { ChoiceField, OptionalNumberField, optionalNumber } from './fields'
import { projectHullModels } from './obstacles'

type ShapedObstacle = Exclude<ObstacleDoc, { type?: undefined }>
type Vector = [number, number, number]

// Bounds from electron/ipc/schemas.ts:159–175.
const coordinate = { accepts: (v: number) => Math.abs(v) <= 1000, message: 'Enter a coordinate within 1 km of the origin.' }
const side = { accepts: (v: number) => v > 0 && v <= 1000, message: 'Enter a size greater than zero and at most 1000 m.' }
const degrees = { accepts: (v: number) => Math.abs(v) <= 360, message: 'Enter an angle from −360° to 360°.' }

export function parseObstacleVector(text: string, constraint: typeof coordinate) {
  if (!text.trim()) return { ok: true as const, value: null }
  const axes = text.trim().split(/\s+/).map((axis) => optionalNumber(axis, constraint))
  const [x, y, z] = axes
  if (axes.length !== 3 || !x?.ok || !y?.ok || !z?.ok || x.value === null || y.value === null || z.value === null) {
    return { ok: false as const, message: `Enter three space-separated numbers. ${constraint.message}` }
  }
  const value: Vector = [x.value, y.value, z.value]
  return { ok: true as const, value }
}

export function ObstacleFields({ id, obstacle, parts, assets, onChange }: {
  id: string
  obstacle: ShapedObstacle
  parts: AssemblyDocument['parts']
  assets: Readonly<Record<string, AssetInfo>>
  onChange: (label: string, next: ShapedObstacle) => void
}) {
  const { center, yaw } = obstacle
  return <>
    <p className="text-[12px] text-fg-muted">{{ box: 'Box', cylinder: 'Vertical cylinder', hull: 'Convex hull' }[obstacle.type]}</p>
    <NumberField key={center?.join(' ')} id={id + '-center'} label="Centre X Y Z" unit="m" width={136}
      initial={center?.join(' ') ?? ''} placeholder="X Y Z" parse={(text) => parseObstacleVector(text, coordinate)}
      onCommit={(center) => onChange('Move', { ...obstacle, center })} />
    <OptionalNumberField id={id + '-yaw'} label="Yaw" unit="°" value={yaw === null ? null : yaw * 180 / Math.PI}
      constraint={degrees} onCommit={(deg) => onChange('Turn', { ...obstacle, yaw: deg === null ? null : deg * Math.PI / 180 })} />
    {obstacle.type === 'box' && <NumberField key={obstacle.size?.join(' ')} id={id + '-size'} label="Size X Y Z" unit="m" width={136}
      initial={obstacle.size?.join(' ') ?? ''} placeholder="X Y Z" parse={(text) => parseObstacleVector(text, side)}
      onCommit={(size) => onChange('Resize', { ...obstacle, size })} />}
    {obstacle.type === 'cylinder' && <>
      <OptionalNumberField id={id + '-radius'} label="Radius" unit="m" value={obstacle.radius} constraint={side}
        onCommit={(radius) => onChange('Resize', { ...obstacle, radius })} />
      <OptionalNumberField id={id + '-height'} label="Height" unit="m" value={obstacle.height} constraint={side}
        onCommit={(height) => onChange('Resize', { ...obstacle, height })} />
    </>}
    {obstacle.type === 'hull' && <HullFields id={id} obstacle={obstacle} parts={parts} assets={assets} onChange={onChange} />}
  </>
}

function HullFields({ id, obstacle, parts, assets, onChange }: {
  id: string
  obstacle: Extract<ObstacleDoc, { type: 'hull' }>
  parts: AssemblyDocument['parts']
  assets: Readonly<Record<string, AssetInfo>>
  onChange: (label: string, next: ShapedObstacle) => void
}) {
  const models = projectHullModels(parts, assets)
  const current = models.find(({ shape }) => shape.assetId === obstacle.assetId && shape.units === obstacle.units && shape.upAxis === obstacle.upAxis)
  const stored = !current && obstacle.assetId !== null
  return <>
    <p className="text-[11.5px] text-fg-subtle">The convex hull is what collides, not the visible mesh.</p>
    <ChoiceField id={id + '-model'} label="Project model" value={current?.id ?? (stored ? 'stored' : '')}
      hint={models.length ? undefined : 'Import a model with a usable convex hull into this project.'}
      options={[
        ['', 'Unset'],
        ...(stored ? [['stored', assets[obstacle.assetId!]?.filename ?? 'Stored model'] as const] : []),
        ...models.map(({ id, name, shape }) => [id, `${name} (${shape.units}, ${shape.upAxis.toUpperCase()} up)`] as const),
      ]}
      onChange={(id) => {
        if (id === 'stored') return
        const shape = models.find((model) => model.id === id)?.shape
        onChange('Set model', {
          ...obstacle, assetId: shape?.assetId ?? null, units: shape?.units ?? null, upAxis: shape?.upAxis ?? null,
        })
      }} />
  </>
}
