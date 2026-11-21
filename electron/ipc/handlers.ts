import type { z } from 'zod'
import { Channels, type IpcResult, type SystemStatus } from './contract'
import {
  createProjectSchema,
  listRunsSchema,
  projectIdSchema,
  renameProjectSchema,
  saveAssemblySchema,
} from './schemas'
import {
  componentIdSchema,
  componentInputSchema,
  describeIssues,
  listComponentsSchema,
  updateComponentSchema,
} from './component-schemas'
import { ConflictError, NotFoundError, ValidationError, type Repositories } from '../main/db/repositories'

/**
 * Pure handler table (channel → function). Kept free of Electron imports so it
 * can be unit tested; main binds it to `ipcMain.handle` (and the sync save to
 * `ipcMain.on`).
 */
export function createHandlers(
  repos: Repositories,
  getSystemStatus: () => Omit<SystemStatus, 'componentCount'>,
): Record<string, (payload: unknown) => IpcResult<unknown>> {
  return {
    [Channels.projectsList]: () => run(() => repos.projects.list()),
    [Channels.projectsCreate]: (p) => validated(createProjectSchema, p, (i) => repos.projects.create(i)),
    [Channels.projectsRename]: (p) => validated(renameProjectSchema, p, (i) => repos.projects.rename(i)),
    [Channels.projectsDelete]: (p) =>
      validated(projectIdSchema, p, (i) => {
        repos.projects.delete(i.id)
        return null
      }),
    [Channels.runsListRecent]: (p) => validated(listRunsSchema, p, (i) => repos.runs.listRecent(i.limit)),
    [Channels.systemStatus]: () =>
      run(() => ({ ...getSystemStatus(), componentCount: repos.components.count() })),
    [Channels.assemblyLoad]: (p) => validated(projectIdSchema, p, (i) => repos.assemblies.load(i.id)),
    [Channels.assemblySave]: (p) => validated(saveAssemblySchema, p, (i) => repos.assemblies.save(i)),
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
    if (e instanceof NotFoundError) return { ok: false, error: { code: 'NOT_FOUND', message: e.message } }
    if (e instanceof ConflictError) return { ok: false, error: { code: 'CONFLICT', message: e.message } }
    if (e instanceof ValidationError) return { ok: false, error: { code: 'VALIDATION', message: e.message } }
    console.error('[ipc] handler failed', e)
    return { ok: false, error: { code: 'INTERNAL', message: 'Unexpected error. See application log.' } }
  }
}
