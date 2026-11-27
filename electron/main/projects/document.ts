import { z } from 'zod'
import type { SaveAssemblyInput } from '../../ipc/contract'
import { COMPONENT_SCHEMA_VERSION, fieldDef, isOverridable, type Component } from '../../ipc/component-fields'
import { componentInputSchema, userSpecSchema } from '../../ipc/component-schemas'
import { createProjectSchema, saveAssemblySchema, setTuningSchema } from '../../ipc/schemas'
import { MAX_HULL_VERTICES } from '../assets/hull'
import { ValidationError } from '../db/repositories'
import { checked, sha256, sha256Schema } from './container'

const id = z.uuid()
const date = z.iso.datetime({ offset: true })
const count = z.int().nonnegative()
const componentVersion = z.literal(COMPONENT_SCHEMA_VERSION)
const componentSchema = z.discriminatedUnion('origin', [
  z.strictObject({
    id, origin: z.literal('built-in'), schemaVersion: componentVersion, version: sha256Schema,
    fills: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    id, origin: z.enum(['user', 'imported']), schemaVersion: componentVersion, revision: count,
    createdAt: date, updatedAt: date, input: componentInputSchema,
  }),
])

const assetFields = { id: sha256Schema, filename: z.string().min(1).max(255), bytes: z.int().positive(), importedAt: date }
const xyz = z.tuple([z.number(), z.number(), z.number()])
const assetSchema = z.discriminatedUnion('format', [
  z.strictObject({
    ...assetFields, format: z.literal('asc'), noDataValue: z.number().nullable(),
  }),
  z.strictObject({
    ...assetFields, format: z.enum(['glb', 'gltf']), triangles: count,
    bounds: z.strictObject({ min: xyz, max: xyz }).refine(({ min, max }) => min.every((v, i) => v <= max[i]!)),
    hull: z.strictObject({
      points: z.array(xyz).min(4).max(MAX_HULL_VERTICES).nullable(),
      reason: z.string().nullable(),
    }).nullable(),
  }),
])

const recordingSchema = z.strictObject({
  id, startedAt: date, durationS: z.number().nonnegative(), status: z.enum(['completed', 'aborted', 'failed']),
  kind: z.enum(['flight', 'scenario', 'step-test']), title: z.string(), bytes: z.int().positive(), sampleCount: count,
  engineVersion: z.string(), stateHash: z.string().nullable(), endReason: z.string().nullable(), incomplete: z.boolean(),
})

export const projectDocumentSchema = z.strictObject({
  project: createProjectSchema.extend({ id, createdAt: date, updatedAt: date }).strict(),
  assembly: z.strictObject({ updatedAt: date, input: saveAssemblySchema }).nullable(),
  components: z.array(componentSchema),
  tuning: setTuningSchema.shape.overrides,
  assets: z.array(assetSchema),
  recordings: z.array(recordingSchema),
})

export type ProjectDocument = z.infer<typeof projectDocumentSchema>
export type ArchivedComponent = ProjectDocument['components'][number]
export type ArchivedAsset = ProjectDocument['assets'][number]
export type ArchivedRecording = ProjectDocument['recordings'][number]

/** Built-in revision numbers depend on which app releases an install has seen.
 * Fingerprint the catalog content to identify the same revision on a fresh install. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  })
}

export function archiveComponent(component: Component): ArchivedComponent {
  const { id, origin, schemaVersion, revision, createdAt, updatedAt, fills, ...input } = component
  return origin === 'built-in'
    ? { id, origin, schemaVersion: componentVersion.parse(schemaVersion), version: sha256(canonical(input)), ...(fills && { fills }) }
    : { id, origin, schemaVersion: componentVersion.parse(schemaVersion), revision, createdAt, updatedAt, input }
}

export function validateFills(component: Component, fills: Record<string, unknown> = {}) {
  return Object.fromEntries(Object.entries(fills).map(([key, value]) => {
    const field = fieldDef(component.category, key)
    if (!isOverridable(field) || component.specs[key] !== undefined) {
      throw new ValidationError(`Invalid catalog fill "${key}" for "${component.name}".`)
    }
    return [key, checked(userSpecSchema(field), value, `Catalog fill "${key}"`)]
  }))
}

export const assetFilename = (asset: ArchivedAsset): string => `${asset.id}.${asset.format}`
export const assetEntry = (asset: ArchivedAsset): string => `assets/${assetFilename(asset)}`

export function componentReferences(assembly?: SaveAssemblyInput): Set<string> {
  return new Set(assembly?.parts.flatMap((part) => part.componentId ? [part.componentId] : []))
}

export function assetReferences(assembly?: SaveAssemblyInput): Map<string, 'model' | 'terrain'> {
  const references = new Map<string, 'model' | 'terrain'>()
  for (const part of assembly?.parts ?? []) {
    if (part.shape.type === 'model') references.set(part.shape.assetId, 'model')
  }
  for (const obstacle of assembly?.environment?.obstacles ?? []) {
    if (obstacle.type === 'hull' && obstacle.assetId !== null) references.set(obstacle.assetId, 'model')
  }
  const terrainId = assembly?.environment?.terrain?.assetId
  if (terrainId) {
    if (references.has(terrainId)) throw new ValidationError('The same asset cannot be both a model and terrain.')
    references.set(terrainId, 'terrain')
  }
  return references
}

export function validateReferences(document: ProjectDocument): void {
  const { project, assembly, components, assets, recordings } = document
  if (assembly && assembly.input.projectId !== project.id) throw new ValidationError('Assembly project ID does not match.')
  const componentIds = componentReferences(assembly?.input)
  const assetIds = assetReferences(assembly?.input)
  for (const component of components) {
    if (!componentIds.delete(component.id)) throw new ValidationError('Duplicate or unreferenced component.')
  }
  for (const asset of assets) {
    if (assetIds.get(asset.id) !== (asset.format === 'asc' ? 'terrain' : 'model')) {
      throw new ValidationError('Duplicate or unreferenced asset, or an incorrect asset format.')
    }
    assetIds.delete(asset.id)
  }
  if (componentIds.size || assetIds.size) throw new ValidationError('A required component or asset is missing.')
  if (new Set(recordings.map((run) => run.id.toLowerCase())).size !== recordings.length) {
    throw new ValidationError('Duplicate recording IDs.')
  }
}

export function remapAssembly(
  input: SaveAssemblyInput, projectId: string, parts: Map<string, string>, components: Map<string, string>,
): SaveAssemblyInput {
  const partId = (id: string) => parts.get(id) ?? id
  const { wires, schematic, interference, flight } = input
  const sensors = flight?.sensors
  return {
    ...input, projectId, baseRevision: 0,
    parts: input.parts.map((part) => ({
      ...part, id: partId(part.id), parentId: part.parentId === null ? null : partId(part.parentId),
      ...(part.componentId && { componentId: components.get(part.componentId)! }),
    })),
    ...(wires && { wires: wires.map((wire) => ({
      ...wire, from: { ...wire.from, partId: partId(wire.from.partId) }, to: { ...wire.to, partId: partId(wire.to.partId) },
    })) }),
    ...(schematic && { schematic: Object.fromEntries(Object.entries(schematic).map(([id, pos]) => [partId(id), pos])) }),
    ...(interference && { interference: {
      ...interference, allowedPairs: interference.allowedPairs.map(([a, b]) => {
        const first = partId(a)
        const second = partId(b)
        return first < second ? [first, second] : [second, first]
      }),
    } }),
    ...(flight && sensors && { flight: { ...flight, sensors: {
      ...sensors,
      ...(sensors.flightControllerPartId && { flightControllerPartId: partId(sensors.flightControllerPartId) }),
      ...(sensors.gpsPartId && { gpsPartId: partId(sensors.gpsPartId) }),
    } } }),
  }
}
