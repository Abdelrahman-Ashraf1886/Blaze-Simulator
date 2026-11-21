import { cn } from '@/lib/utils'
import { useAssembly, type SaveState } from './assembly-store'

const SAVE_TEXT: Record<SaveState, string> = {
  idle: '',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'All changes saved',
  error: 'Could not save',
  conflict: 'Changed elsewhere',
}

/** "All changes saved", errors with Retry, conflicts with Reload. Shared by the workshop and the Electrical Designer. */
export function SaveIndicator() {
  const state = useAssembly((s) => s.saveState)
  const error = useAssembly((s) => s.error)
  const projectId = useAssembly((s) => s.projectId)
  if (state === 'idle') return null
  return (
    <span
      data-testid="save-state"
      data-state={state}
      title={error ?? undefined}
      className={cn('flex min-w-0 items-center gap-2', (state === 'error' || state === 'conflict') && 'text-fault')}
    >
      <span className="truncate">
        {SAVE_TEXT[state]}
        {state === 'error' && error ? `: ${error}` : ''}
      </span>
      {state === 'conflict' && projectId && (
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => void useAssembly.getState().load(projectId)}
        >
          Reload
        </button>
      )}
      {state === 'error' && (
        <button type="button" className="text-accent hover:underline" onClick={() => void useAssembly.getState().flush()}>
          Retry
        </button>
      )}
    </span>
  )
}
