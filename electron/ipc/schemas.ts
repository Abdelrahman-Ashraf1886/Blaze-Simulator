/** zod validation for IPC request payloads. Main process only. */
import { z } from 'zod'
import { overridableField, type SpecValue } from './component-fields'
import { userSpecSchema } from './component-schemas'
import { inertiaProblem } from './inertia'
import {
  FRAME_PARAM_LIMITS,
  FRAME_PART_ID,
  FRAME_TYPES,
  MAX_INTERFERENCE_TOLERANCE_M,
  MAX_MOTOR_TILT,
  MAX_OBSTACLES,
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
  inertia: z
    .object({
      inertia: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
      comOffset: z.tuple([coord, coord, coord]),
      source: z.literal('user'),
    })
    .strict()
    .superRefine((v, ctx) => {
      const problem = inertiaProblem(v.inertia)
      if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['inertia'] })
    })
    .nullable()
    .optional(),
  overrides: z
    // Each value is checked against its field below (userSpecSchema).
    .record(z.string(), z.custom<SpecValue>(() => true))
    .superRefine((o, ctx) => {
      for (const [key, v] of Object.entries(o)) {
        const f = overridableField(key)
        if (!f) {
          ctx.addIssue({ code: 'custom', message: `"${key}" cannot be overridden on a part`, path: [key] })
          continue
        }
        const r = userSpecSchema(f).safeParse(v)
        if (!r.success) ctx.addIssue({ code: 'custom', message: `${f.label}: ${r.error.issues.map((x) => x.message).join('; ')}`, path: [key] })
      }
    })
    .optional(),
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

const finite = z.number().refine(Number.isFinite, 'must be a finite number')
/** null = not set (the user has not entered it); otherwise within physical limits. */
const friction = finite.min(0, 'Friction cannot be negative').max(10, 'Friction above 10 is not a physical coefficient').nullable()
const restitution = finite.min(0, 'Restitution must be between 0 and 1').max(1, 'Restitution must be between 0 and 1').nullable()
const obstacleCoord = z.number().min(-1000, 'Obstacle positions must be within 1 km').max(1000, 'Obstacle positions must be within 1 km')
const side = z.number().positive('Obstacle sizes must be positive').max(1000, 'Obstacle sizes must be within 1 km')

export const environmentDocSchema = z
  .object({
    ground: z.object({ friction, restitution }).strict(),
    obstacles: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().trim().min(1, 'An obstacle needs a name').max(80),
            center: z.tuple([obstacleCoord, obstacleCoord, obstacleCoord]),
            size: z.tuple([side, side, side]),
            yaw: finite.min(-2 * Math.PI).max(2 * Math.PI),
            friction,
            restitution,
          })
          .strict(),
      )
      .max(MAX_OBSTACLES, `At most ${MAX_OBSTACLES} obstacles`)
      .superRefine((obstacles, ctx) => {
        if (new Set(obstacles.map((o) => o.id)).size !== obstacles.length) ctx.addIssue({ code: 'custom', message: 'Obstacle ids must be unique' })
      }),
  })
  .strict()
/** One axis of the body drag coefficient; null = not entered. */
const bodyCd = z.number().positive('C_d must be more than 0').max(10, 'C_d must be at most 10').nullable()

export const saveAssemblySchema = z
  .object({
    projectId: z.uuid(),
    baseRevision: z.int().min(0),
    frame: frameParamsSchema,
    frameMass: z
      .object({ valueKg: z.number().positive('Frame mass must be more than 0').max(100, 'Frame mass must be at most 100 kg'), source: z.literal('user') })
      .strict()
      .nullable()
      .optional(),
    bodyDrag: z
      .object({
        cd: z.tuple([bodyCd, bodyCd, bodyCd]),
        source: z.literal('user'),
      })
      .strict()
      .nullable()
      .optional(),
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
    environment: environmentDocSchema.nullable().optional(),
    interference: z
      .object({
        toleranceM: z
          .number()
          .min(0, 'The interference tolerance cannot be negative')
          .max(MAX_INTERFERENCE_TOLERANCE_M, `The interference tolerance must be at most ${MAX_INTERFERENCE_TOLERANCE_M * 1000} mm`),
        allowedPairs: z
          .array(z.tuple([z.string().min(1).max(64), z.string().min(1).max(64)]))
          .max(MAX_PARTS * 4, 'Too many allowed pairs'),
      })
      .strict()
      .nullable()
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
    const pairs = new Set<string>()
    for (const [a, b] of doc.interference?.allowedPairs ?? []) {
      for (const id of [a, b]) {
        if (id !== FRAME_PART_ID && !byId.has(id)) ctx.addIssue({ code: 'custom', message: 'An allowed overlap names a part that does not exist' })
      }
      if (a >= b) ctx.addIssue({ code: 'custom', message: 'An allowed overlap must name two different parts, sorted' })
      if (pairs.has(`${a},${b}`)) ctx.addIssue({ code: 'custom', message: 'An allowed overlap is listed twice' })
      pairs.add(`${a},${b}`)
    }
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
