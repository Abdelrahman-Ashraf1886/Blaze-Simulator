/** zod validation for IPC request payloads. Main process only. */
import { z } from 'zod'
import {
  FRAME_PARAM_LIMITS,
  FRAME_TYPES,
  MAX_MOTOR_TILT,
  MODEL_UNITS,
  PART_KINDS,
  WIRE_COLORS,
  type CreateProjectInput,
  type RenameProjectInput,
  type SaveAssemblyInput,
} from './contract'

const projectName = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(80, 'Name must be 80 characters or fewer')

export const createProjectSchema = z.object({ name: projectName, frameType: z.enum(FRAME_TYPES) })
export const renameProjectSchema = z.object({ id: z.uuid(), name: projectName })
export const projectIdSchema = z.object({ id: z.uuid() })
export const listRunsSchema = z.object({ limit: z.int().min(1).max(200) })

// ---- Assembly ---------------------------------------------------------------

/** Assembly coordinates are bounded to a 20 m cube; zod 4 numbers already reject NaN/Infinity. */
const coord = z.number().min(-10).max(10)
const length = (min: number, max: number) => z.number().min(min).max(max)
const mm = (m: number) => `${Math.round(m * 1000 * 10) / 10} mm`

const limited = (key: keyof typeof FRAME_PARAM_LIMITS, label: string) => {
  const { min, max } = FRAME_PARAM_LIMITS[key]
  return z
    .number()
    .min(min, `${label} must be at least ${mm(min)}`)
    .max(max, `${label} must be at most ${mm(max)}`)
}

export const frameParamsSchema = z
  .object({
    motorDiagonal: limited('motorDiagonal', 'Motor-to-motor diagonal'),
    armWidth: limited('armWidth', 'Arm width'),
    armThickness: limited('armThickness', 'Arm thickness'),
    plateSize: limited('plateSize', 'Centre plate'),
  })
  .refine((f) => f.plateSize < f.motorDiagonal, {
    message: 'Centre plate must be smaller than the motor-to-motor diagonal',
    path: ['plateSize'],
  })

const shapeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('box'), size: z.tuple([length(1e-4, 3), length(1e-4, 3), length(1e-4, 3)]) }),
  z.object({ type: z.literal('cylinder'), radius: length(1e-4, 1.5), height: length(1e-4, 3) }),
  z.object({
    type: z.literal('model'),
    assetId: z.string().regex(/^[0-9a-f]{64}$/, 'Asset id must be a SHA-256 hex digest'),
    units: z.enum(MODEL_UNITS),
    upAxis: z.enum(['y', 'z']),
  }),
])

const quaternion = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine((q) => Math.abs(Math.hypot(...q) - 1) < 1e-6, 'Rotation must be a unit quaternion')

const partSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1, 'Part name is required').max(80),
  kind: z.enum(PART_KINDS),
  shape: shapeSchema,
  parentId: z.uuid().nullable(),
  mountId: z.string().min(1).max(64).nullable(),
  position: z.tuple([coord, coord, coord]),
  rotation: quaternion,
  mass: z.object({ valueKg: z.number().gt(0).max(1000), source: z.literal('user') }).nullable(),
  componentId: z.uuid().nullable().optional(),
})

const motorMountSchema = z.object({
  spin: z.enum(['cw', 'ccw']),
  tilt: z
    .number()
    .min(-MAX_MOTOR_TILT, 'Motor tilt must be within ±30°')
    .max(MAX_MOTOR_TILT, 'Motor tilt must be within ±30°'),
})

export const MAX_PARTS = 500
export const MAX_WIRES = 2000

const wireEnd = z.object({ partId: z.uuid(), port: z.string().min(1).max(40) }).strict()
const wireSchema = z
  .object({
    id: z.uuid(),
    from: wireEnd,
    to: wireEnd,
    gaugeAwg: z.number().min(0).max(40).nullable(),
    lengthMm: z.number().gt(0, 'Wire length must be positive').max(10_000, 'Wire length must be 10 m or less').nullable(),
    color: z.enum(WIRE_COLORS).nullable(),
  })
  .strict()

export const saveAssemblySchema = z
  .object({
    projectId: z.uuid(),
    baseRevision: z.int().min(0),
    frame: frameParamsSchema,
    motors: z.record(z.string(), motorMountSchema).superRefine((motors, ctx) => {
      for (const key of Object.keys(motors)) {
        if (!/^motor-[1-8]$/.test(key)) ctx.addIssue({ code: 'custom', message: `Unknown motor mount "${key}"` })
      }
    }),
    parts: z.array(partSchema).max(MAX_PARTS, `An assembly can hold at most ${MAX_PARTS} parts`),
    wires: z.array(wireSchema).max(MAX_WIRES, `A project can hold at most ${MAX_WIRES} wires`).optional(),
    schematic: z
      .record(z.uuid(), z.object({ x: z.number().min(-1e5).max(1e5), y: z.number().min(-1e5).max(1e5) }).strict())
      .optional(),
  })
  .superRefine((doc, ctx) => {
    const byId = new Map(doc.parts.map((p) => [p.id, p]))
    const wireIds = new Set<string>()
    for (const w of doc.wires ?? []) {
      if (wireIds.has(w.id)) ctx.addIssue({ code: 'custom', message: 'Wire ids must be unique' })
      wireIds.add(w.id)
      for (const end of [w.from, w.to]) {
        if (!byId.has(end.partId)) ctx.addIssue({ code: 'custom', message: 'A wire is connected to a part that does not exist' })
      }
      if (w.from.partId === w.to.partId && w.from.port === w.to.port) {
        ctx.addIssue({ code: 'custom', message: 'A wire cannot connect a port to itself' })
      }
    }
    for (const id of Object.keys(doc.schematic ?? {})) {
      if (!byId.has(id)) ctx.addIssue({ code: 'custom', message: 'The schematic places a part that does not exist' })
    }
    if (byId.size !== doc.parts.length) ctx.addIssue({ code: 'custom', message: 'Part ids must be unique' })
    for (const p of doc.parts) {
      if (p.parentId === null) continue
      if (!byId.has(p.parentId)) {
        ctx.addIssue({ code: 'custom', message: `Part "${p.name}" is attached to a part that does not exist` })
        continue
      }
      // Walk up the parent chain; revisiting a part means a cycle.
      const seen = new Set([p.id])
      for (let cur = byId.get(p.parentId); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
        if (seen.has(cur.id)) {
          ctx.addIssue({ code: 'custom', message: `Part "${p.name}" is attached in a loop` })
          break
        }
        seen.add(cur.id)
      }
    }
  })

// Compile-time guarantee that schemas and contract types agree.
type Assert<T extends true> = T
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type _CreateMatches = Assert<Same<z.infer<typeof createProjectSchema>, CreateProjectInput>>
export type _RenameMatches = Assert<Same<z.infer<typeof renameProjectSchema>, RenameProjectInput>>
export type _SaveAssemblyMatches = Assert<Same<z.infer<typeof saveAssemblySchema>, SaveAssemblyInput>>
