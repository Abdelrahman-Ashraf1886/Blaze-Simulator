import { z } from 'zod'
import { CONTROLLER_PARAMS, effectiveParams } from '../../src/domain/controller-params'
import { Channels, type IpcResult, type SystemStatus, type TerrainAssetInfo } from './contract'
import {
  assetIdSchema,
  createProjectSchema,
  listRunsSchema,
  projectIdSchema,
  printReportPdfSchema,
  recordingIdSchema,
  recordingSampleSchema,
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
import { RecordingFormatError } from '../main/telemetry/format'
import { RecordingQueryError } from '../main/telemetry/reader'
import type { RecordingStore } from '../main/telemetry/store'

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
  schema: S, payload: unknown, fn: (input: z.infer<S>) => Promise<T>,
): Promise<IpcResult<T>> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: parsed.error.issues.map((i) => i.message).join('; ') } }
  try {
    return { ok: true, data: await fn(parsed.data) }
  } catch (error) {
    return handlerError(error)
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

function handlerError(e: unknown): IpcResult<never> {
  if (e instanceof NotFoundError) return { ok: false, error: { code: 'NOT_FOUND', message: e.message } }
  if (e instanceof ConflictError) return { ok: false, error: { code: 'CONFLICT', message: e.message } }
  if (e instanceof TuningValidationError) return { ok: false, error: { code: 'VALIDATION', message: e.message, errors: e.errors } }
  if (e instanceof ValidationError || e instanceof RecordingQueryError || e instanceof RecordingFormatError) {
    return { ok: false, error: { code: 'VALIDATION', message: e.message } }
  }
  console.error('[ipc] handler failed', e)
  return { ok: false, error: { code: 'INTERNAL', message: 'Unexpected error. See application log.' } }
}
