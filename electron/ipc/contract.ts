/**
 * IPC contract shared by main, preload and renderer.
 *
 * Types and constants only — no runtime dependencies, so the renderer bundle
 * stays small. Request validation schemas live in `schemas.ts` (main only).
 * Every handler resolves to an `IpcResult` so the renderer gets a structured
 * error instead of Electron's stringified exception.
 */

import type { Component, ComponentCategory, ComponentInput } from './component-fields'
export type * from './component-fields'

// ---- Domain types -----------------------------------------------------------

export const FRAME_TYPES = ['quad-x', 'hex-x', 'octo-x'] as const
export type FrameType = (typeof FRAME_TYPES)[number]

/** Multirotor layouts in "X" orientation: forward points between the two front arms. */
export const FRAME_SPECS: Record<FrameType, { name: string; rotors: number }> = {
  'quad-x': { name: 'Quad X', rotors: 4 },
  'hex-x': { name: 'Hex X', rotors: 6 },
  'octo-x': { name: 'Octo X', rotors: 8 },
}

export interface Project {
  id: string
  name: string
  frameType: FrameType
  createdAt: string
  updatedAt: string
}

export type RunStatus = 'completed' | 'aborted' | 'failed'

export interface SimulationRun {
  id: string
  projectId: string
  projectName: string
  startedAt: string
  durationS: number
  status: RunStatus
}

export type EngineState = 'stopped' | 'starting' | 'connected' | 'restarting' | 'failed'

export interface EngineStatus {
  state: EngineState
  engineVersion: string | null
  protocolVersion: number | null
  threads: number | null
  /** Round-trip time of the last health ping, measured in the main process. */
  latencyMs: number | null
  lastError: string | null
  restarts: number
  /**
   * Increments on every change. The renderer keeps the highest revision it has
   * seen, so a status snapshot that arrives after a newer push cannot roll the
   * UI back to an older state.
   */
  revision: number
}

export interface SystemStatus {
  engine: EngineStatus
  database: { path: string; schemaVersion: number }
  app: { version: string; electron: string; chrome: string; node: string; platform: string }
  componentCount: number
}

// ---- Assembly (SI units: metres; rotations as unit quaternions x, y, z, w) ----

/** Design parameters of the parametric frame. */
export interface FrameParams {
  /** Distance between diagonally opposite motor axes. */
  motorDiagonal: number
  armWidth: number
  armThickness: number
  /** Edge length of the square centre plate. */
  plateSize: number
}

export const FRAME_PARAM_LIMITS: Record<keyof FrameParams, { min: number; max: number }> = {
  motorDiagonal: { min: 0.05, max: 3 },
  armWidth: { min: 0.003, max: 0.1 },
  armThickness: { min: 0.001, max: 0.05 },
  plateSize: { min: 0.02, max: 0.6 },
}

export const PART_KINDS = ['motor', 'propeller', 'battery', 'flight-controller', 'esc', 'payload', 'custom'] as const
export type PartKind = (typeof PART_KINDS)[number]

/** Length unit of an imported model's coordinates (glTF specifies metres; many exporters ignore that). */
export const MODEL_UNITS = ['m', 'mm', 'in'] as const
export type ModelUnits = (typeof MODEL_UNITS)[number]
/** Up axis of an imported model's file. glTF specifies +Y; CAD exports are often +Z. */
export type UpAxis = 'y' | 'z'

export type PartShape =
  | { type: 'box'; size: [number, number, number] }
  | { type: 'cylinder'; radius: number; height: number }
  /** Rendered centred on the part origin, converted to metres and the Z-up world frame. */
  | { type: 'model'; assetId: string; units: ModelUnits; upAxis: UpAxis }

export interface Bounds3 {
  min: [number, number, number]
  max: [number, number, number]
}

/** Largest model file accepted for import. */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024
/** Above this many triangles an imported model gets a performance warning. */
export const TRIANGLE_WARNING = 500_000

/** Privileged protocol that serves the asset store (and nothing else) to the renderer. */
export const ASSET_SCHEME = 'blaze-asset'
export const assetUrl = (id: string) => `${ASSET_SCHEME}://model/${id}`

/** An imported model file in the app's asset store. */
export interface AssetInfo {
  /** SHA-256 of the file bytes, hex. */
  id: string
  filename: string
  format: 'glb' | 'gltf'
  bytes: number
  triangles: number
  /** Bounds of the default scene in file units and file axes. */
  bounds: Bounds3
  importedAt: string
  warnings: string[]
}

export interface AssemblyPart {
  id: string
  name: string
  kind: PartKind
  shape: PartShape
  /** Part this one is attached to (moves with it), or null when free-standing. */
  parentId: string | null
  /** Mounting point on the parent, e.g. `motor-1`; null when not snapped to one. */
  mountId: string | null
  /** Relative to the parent when attached, otherwise to the world. */
  position: [number, number, number]
  rotation: [number, number, number, number]
  /** The user's own value (null = not set). A linked component's stated mass is used instead while linked. */
  mass: { valueKg: number; source: 'user' } | null
  /**
   * Library component this part is (an instance of). Its stated mass and size are
   * shown and used while linked; the part's own values are kept for unlinking.
   */
  componentId?: string | null
}

export type Spin = 'cw' | 'ccw'

/** Per-motor override of the PX4 default spin and of the (zero) tilt. */
export interface MotorMount {
  /** As seen from above. */
  spin: Spin
  /** Rotation about the arm axis in radians, right-hand rule about the outward arm direction. */
  tilt: number
}

export const MAX_MOTOR_TILT = (30 * Math.PI) / 180

export interface AssemblyDocument {
  frame: FrameParams
  /** Keyed by mount id (`motor-1` …); motors not listed use PX4 defaults. */
  motors: Record<string, MotorMount>
  parts: AssemblyPart[]
}

export interface Assembly extends AssemblyDocument {
  projectId: string
  revision: number
  updatedAt: string
}

export interface SaveAssemblyInput extends AssemblyDocument {
  projectId: string
  /** Revision the edit was based on; the save is rejected if the stored one differs. */
  baseRevision: number
}

export interface SaveAssemblyResult {
  revision: number
  updatedAt: string
}

// ---- Request payloads (validated by schemas.ts) -----------------------------

export interface CreateProjectInput {
  name: string
  frameType: FrameType
}
export interface RenameProjectInput {
  id: string
  name: string
}

// ---- Result envelope --------------------------------------------------------

export type IpcErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL'
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: IpcErrorCode; message: string } }

// ---- Channels ---------------------------------------------------------------

export const Channels = {
  projectsList: 'projects:list',
  projectsCreate: 'projects:create',
  projectsRename: 'projects:rename',
  projectsDelete: 'projects:delete',
  runsListRecent: 'runs:listRecent',
  systemStatus: 'system:status',
  assemblyLoad: 'assembly:load',
  assemblySave: 'assembly:save',
  /** Synchronous variant used only while the window unloads, so the last edit is never lost. */
  assemblySaveSync: 'assembly:saveSync',
  assetsList: 'assets:list',
  /** Shows the open-file dialog in main, then validates and stores the chosen file. */
  assetsImport: 'assets:import',
  componentsList: 'components:list',
  componentsGet: 'components:get',
  componentsCreate: 'components:create',
  componentsUpdate: 'components:update',
  componentsDelete: 'components:delete',
  componentsDuplicate: 'components:duplicate',
  /** Save / open dialogs in main; JSON component packs. */
  componentsExportPack: 'components:exportPack',
  componentsImportPack: 'components:importPack',
  /** Shows a save dialog in main and writes a PNG of the viewport. */
  viewportSavePng: 'viewport:savePng',
  /** main → renderer push */
  engineStatusChanged: 'engine:statusChanged',
} as const

/** Shape exposed on `window.api` by the preload script. */
export interface DesktopApi {
  projects: {
    list(): Promise<IpcResult<Project[]>>
    create(input: CreateProjectInput): Promise<IpcResult<Project>>
    rename(input: RenameProjectInput): Promise<IpcResult<Project>>
    delete(id: string): Promise<IpcResult<null>>
  }
  runs: { listRecent(limit: number): Promise<IpcResult<SimulationRun[]>> }
  assembly: {
    /** Loads the project's assembly, creating it with starting values on first open. */
    load(projectId: string): Promise<IpcResult<Assembly>>
    save(input: SaveAssemblyInput): Promise<IpcResult<SaveAssemblyResult>>
    /** Blocks the renderer until saved. Only for the unload path. */
    saveSync(input: SaveAssemblyInput): IpcResult<SaveAssemblyResult>
  }
  assets: {
    list(): Promise<IpcResult<AssetInfo[]>>
    /** Resolves to null when the user cancels the file dialog. */
    import(): Promise<IpcResult<AssetInfo | null>>
  }
  components: {
    list(category?: ComponentCategory): Promise<IpcResult<Component[]>>
    get(id: string): Promise<IpcResult<Component>>
    create(input: ComponentInput): Promise<IpcResult<Component>>
    /** Rejected with CONFLICT when the stored revision is not `baseRevision`; built-in records are read-only. */
    update(id: string, baseRevision: number, input: ComponentInput): Promise<IpcResult<Component>>
    delete(id: string): Promise<IpcResult<null>>
    /** A user-owned copy (the way to change a built-in component). */
    duplicate(id: string): Promise<IpcResult<Component>>
    /** Writes the given components to a JSON pack the user picks; null when cancelled. */
    exportPack(ids: string[], name: string): Promise<IpcResult<{ path: string; count: number } | null>>
    /** Reads a pack the user picks; all or nothing. Null when cancelled. */
    importPack(): Promise<IpcResult<{ imported: number; skipped: number } | null>>
  }
  viewport: {
    /** PNG bytes and a proposed file name; resolves to null when the user cancels. */
    savePng(input: { bytes: Uint8Array; name: string }): Promise<IpcResult<{ path: string } | null>>
  }
  system: {
    status(): Promise<IpcResult<SystemStatus>>
    onEngineStatus(listener: (status: EngineStatus) => void): () => void
  }
}
