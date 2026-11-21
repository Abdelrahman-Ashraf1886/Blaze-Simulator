import { EngineState } from '@/components/engine-state'
import { useSystem } from '@/stores/system'

/** Window-wide status line: engine health on the left, build facts on the right. */
export function StatusBar() {
  const engine = useSystem((s) => s.engine)
  const status = useSystem((s) => s.status)

  return (
    <footer
      data-testid="status-bar"
      className="flex h-6 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-t border-line bg-chrome px-3 text-[11.5px] text-fg-muted"
    >
      {engine ? <EngineState state={engine.state} prefix="Engine" /> : <span>Engine…</span>}
      {engine?.state === 'connected' && engine.latencyMs !== null && (
        <span className="num text-[11px]" title="Round trip of the last health ping">
          {engine.latencyMs.toFixed(2)} ms
        </span>
      )}
      {engine && engine.state !== 'connected' && engine.lastError && (
        <span className="min-w-0 truncate text-fg-subtle" title={engine.lastError}>
          {engine.lastError}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-4">
        {status && <span className="num text-[11px]">Schema v{status.database.schemaVersion}</span>}
        {status && <span className="num text-[11px]">v{status.app.version}</span>}
      </span>
    </footer>
  )
}
