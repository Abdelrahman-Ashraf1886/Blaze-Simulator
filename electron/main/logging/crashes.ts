import type { MessageBoxOptions, RenderProcessGoneDetails, WebContents } from 'electron'
import { formatLog, type Logger } from './logger'

export function createCrashHandlers(
  logger: Pick<Logger, 'write' | 'flush' | 'path'>,
  ui: {
    showError: (title: string, message: string) => void
    offerReload: (contents: WebContents, options: MessageBoxOptions) => Promise<boolean>
  },
) {
  let showedMainError = false
  const offeringReload = new WeakSet<WebContents>()

  function mainError(event: string, error: unknown) {
    logger.write('error', 'main', `${event}: ${formatLog(error)}`)
    if (showedMainError) return
    showedMainError = true
    void logger.flush().then(() => {
      ui.showError('Blaze UAV encountered an error', `See the application log at:\n${logger.path}`)
    }).catch((error: unknown) => logger.write('error', 'main', `Crash dialog failed: ${formatLog(error)}`))
  }

  return {
    uncaughtException: (error: unknown) => mainError('uncaughtException', error),
    unhandledRejection: (reason: unknown) => mainError('unhandledRejection', reason),
    async rendererGone(contents: WebContents, details: RenderProcessGoneDetails): Promise<void> {
      logger.write('error', 'renderer', `render-process-gone: ${details.reason} (exit code ${details.exitCode})`)
      if (details.reason === 'clean-exit' || offeringReload.has(contents)) return
      offeringReload.add(contents)
      try {
        const reload = await ui.offerReload(contents, {
          type: 'error',
          title: 'Blaze UAV renderer stopped',
          message: 'The window stopped working.',
          detail: `Reason: ${details.reason}\nSee the application log at:\n${logger.path}`,
          buttons: ['Reload', 'Dismiss'],
          defaultId: 0,
          cancelId: 1,
        })
        if (reload && !contents.isDestroyed() && contents.isCrashed()) contents.reload()
      } catch (error) {
        logger.write('error', 'main', `Renderer recovery failed: ${formatLog(error)}`)
      } finally {
        offeringReload.delete(contents)
      }
    },
    childGone(details: { type: string; reason: string; exitCode: number; name?: string }): void {
      if (details.reason === 'clean-exit') return
      const name = details.name ? ` (${details.name})` : ''
      logger.write('error', 'main', `child-process-gone: ${details.type}${name}: ${details.reason} (exit code ${details.exitCode})`)
    },
  }
}
