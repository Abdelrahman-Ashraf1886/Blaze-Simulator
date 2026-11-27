import { z } from 'zod'
import { MAX_TERRAIN_CELLS } from '../../src/domain/terrain'
import { CONTROLLER_PARAMS, effectiveParams } from '../../src/domain/controller-params'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { Channels, MAX_ASSET_BYTES, type DatabaseBackup, type DiagnosticsPreview, type FlightStartResult, type FlightStepResult, type GpuPreference, type GraphicsStatus, type IpcResult, type Project, type ProjectExportInput, type SystemStatus, type TerrainAssetInfo } from './contract'
import {
  assetIdSchema,
  diagnosticsOpenLogFolderSchema,
  diagnosticsSaveSchema,
  rendererErrorSchema,
  graphicsCommandSchema,
  graphicsStatusSchema,
  createProjectSchema,
  flightLiveViewSchema,
  listRunsSchema,
  projectIdSchema,
  projectExportSchema,
  restoreDatabaseSchema,
  printReportPdfSchema,
  recordingCsvSchema,
  recordingIdSchema,
  recordingSampleSchema,
  recordingVerifyCancelSchema,
  recordingVerifySchema,
  renameProjectSchema,
  saveAssemblySchema,
  setTuningSchema,
  terrainImportSchema,
} from './schemas'
import {
  componentIdSchema,
  componentInputSchema,
  describeIssues,
  listComponentsSchema,
  setFillSchema,
  updateComponentSchema,
  userSpecSchema,
} from './component-schemas'
import { fieldDef, isOverridable, type SpecValue } from './component-fields'
import { ConflictError, NotFoundError, TuningValidationError, ValidationError, type Repositories } from '../main/db/repositories'
import { importTerrainFile, readTerrainFile } from '../main/assets/terrain-store'
import type { createRecordingCsvExporter, PickCsvPath } from '../main/telemetry/csv'
import { RecordingFormatError } from '../main/telemetry/format'
import { MAX_NODE_DEPTH } from '../main/assets/gltf'
import { MAX_IMAGE_BYTES, savePngSchema, writeConfirmedFile } from '../main/screenshot'
import { RecordingQueryError } from '../main/telemetry/reader'
import type { RecordingStore } from '../main/telemetry/store'
import { verifyRecording } from '../main/telemetry/verify'
import { flightStart, flightStartSchema, flightStep, type EngineForFlight } from '../main/engine/flight-session'
import { RECORD_EVERY_STEPS, type SessionRecorder } from '../main/telemetry/session-recorder'

const engineJobs = new Set<string>([
  Channels.engineDropTest, Channels.engineFlightStart, Channels.engineFlightStep,
  Channels.engineScenarioRun, Channels.engineStepTest,
])
const assetImports = new Set<string>([Channels.assetsImport, Channels.terrainImport, Channels.componentsImportPack])

export function ipcPayloadWithinBudget(value: unknown, budget: number): boolean {
  const active = new WeakSet<object>()
  function charge(bytes: number): boolean {
    budget -= bytes
    return budget >= 0
  }
  function visit(input: unknown, depth: number): boolean {
    // Charge one double-width slot even for booleans and null.
    if (depth > MAX_NODE_DEPTH || !charge(Float64Array.BYTES_PER_ELEMENT)) return false
    if (typeof input === 'string') return input.length <= budget && charge(Buffer.byteLength(input))
    if (input === null || input === undefined || typeof input === 'boolean' || typeof input === 'number') return true
    if (typeof input !== 'object' || active.has(input)) return false
    if (ArrayBuffer.isView(input)) return charge(input.buffer.byteLength)
    if (input instanceof ArrayBuffer) return charge(input.byteLength)

    active.add(input)
    if (Array.isArray(input)) {
      // The terrain grid is the largest flat input collection.
      if (input.length > MAX_TERRAIN_CELLS || input.length * Float64Array.BYTES_PER_ELEMENT > budget) return false
      for (const value of input) if (!visit(value, depth + 1)) return false
    } else {
      const prototype: unknown = Object.getPrototypeOf(input)
      if (prototype !== Object.prototype && prototype !== null) return false
      const fields = input as Record<string, unknown>
      for (const key in fields) {
        if (Object.hasOwn(fields, key) && (!visit(key, depth + 1) || !visit(fields[key], depth + 1))) return false
      }
    }
    active.delete(input)
    return true
  }
  return visit(value, 0)
}

type MainIpcEvent = IpcMainEvent | IpcMainInvokeEvent
const ipcDenied = (message: string): IpcResult<never> => ({ ok: false, error: { code: 'VALIDATION', message } })

export function createIpcGuard(getContents: () => WebContents | undefined, expectedDocument: URL) {
  const active = new Set<string>()
  const expected = new URL(expectedDocument)
  expected.hash = ''
  function rejection(event: MainIpcEvent, args: unknown[], channel: string): IpcResult<never> | undefined {
    const contents = getContents()
    const frame = event.senderFrame
    if (!contents || contents.isDestroyed() || event.sender !== contents || !frame || frame !== contents.mainFrame) {
      return ipcDenied('IPC is available from the main window.')
    }
    const url = URL.parse(frame.url)
    if (url) url.hash = ''
    if (url?.href !== expected.href) return ipcDenied('IPC is available from the app document.')
    // The PNG contract allows a full-size typed array plus the name and envelope.
    const budget = channel === Channels.viewportSavePng
      ? MAX_IMAGE_BYTES + savePngSchema.shape.name.maxLength! * 3 + Buffer.byteLength('bytesname') + 5 * Float64Array.BYTES_PER_ELEMENT
      : MAX_ASSET_BYTES
    if (args.length > 1 || !ipcPayloadWithinBudget(args[0], budget)) return ipcDenied('IPC payload exceeds its size or structure limit.')
  }
  return {
    handle(channel: string, handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown) {
      return async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        const rejected = rejection(event, args, channel)
        if (rejected) return rejected
        // Flight end can interrupt a step. Keep it in its own single slot.
        const slot = engineJobs.has(channel) ? 'engine'
          : assetImports.has(channel) ? 'asset import'
          : channel === Channels.recordingVerify || channel === Channels.engineFlightEnd ? channel
          : undefined
        if (!slot) return handler(event, args[0])
        if (active.has(slot)) return ipcDenied('An operation of this kind is already active.')
        active.add(slot)
        try {
          return await handler(event, args[0])
        } finally {
          active.delete(slot)
        }
      }
    },
    on(channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) {
      return (event: IpcMainEvent, ...args: unknown[]) => {
        const rejected = rejection(event, args, channel)
        if (!rejected) listener(event, args[0])
        else if (channel === Channels.assemblySaveSync) event.returnValue = rejected
      }
    },
  }
}

export function createDiagnosticsHandlers(options: {
  openLogFolder: () => Promise<void>
  preview: (includeDatabase: boolean) => DiagnosticsPreview
  save: (path: string, includeDatabase: boolean) => Promise<{ path: string }>
  logRendererError: (message: string) => void
  now?: () => number
}) {
  const now = options.now ?? (() => performance.now())
  let lastRendererError = -Infinity
  return {
    openLogFolder: (payload: unknown) => validatedAsync(diagnosticsOpenLogFolderSchema, payload, async () => {
      await options.openLogFolder()
      return null
    }),
    save: (payload: unknown, pickPath: () => Promise<string | undefined>) =>
      validatedAsync(diagnosticsSaveSchema, payload, async ({ action, includeDatabase }) => {
        if (action === 'preview') return options.preview(includeDatabase)
        const picked = await pickPath()
        if (!picked) return null
        const path = await writeConfirmedFile(picked, '.zip', async (target) => {
          await options.save(target, includeDatabase)
        })
        return { path }
      }),
    rendererError: (payload: unknown) => {
      const timestamp = now()
      // One accepted error per second across renderer reloads.
      if (timestamp - lastRendererError < 1000) return
      const parsed = rendererErrorSchema.safeParse(payload)
      if (!parsed.success) return
      lastRendererError = timestamp
      options.logRendererError(parsed.data)
    },
  }
}

export function createGraphicsHandlers(options: {
  status: () => GraphicsStatus
  setPreference: (preference: GpuPreference) => void
  restart: () => void
}) {
  return {
    status: (payload: unknown) => validated(graphicsStatusSchema, payload, options.status),
    command: (payload: unknown) => validated(graphicsCommandSchema, payload, (input) => {
      if (input.action === 'set') options.setPreference(input.preference)
      else options.restart()
      return null
    }),
  }
}

export function createDataSafetyHandlers(options: {
  listBackups: () => DatabaseBackup[]
  restore: (id: string) => Promise<null>
  exportProject: (input: ProjectExportInput) => Promise<{ path: string } | null>
  importProject: () => Promise<Project | null>
}) {
  async function withMessage<T>(action: string, task: () => T | Promise<T>): Promise<T> {
    try {
      return await task()
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ConflictError) throw error
      throw new Error(`Could not ${action}. ${(error as Error).message}`, { cause: error })
    }
  }
  return {
    [Channels.databaseListBackups]: (payload: unknown) =>
      validatedAsync(z.undefined(), payload, () => withMessage('list database copies', options.listBackups), true),
    [Channels.databaseRestore]: (payload: unknown) =>
      validatedAsync(restoreDatabaseSchema, payload, ({ id }) => withMessage('restore the database', () => options.restore(id)), true),
    [Channels.projectsExport]: (payload: unknown) =>
      validatedAsync(projectExportSchema, payload, (input) => withMessage('export the project', () => options.exportProject(input)), true),
    [Channels.projectsImport]: (payload: unknown) =>
      validatedAsync(z.undefined(), payload, () => withMessage('import the project', options.importProject), true),
  }
}

export function createRecordingCsvHandler(exporter: Pick<ReturnType<typeof createRecordingCsvExporter>, 'export'>) {
  return (payload: unknown, pickPath: PickCsvPath) =>
    validatedAsync(recordingCsvSchema, payload, (query) => exporter.export(query, pickPath))
}

export function createRecordingHandlers(store: RecordingStore) {
  return {
    [Channels.runsListRecent]: (p: unknown) => validatedAsync(listRunsSchema, p, (i) => store.listRecent(i.limit)),
    [Channels.runsList]: (p: unknown) => validatedAsync(projectIdSchema, p, (i) => store.list(i.id)),
    [Channels.runsGet]: (p: unknown) => validatedAsync(recordingIdSchema, p, (i) => store.get(i.id)),
    [Channels.runsDelete]: (p: unknown) => validated(recordingIdSchema, p, (i) => store.delete(i.id)),
    [Channels.recordingSummary]: (p: unknown) =>
      validatedAsync(recordingIdSchema, p, (i) => store.read(i.id, (reader) => reader.summary())),
    [Channels.recordingReadSamples]: (p: unknown) =>
      validatedAsync(recordingSampleSchema, p, (i) => store.read(i.id, (reader) => reader.readSamples(i))),
    [Channels.recordingReadRequests]: (p: unknown) =>
      validatedAsync(recordingIdSchema, p, (i) => store.read(i.id, (reader) => reader.readRequests())),
    [Channels.recordingTotalSize]: (p: unknown) => validatedAsync(z.undefined(), p, () => store.totalSize()),
  }
}

export function createRecordingVerifyHandlers(store: RecordingStore, binaryPath: string) {
  const active = new Map<string, { sender: WebContents; controller: AbortController }>()
  return {
    [Channels.recordingVerify]: (sender: WebContents, payload: unknown) =>
      validatedAsync(recordingVerifySchema, payload, async ({ id, requestId }) => {
        if (active.has(requestId)) throw new ValidationError('Verification already active')
        const controller = new AbortController()
        const cancel = () => controller.abort()
        active.set(requestId, { sender, controller })
        sender.once('destroyed', cancel)
        try {
          return await store.read(id, (reader) => verifyRecording(reader, binaryPath, controller.signal, (step, totalSteps) => {
            if (!sender.isDestroyed()) sender.send(Channels.recordingVerifyProgress, { requestId, step, totalSteps })
          }))
        } finally {
          sender.removeListener('destroyed', cancel)
          active.delete(requestId)
        }
      }),
    [Channels.recordingVerifyCancel]: (sender: WebContents, payload: unknown) =>
      validated(recordingVerifyCancelSchema, payload, ({ requestId }) => {
        const job = active.get(requestId)
        if (job?.sender === sender) job.controller.abort()
        return null
      }),
  }
}

/** The renderer's view flag is never part of an engine step or recorded request line. */
export async function flightStepForView(engine: EngineForFlight, payload: unknown, recorder?: SessionRecorder): Promise<IpcResult<FlightStepResult>> {
  const view = flightLiveViewSchema.safeParse(payload)
  if (!view.success) return flightStep(engine, payload, recorder)
  const { live, ...step } = view.data
  const result = await flightStep(engine, step, recorder)
  if (result.ok && !live) delete result.data.samples
  return result
}

export async function flightStartForView(engine: EngineForFlight, payload: unknown, recorder?: SessionRecorder): Promise<IpcResult<FlightStartResult>> {
  const view = flightLiveViewSchema.safeParse(payload)
  if (!view.success) return flightStart(engine, payload, recorder)
  const { live, ...start } = view.data
  const parsed = flightStartSchema.safeParse(start)
  if (!parsed.success) return flightStart(engine, start, recorder)
  const { recording } = parsed.data
  const input = recording ? { ...start, recording: { ...recording, live: true } }
    : live ? { ...start, sampleEverySteps: RECORD_EVERY_STEPS } : start
  const result = await flightStart(engine, input, recorder)
  // Keep the engine's column order for a live panel opened after a sampled run starts.
  if (result.ok && !(live || recording?.live)) delete result.data.samples
  return result
}

export async function handlePrintReportPdf(payload: unknown, print: () => Promise<{ path: string } | null>): Promise<IpcResult<{ path: string } | null>> {
  const parsed = printReportPdfSchema.safeParse(payload)
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: 'Printing takes no arguments.' } }
  try {
    return { ok: true, data: await print() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { code: 'INTERNAL', message: 'Could not save the report PDF. ' + message } }
  }
}

export function createTerrainHandlers(repos: Repositories, dir: string) {
  return {
    [Channels.terrainList]: (p: unknown) => validated(z.undefined(), p, () => repos.terrain.list()),
    [Channels.terrainRead]: (p: unknown) => validated(assetIdSchema, p, (id) => readTerrainFile(id, dir, repos)),
  }
}

export async function importTerrain(
  payload: unknown,
  pickFile: () => Promise<string | undefined>,
  dir: string,
  repos: Repositories,
): Promise<IpcResult<TerrainAssetInfo | null>> {
  const parsed = terrainImportSchema.safeParse(payload)
  if (!parsed.success) {
    return { ok: false, error: { code: 'VALIDATION', message: describeIssues(parsed.error.issues, payload) } }
  }
  const path = await pickFile()
  return path ? importTerrainFile(path, dir, repos, parsed.data) : { ok: true, data: null }
}

/**
 * Pure handler table (channel → function). Kept free of Electron imports so it
 * can be unit tested; main binds it to `ipcMain.handle` (and the sync save to
 * `ipcMain.on`).
 */
export function createHandlers(
  repos: Repositories,
  getSystemStatus: () => Omit<SystemStatus, 'componentCount'>,
): Record<string, (payload: unknown) => IpcResult<unknown>> {
  const tuningSettings = (id: string) => {
    const overrides = repos.tuning.get(id)
    return { table: CONTROLLER_PARAMS, overrides, effective: effectiveParams(overrides) }
  }
  return {
    [Channels.projectsList]: () => run(() => repos.projects.list()),
    [Channels.projectsCreate]: (p) => validated(createProjectSchema, p, (i) => repos.projects.create(i)),
    [Channels.projectsRename]: (p) => validated(renameProjectSchema, p, (i) => repos.projects.rename(i)),
    [Channels.projectsDelete]: (p) =>
      validated(projectIdSchema, p, (i) => {
        repos.projects.delete(i.id)
        return null
      }),
    [Channels.systemStatus]: () =>
      run(() => ({ ...getSystemStatus(), componentCount: repos.components.count() })),
    [Channels.assemblyLoad]: (p) => validated(projectIdSchema, p, (i) => repos.assemblies.load(i.id)),
    [Channels.assemblySave]: (p) => validated(saveAssemblySchema, p, (i) => repos.assemblies.save(i)),
    [Channels.tuningGet]: (p) => validated(projectIdSchema, p, (i) => tuningSettings(i.id)),
    [Channels.tuningSet]: (p) => {
      const parsed = setTuningSchema.safeParse(p)
      if (!parsed.success) {
        const errors = parsed.error.issues.map((issue) => ({
          name: String(issue.path[0] === 'overrides' ? (issue.path[1] ?? '') : (issue.path[0] ?? '')),
          message: issue.message,
          ...(issue.code === 'custom' && issue.params?.related ? { related: issue.params.related as string[] } : {}),
        }))
        return { ok: false, error: { code: 'VALIDATION', message: errors.map((e) => e.message).join('; '), errors } }
      }
      return run(() => {
        repos.tuning.set(parsed.data.id, parsed.data.overrides)
        return tuningSettings(parsed.data.id)
      })
    },
    [Channels.tuningReset]: (p) => validated(projectIdSchema, p, (i) => {
      repos.tuning.clear(i.id)
      return tuningSettings(i.id)
    }),
    [Channels.assetsList]: () => run(() => repos.assets.list()),
    [Channels.componentsList]: (p) => componentValidated(listComponentsSchema, p, (i) => repos.components.list(i.category)),
    [Channels.componentsGet]: (p) => componentValidated(componentIdSchema, p, (i) => repos.components.get(i.id)),
    [Channels.componentsCreate]: (p) =>
      componentValidated(componentInputSchema, p, (i) => repos.components.create(i)),
    [Channels.componentsUpdate]: (p) =>
      componentValidated(updateComponentSchema, p, (i) => repos.components.update(i.id, i.baseRevision, i.input)),
    [Channels.componentsDelete]: (p) =>
      componentValidated(componentIdSchema, p, (i) => {
        repos.components.delete(i.id)
        return null
      }),
    [Channels.componentsDuplicate]: (p) => componentValidated(componentIdSchema, p, (i) => repos.components.duplicate(i.id)),
    [Channels.componentsSetFill]: (p) =>
      componentValidated(setFillSchema, p, (i) => {
        if (i.spec === null) return repos.components.setFill(i.id, i.key, null)
        const f = fieldDef(repos.components.get(i.id).category, i.key)
        if (!isOverridable(f)) return repos.components.setFill(i.id, i.key, i.spec as SpecValue) // refused there, with the reason
        const parsed = userSpecSchema(f).safeParse(i.spec)
        if (!parsed.success) throw new ValidationError(`${f.label}: ${parsed.error.issues.map((x) => x.message).join('; ')}`)
        return repos.components.setFill(i.id, i.key, parsed.data as SpecValue)
      }),
  }
}

function validated<S extends z.ZodType, T>(
  schema: S,
  payload: unknown,
  fn: (input: z.infer<S>) => T,
): IpcResult<T> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join('; ')
    return { ok: false, error: { code: 'VALIDATION', message } }
  }
  return run(() => fn(parsed.data))
}

async function validatedAsync<S extends z.ZodType, T>(
  schema: S, payload: unknown, fn: (input: z.infer<S>) => Promise<T>, showDetails = false,
): Promise<IpcResult<T>> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: parsed.error.issues.map((i) => i.message).join('; ') } }
  try {
    return { ok: true, data: await fn(parsed.data) }
  } catch (error) {
    return handlerError(error, showDetails)
  }
}

/** Like `validated`, with messages that name the specification field. */
function componentValidated<S extends z.ZodType, T>(schema: S, payload: unknown, fn: (input: z.infer<S>) => T): IpcResult<T> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: describeIssues(parsed.error.issues, payload) } }
  return run(() => fn(parsed.data))
}

function run<T>(fn: () => T): IpcResult<T> {
  try {
    return { ok: true, data: fn() }
  } catch (e) {
    return handlerError(e)
  }
}

function handlerError(e: unknown, showDetails = false): IpcResult<never> {
  if (e instanceof NotFoundError) return { ok: false, error: { code: 'NOT_FOUND', message: e.message } }
  if (e instanceof ConflictError) return { ok: false, error: { code: 'CONFLICT', message: e.message } }
  if (e instanceof TuningValidationError) return { ok: false, error: { code: 'VALIDATION', message: e.message, errors: e.errors } }
  if (e instanceof ValidationError || e instanceof RecordingQueryError || e instanceof RecordingFormatError) {
    return { ok: false, error: { code: 'VALIDATION', message: e.message } }
  }
  console.error('[ipc] handler failed', e)
  return { ok: false, error: { code: 'INTERNAL', message: showDetails && e instanceof Error ? e.message : 'Unexpected error. See application log.' } }
}
