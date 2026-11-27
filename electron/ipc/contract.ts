/**
 * IPC contract shared by main, preload and renderer.
 *
 * Types and constants only — no runtime dependencies, so the renderer bundle
 * stays small. Request validation schemas live in `schemas.ts` (main only).
 * Every handler resolves to an `IpcResult` so the renderer gets a structured
 * error instead of Electron's stringified exception.
 */

import type { Component, ComponentCategory, ComponentInput, SpecValue } from './component-fields'
import type { ControllerParam, ParamError, TuningOverrides } from '../../src/domain/controller-params'
import type { SensorSettings } from '../../src/domain/sensors'
export type * from './component-fields'
import type { FlightSessionEndResult, FlightSessionStartParams, FlightSessionStartResult, FlightSessionStepParams, FlightSessionStepResult, ScenarioConfigParams, ScenarioRequest, ScenarioRunResult, StepTestRunParams, StepTestRunResult } from '../main/engine/protocol'

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

export type RecordingKind = 'flight' | 'scenario' | 'step-test'

export interface RecordingRun extends SimulationRun {
  kind: RecordingKind | null
  title: string | null
  fileName: string | null
  bytes: number | null
  sampleCount: number | null
  engineVersion: string | null
  stateHash: string | null
  endReason: string | null
  incomplete: boolean | null
  open: boolean
  fileMissing: boolean
}

export interface RecordingChannel {
  name: string
  unit: string
  label: string
}

export interface RecordingHeader {
  runId: string
  projectId: string
  projectName: string
  kind: RecordingKind
  title: string
  startedAt: string
  appVersion: string
  engineVersion: string
  protocolVersion: number
  samplePeriodSteps: number
  stepLengthS: number
  firstSampleStep: number
  channels: RecordingChannel[]
  vehicleLoad: string
  startRequest: string
}

export interface RecordingEnd {
  status: RunStatus
  reason: string
  elapsedS: number
  finalStateHash: string | null
  engineError: string | null
}

export interface RecordingSummary {
  header: RecordingHeader | null
  end: RecordingEnd | null
  bytes: number
  sampleCount: number
  requestCount: number
  incomplete: boolean
  integrityError: string | null
}

export interface RecordingSampleQuery {
  id: string
  channels: string[]
  fromS?: number
  toS?: number
  maxPoints?: number
}

export interface RecordingCsvQuery extends Omit<RecordingSampleQuery, 'channels' | 'maxPoints'> {
  /** Omit to export all recorded channels. Time is always the first column. */
  channels?: string[]
  bom?: boolean
  comments?: boolean
  enumNames?: boolean
}

export interface RecordingPoint {
  timeS: number
  value: number | null
}

export interface RecordingSeries {
  channel: string
  points: RecordingPoint[]
}

export interface RecordingSampleWindow {
  series: RecordingSeries[]
  integrityError: string | null
}

export interface RecordingRequestLog {
  lines: string[]
  integrityError: string | null
}

export type RecordingVerifyResult =
  | { status: 'same'; step: number }
  | { status: 'different'; step: number; reason: string }
  | { status: 'cannot-verify'; reason: string }
  | { status: 'cancelled' }

export interface RecordingVerifyProgress {
  requestId: string
  step: number
  totalSteps: number
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

export const PART_KINDS = [
  'motor',
  'propeller',
  'battery',
  'flight-controller',
  'esc',
  'gps',
  'camera',
  'sensor',
  'landing-gear',
  'payload',
  'custom',
] as const
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
  /**
   * Convex hull computed at import (electron/main/assets/hull.ts), in file units and axes.
   * Absent or null: not computed yet. `points` null: no usable hull (`reason` says why);
   * the model then collides as its bounding box.
   */
  hull?: ModelHull | null
}

/** An imported Esri ASCII grid, stored by SHA-256 of its original file bytes. */
export interface TerrainAssetInfo {
  id: string
  filename: string
  format: 'asc'
  bytes: number
  importedAt: string
}

export interface TerrainImportInput {
  /** The caller confirms that file elevations are in metres. */
  verticalUnit: 'm'
  /** User-entered fallback for a file that omits NODATA_VALUE. */
  noDataValue?: number
}

export interface ModelHull {
  points: [number, number, number][] | null
  reason: string | null
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
  /**
   * The user's own inertia (absent or null = derived from the part's shape, see
   * src/domain/mass.ts). About the part's own CoM, in the part's axes.
   */
  inertia?: PartInertia | null
  /**
   * This part's own values for fields of its linked component (quantity and integer
   * fields only; source 'measured' or 'user'). They win over the library's catalog
   * fill and the manufacturer value for this part only. Absent = none.
   */
  overrides?: Record<string, SpecValue>
  /** User-entered vertical field of view in degrees, used by a camera part in flight. */
  cameraFovDeg?: number
}

/** Open interval for perspective projection: tan(vertical FOV / 2) must be positive and finite. */
export const CAMERA_FOV_DEG = { min: 0, max: 180 } as const

/** A measured or calculated inertia the user entered for one part. */
export interface PartInertia {
  /** [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] in kg·m², tensor sign convention (Ixy = −Σ m·x·y). */
  inertia: [number, number, number, number, number, number]
  /** The part's CoM relative to its shape centre, metres, part axes. */
  comOffset: [number, number, number]
  source: 'user'
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

/** One end of a wire: a port of a part (port ids come from src/domain/ports.ts). */
export interface WireEnd {
  partId: string
  port: string
}

export const WIRE_COLORS = ['red', 'black', 'yellow', 'blue', 'white', 'green', 'orange', 'grey'] as const
export type WireColor = (typeof WIRE_COLORS)[number]

/**
 * A connection in the Electrical Designer. A wire stands for the whole cable between
 * two ports (both conductors of a power lead, all three motor phases). Gauge and length
 * are the user's entries, used by the electrical calculations (3.7); null = not set.
 */
export interface Wire {
  id: string
  from: WireEnd
  to: WireEnd
  gaugeAwg: number | null
  lengthMm: number | null
  color: WireColor | null
}

/** A mass the user entered (null = not set). */
export interface UserMass {
  valueKg: number
  source: 'user'
}

/** Body drag coefficients the user entered, per body axis (no source states them). */
export interface BodyDragInput {
  /** C_d along body x (forward), y (left), z (up); null = that axis not entered yet. */
  cd: [number | null, number | null, number | null]
  source: 'user'
}

export interface AssemblyDocument {
  frame: FrameParams
  /**
   * The frame's own mass (plates and arms, with their hardware). Absent or null = not
   * set: the centre of mass is then incomplete. Used by src/domain/mass.ts.
   */
  frameMass?: UserMass | null
  /**
   * Body drag coefficients per axis (F_i = ½ ρ C_d,i A_i v_i|v_i|, A_i derived from the
   * collision shapes, src/domain/aero.ts). Absent, null, or a null axis = not set:
   * listed in the Ready-to-fly checklist.
   */
  bodyDrag?: BodyDragInput | null
  /** Keyed by mount id (`motor-1` …); motors not listed use PX4 defaults. */
  motors: Record<string, MotorMount>
  parts: AssemblyPart[]
  /** Electrical connections; absent or empty until the project is wired. */
  wires?: Wire[]
  /** Schematic position of each part's box in the Electrical Designer, by part id. */
  schematic?: Record<string, { x: number; y: number }>
  /**
   * The workshop interference check's settings (src/domain/collisions.ts). Absent or
   * null = the starting tolerance and no allowed pairs.
   */
  interference?: InterferenceSettingsDoc | null
  /**
   * The project's flight environment (src/domain/environment.ts). Absent or null = nothing
   * entered: the simulation then lists the ground's friction and restitution as missing.
   */
  environment?: EnvironmentDoc | null
  /**
   * The project's flight conditions (4.8 part B): the user's entries the flight test needs and no
   * source states. Absent or null = nothing entered; the flight test then lists each as missing.
   */
  flight?: FlightConditionsDoc | null
}

/** The flight conditions, the user's entries (no defaults; null = not entered). */
export interface FlightConditionsDoc {
  /** Height above sea level, m; sets the air density (standard atmosphere). */
  ambientAltitudeM: number | null
  /** Air temperature, °C; null = the standard atmosphere's at that altitude (not a missing value). */
  temperatureC: number | null
  /** The battery cut-off: the pack voltage (V) or the charge drawn (mAh) at which the run ends. */
  cutoffType: 'voltageV' | 'chargeMah'
  cutoffValue: number | null
  wind?: WindDoc | null
  groundEffect?: boolean | null
  sensors?: FlightSensorsDoc | null
}

export type FlightSensorsDoc = Omit<SensorSettings, 'flyOnGyro'> & {
  mode: 'off' | 'recorded' | 'flyOnGyro'
}

export type WindRoughnessDoc =
  | { kind: 'categoryC' }
  | { kind: 'otherPhases' }
  | { kind: 'custom'; lengthM: number | null }

export type WindMeanDoc =
  | { kind: 'none' }
  | { kind: 'constant'; speedMps: number | null }
  | { kind: 'shear'; speedAt20FtMps: number | null; roughness: WindRoughnessDoc | null }

export type WindGustDoc =
  | { kind: 'none' }
  | { kind: 'discrete'; amplitudeMps: number | null; lengthM: number | null; startS: number | null }

export type WindDoc =
  | { kind: 'none' }
  | {
      kind: 'wind'
      /** Direction the wind comes from, clockwise from world +X, in degrees. */
      fromDeg: number | null
      mean: WindMeanDoc | null
      gust: WindGustDoc | null
      /** null means off. A selected Dryden model requires a user-entered seed. */
      turbulence?: { kind: 'dryden'; seed: number | null } | null
    }

/**
 * A surface's contact values, the user's entries. null = not set; there are no defaults
 * (no source states them), and the simulation refuses to start until they are set.
 */
export interface SurfaceValues {
  /** Coulomb friction coefficient of the contact with the vehicle, ≥ 0. */
  friction: number | null
  /** Coefficient of restitution of that contact, 0 to 1. */
  restitution: number | null
}

interface ObstacleBase extends SurfaceValues {
  id: string
  name: string
}

/** A fixed box in the original document format, world frame (+Z up, metres). */
export interface LegacyBoxObstacleDoc extends ObstacleBase {
  type?: undefined
  center: [number, number, number]
  size: [number, number, number]
  /** Rotation about the world +Z axis, radians. */
  yaw: number
}

type ObstaclePose = {
  center: [number, number, number] | null
  /** Rotation about the world +Z axis, radians. */
  yaw: number | null
}

export type ObstacleDoc =
  | LegacyBoxObstacleDoc
  | (ObstacleBase & ObstaclePose & (
      | { type: 'box'; size: [number, number, number] | null }
      | { type: 'cylinder'; radius: number | null; height: number | null }
      | { type: 'hull'; assetId: string | null; units: ModelUnits | null; upAxis: UpAxis | null }
    ))

export interface TerrainDoc extends SurfaceValues {
  assetId: string | null
}

/** A terrain grid replaces the plane when selected. */
export interface EnvironmentDoc {
  ground: SurfaceValues
  obstacles: ObstacleDoc[]
  terrain?: TerrainDoc | null
}

export const MAX_OBSTACLES = 50

/** A drop test: the vehicle released from rest above the ground, simulated by the engine. */
export interface DropTestInput {
  /** The pinned VehicleDefinition (src/domain/mass.ts); validated in main and in the engine. */
  vehicle: unknown
  /** The engine's environment (src/domain/environment.ts `simEnvironment`). */
  environment: unknown
  /** Body origin at release, world frame, m. */
  startPositionM: [number, number, number]
  /** Vertical clearance over first ground contact. Overrides the supplied Z. */
  startClearanceM?: number
  durationS: number
}

export interface DropTestResult {
  durationS: number
  startZM: number
  state: {
    positionM: [number, number, number]
    quaternion: [number, number, number, number]
    linearVelocityMps: [number, number, number]
    angularVelocityRadps: [number, number, number]
  }
  contacts: { partId: string; with: string; startS: number; endS: number | null }[]
  contactsDropped: number
}

/**
 * A live flight (4.8 part B). The renderer builds the vehicle, propulsion and aero payloads from
 * the assembly (mass properties are computed in TypeScript, ADR 0006); main validates all of it
 * with the protocol schemas, loads the vehicle into the engine and starts the session.
 */
export interface RecordingOptions {
  projectId: string
  title: string
  live?: boolean
}

export interface RecordingProgress {
  recordingId?: string
  recordingError?: string
}

export interface FlightStartInput {
  recording?: RecordingOptions
  /** Sample for the live panel even when no recording file is requested. */
  live?: true
  /** The pinned VehicleDefinition (src/domain/mass.ts). */
  vehicle: unknown
  /** The motors' coefficients and the battery (src/domain/propulsion.ts `propulsionDefinition`). */
  propulsion: unknown
  /** Body drag: per-axis C_d (entered) and projected areas (derived, src/domain/aero.ts). */
  aero: unknown
  /** The engine's ground, terrain and obstacles (src/domain/environment.ts `simEnvironment`). */
  environment: unknown
  wind?: FlightSessionStartParams['wind']
  groundEffect?: FlightSessionStartParams['groundEffect']
  /** ISA density at the user's altitude and temperature (src/domain/atmosphere.ts), kg/m³. */
  airDensityKgM3: number
  /** The user's battery cut-off: no default. */
  cutoff: { type: 'voltageV' | 'chargeMah'; value: number }
  /** Body origin at the start, world frame, m. */
  startPositionM: [number, number, number]
  /** Vertical clearance over first ground contact. Overrides the supplied Z. */
  startClearanceM?: number
  /** PX4 gain overrides by exact parameter name; absent = the v1.13.3 defaults. */
  gains?: Record<string, number>
  controller?: FlightSessionStartParams['controller']
}
export type FlightStartResult = FlightSessionStartResult & RecordingProgress
export type FlightStepInput = FlightSessionStepParams & { live?: true }
export type FlightStepResult = FlightSessionStepResult & RecordingProgress
export type FlightEndResult = FlightSessionEndResult & RecordingProgress

/**
 * A scripted ClosedLoop or FlightLoop scenario flown on the build. As for a flight, the renderer builds the vehicle, propulsion
 * and aero payloads from the assembly; main validates all of it with the protocol schemas, loads the vehicle and
 * runs the scenario. Nothing is filled in: the air density, the cut-off and a built-in's parameters are the caller's.
 */
export interface ScenarioRunInput {
  recording?: RecordingOptions
  /** The pinned VehicleDefinition (src/domain/mass.ts). */
  vehicle: unknown
  /** The motors' coefficients and the battery (src/domain/propulsion.ts `propulsionDefinition`). */
  propulsion: unknown
  /** Body drag: per-axis C_d (entered) and projected areas (derived, src/domain/aero.ts). */
  aero: unknown
  /** A built-in with its inputs, or a custom script. */
  scenario: ScenarioRequest
  /** Air density, the user's cut-off, gain overrides, optionally a ground and its start position. */
  config: ScenarioConfigParams
}
export type ScenarioRunOutput = ScenarioRunResult & RecordingProgress

export type StepTestInput = Pick<ScenarioRunInput, 'vehicle' | 'propulsion' | 'aero' | 'recording'> & StepTestRunParams
export type StepTestOutput = StepTestRunResult & RecordingProgress

/** Id an allowed pair uses for the parametric frame (its plate and arms are one part). */
export const FRAME_PART_ID = 'frame'

/**
 * The user's interference settings. The tolerance is a check margin the user sets,
 * like the hover-balance margin; DEFAULT_INTERFERENCE_TOLERANCE_M is only its
 * starting value. Pairs are part ids (or FRAME_PART_ID), each pair sorted.
 */
export interface InterferenceSettingsDoc {
  toleranceM: number
  allowedPairs: [string, string][]
}

/** Starting interference tolerance: 0.5 mm (a check margin, not a physical value). */
export const DEFAULT_INTERFERENCE_TOLERANCE_M = 0.0005
/** Largest tolerance the field accepts: 50 mm. */
export const MAX_INTERFERENCE_TOLERANCE_M = 0.05

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

export interface TuningSettings {
  table: readonly ControllerParam[]
  overrides: TuningOverrides
  effective: Record<string, number>
}

export interface SetTuningInput {
  id: string
  /** Replaces the complete saved set; omitted parameters use PX4 defaults. */
  overrides: TuningOverrides
}

// ---- Result envelope --------------------------------------------------------

export type IpcErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL'
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: IpcErrorCode; message: string; errors?: ParamError[] } }

export const GPU_PREFERENCES = ['high-performance', 'power-saving', 'system'] as const
export type GpuPreference = (typeof GPU_PREFERENCES)[number]

export interface GraphicsStatus {
  preference: GpuPreference
  startupPreference: GpuPreference
  onBattery: boolean
}

export type GraphicsCommand =
  | { action: 'set'; preference: GpuPreference }
  | { action: 'restart' }

export type DiagnosticsCommand =
  | { action: 'preview'; includeDatabase: boolean }
  | { action: 'save'; includeDatabase: boolean }

export interface DiagnosticsPreview {
  entries: { name: string; description: string }[]
}

// ---- Channels ---------------------------------------------------------------

export const Channels = {
  diagnosticsOpenLogFolder: 'diagnostics:openLogFolder',
  diagnosticsSave: 'diagnostics:save',
  rendererError: 'diagnostics:rendererError',
  graphicsStatus: 'graphics:status',
  graphicsCommand: 'graphics:command',
  projectsList: 'projects:list',
  projectsCreate: 'projects:create',
  projectsRename: 'projects:rename',
  projectsDelete: 'projects:delete',
  runsListRecent: 'runs:listRecent',
  runsList: 'runs:list',
  runsGet: 'runs:get',
  runsDelete: 'runs:delete',
  recordingSummary: 'recording:summary',
  recordingReadSamples: 'recording:readSamples',
  recordingReadRequests: 'recording:readRequests',
  recordingVerify: 'recording:verify',
  recordingVerifyCancel: 'recording:verifyCancel',
  recordingVerifyProgress: 'recording:verifyProgress',
  recordingTotalSize: 'recording:totalSize',
  recordingPrintReportPdf: 'recording:printReportPdf',
  recordingExportCsv: 'recording:exportCsv',
  systemStatus: 'system:status',
  assemblyLoad: 'assembly:load',
  assemblySave: 'assembly:save',
  tuningGet: 'tuning:get',
  tuningSet: 'tuning:set',
  tuningReset: 'tuning:reset',
  /** Synchronous variant used only while the window unloads, so the last edit is never lost. */
  assemblySaveSync: 'assembly:saveSync',
  assetsList: 'assets:list',
  /** Shows the open-file dialog in main, then validates and stores the chosen file. */
  assetsImport: 'assets:import',
  terrainImport: 'terrain:import',
  terrainRead: 'terrain:read',
  terrainList: 'terrain:list',
  componentsList: 'components:list',
  componentsGet: 'components:get',
  componentsCreate: 'components:create',
  componentsUpdate: 'components:update',
  componentsDelete: 'components:delete',
  componentsDuplicate: 'components:duplicate',
  /** Sets or removes a catalog gap-fill on a built-in component (schema v11). */
  componentsSetFill: 'components:setFill',
  /** Save / open dialogs in main; JSON component packs. */
  componentsExportPack: 'components:exportPack',
  componentsImportPack: 'components:importPack',
  /** Shows a save dialog in main and writes a PNG of the viewport. */
  viewportSavePng: 'viewport:savePng',
  /** main → renderer push */
  engineStatusChanged: 'engine:statusChanged',
  /** Loads a vehicle into the engine and drops it in the given environment. */
  engineDropTest: 'engine:dropTest',
  /** Loads the vehicle and starts a live flight session (replacing any). */
  engineFlightStart: 'engine:flightStart',
  /** Advances the session N fixed 1 ms steps with the setpoint held. */
  engineFlightStep: 'engine:flightStep',
  engineFlightEnd: 'engine:flightEnd',
  /** Loads the vehicle and flies a scripted scenario; answers with its report. */
  engineScenarioRun: 'engine:scenarioRun',
  engineStepTest: 'engine:stepTest',
} as const

/** Shape exposed on `window.api` by the preload script. */
interface RunRecordingApi {
  list(projectId: string): Promise<IpcResult<RecordingRun[]>>
  get(id: string): Promise<IpcResult<RecordingRun>>
  delete(id: string): Promise<IpcResult<null>>
}

interface RecordingApi {
  summary(id: string): Promise<IpcResult<RecordingSummary>>
  readSamples(query: RecordingSampleQuery): Promise<IpcResult<RecordingSampleWindow>>
  readRequests(id: string): Promise<IpcResult<RecordingRequestLog>>
  verify(id: string, requestId: string): Promise<IpcResult<RecordingVerifyResult>>
  cancelVerify(requestId: string): Promise<IpcResult<null>>
  onVerifyProgress(listener: (progress: RecordingVerifyProgress) => void): () => void
  totalSize(): Promise<IpcResult<number>>
  printReportPdf(): Promise<IpcResult<{ path: string } | null>>
  exportCsv(query: RecordingCsvQuery): Promise<IpcResult<{ path: string } | null>>
}

export type DesktopApiWithRecordings = DesktopApi & { runs: RunRecordingApi; recording: RecordingApi }

export interface DesktopApi {
  diagnostics: {
    openLogFolder(): Promise<IpcResult<null>>
    save(input: Extract<DiagnosticsCommand, { action: 'preview' }>): Promise<IpcResult<DiagnosticsPreview>>
    save(input: Extract<DiagnosticsCommand, { action: 'save' }>): Promise<IpcResult<{ path: string } | null>>
    /** Used by the preload's page error listeners. */
    reportRendererError(message: string): void
  }
  graphics: {
    status(): Promise<IpcResult<GraphicsStatus>>
    command(input: GraphicsCommand): Promise<IpcResult<null>>
    onPowerChange(listener: (onBattery: boolean) => void): () => void
  }
  projects: {
    list(): Promise<IpcResult<Project[]>>
    create(input: CreateProjectInput): Promise<IpcResult<Project>>
    rename(input: RenameProjectInput): Promise<IpcResult<Project>>
    delete(id: string): Promise<IpcResult<null>>
  }
  runs: Partial<RunRecordingApi> & {
    listRecent(limit: number): Promise<IpcResult<(SimulationRun & Partial<RecordingRun>)[]>>
  }
  recording?: RecordingApi
  tuning: {
    get(projectId: string): Promise<IpcResult<TuningSettings>>
    set(input: SetTuningInput): Promise<IpcResult<TuningSettings>>
    reset(projectId: string): Promise<IpcResult<TuningSettings>>
  }
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
  terrain: {
    /** Resolves to null when the user cancels the file dialog. */
    import(input: TerrainImportInput): Promise<IpcResult<TerrainAssetInfo | null>>
    read(id: string): Promise<IpcResult<import('../../src/domain/terrain').TerrainGrid>>
    list(): Promise<IpcResult<TerrainAssetInfo[]>>
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
    /** Fills (or, with null, clears) an empty field of a built-in component; returns the updated record. */
    setFill(id: string, key: string, spec: SpecValue | null): Promise<IpcResult<Component>>
    /** Writes the given components to a JSON pack the user picks; null when cancelled. */
    exportPack(ids: string[], name: string): Promise<IpcResult<{ path: string; count: number } | null>>
    /** Reads a pack the user picks; all or nothing. Null when cancelled. */
    importPack(): Promise<IpcResult<{ imported: number; skipped: number } | null>>
  }
  viewport: {
    /** PNG bytes and a proposed file name; resolves to null when the user cancels. */
    savePng(input: { bytes: Uint8Array; name: string }): Promise<IpcResult<{ path: string } | null>>
  }
  engine: {
    dropTest(input: DropTestInput): Promise<IpcResult<DropTestResult>>
    flightStart(input: FlightStartInput): Promise<IpcResult<FlightStartResult>>
    flightStep(input: FlightStepInput): Promise<IpcResult<FlightStepResult>>
    flightEnd(): Promise<IpcResult<FlightEndResult>>
    scenarioRun(input: ScenarioRunInput): Promise<IpcResult<ScenarioRunOutput>>
    stepTest(input: StepTestInput): Promise<IpcResult<StepTestOutput>>
  }
  /** True when main was started for end-to-end tests (BLAZE_UAV_TEST_HOOKS=1); never in normal use. */
  testHooks: boolean
  system: {
    status(): Promise<IpcResult<SystemStatus>>
    onEngineStatus(listener: (status: EngineStatus) => void): () => void
  }
}
