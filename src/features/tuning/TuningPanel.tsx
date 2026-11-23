import { useEffect, useId, useState } from 'react'
import { Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { CONTROLLER_PARAM_GROUPS, CONTROLLER_PARAMS, type ParamError, type TuningOverrides } from '@/domain/controller-params'
import { getApi } from '@/services/api'
import { ExactSignalsNotice } from './tuning-notice'
import { documentedRange, readOverrides, tuningInputClass } from './tuning-values'

export interface TuningPanelProps {
  projectId: string
  gainsAffectFlights: boolean
}

export function TuningPanel(props: TuningPanelProps) {
  return <ProjectTuning key={props.projectId} {...props} />
}

function ProjectTuning({ projectId, gainsAffectFlights }: TuningPanelProps) {
  const id = useId()
  const [saved, setSaved] = useState<TuningOverrides | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<'save' | 'reset' | null>(null)
  const [ipcError, setIpcError] = useState<{ message: string; errors?: ParamError[] } | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)

  function accept(overrides: TuningOverrides) {
    setSaved(overrides)
    setDraft(Object.fromEntries(Object.entries(overrides).map(([name, value]) => [name, String(value)])))
  }

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const result = await getApi().tuning.get(projectId)
        if (!alive) return
        if (result.ok) accept(result.data.overrides)
        else setIpcError(result.error)
      } catch (error) {
        if (alive) setIpcError({ message: String(error instanceof Error ? error.message : error) })
      }
    }
    void load()
    return () => { alive = false }
  }, [projectId, loadAttempt])

  const { overrides, dirty, validation } = readOverrides(draft, saved ?? {})
  const errors = [
    ...(validation.ok ? [] : validation.errors),
    ...(ipcError?.errors ?? []),
  ]

  async function write(action: 'save' | 'reset') {
    setPending(action)
    setIpcError(null)
    try {
      const result = action === 'save'
        ? await getApi().tuning.set({ id: projectId, overrides })
        : await getApi().tuning.reset(projectId)
      if (result.ok) accept(result.data.overrides)
      else setIpcError(result.error)
    } catch (error) {
      setIpcError({ message: String(error instanceof Error ? error.message : error) })
    } finally {
      setPending(null)
    }
  }

  function change(name: string, value: string | null) {
    setIpcError(null)
    setDraft((previous) => {
      const next = { ...previous }
      if (value === null) delete next[name]
      else next[name] = value
      return next
    })
  }

  return (
    <div className="space-y-3">
      <Section title="Controller tuning">
        <ExactSignalsNotice />
        {!gainsAffectFlights && <p className="pb-2 text-[12.5px] text-warn">Saved gains do not affect flights yet.</p>}
        {ipcError && <p role="alert" className="py-2 text-[12.5px] text-fault">{ipcError.message}</p>}
        {saved === null ? (
          ipcError
            ? <Button type="button" size="sm" onClick={() => { setIpcError(null); setLoadAttempt(loadAttempt + 1) }}>Retry load</Button>
            : <p role="status" className="py-2 text-fg-muted">Loading saved tuning…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-t border-line py-2">
            <Button type="button" variant="primary" size="sm" disabled={pending !== null || !dirty || !validation.ok} onClick={() => void write('save')}>Save</Button>
            <Button type="button" size="sm" disabled={pending !== null || (!dirty && Object.keys(saved).length === 0)} onClick={() => void write('reset')}>Reset all to PX4 defaults</Button>
            <span role="status" className="text-[12.5px] text-fg-muted">
              {pending === 'save' ? 'Saving…' : pending === 'reset' ? 'Resetting…' : dirty ? 'Unsaved changes' : 'All changes saved'}
            </span>
          </div>
        )}
      </Section>
      {CONTROLLER_PARAM_GROUPS.map((group) => (
        <Section key={group.id} title={group.label}>
          <div className="border-t border-line">
            {CONTROLLER_PARAMS.filter((param) => param.group === group.id).map((param) => {
              const field = `${id}-${param.name}`
              const messages = [...new Set(errors.filter((error) => error.name === param.name || error.related?.includes(param.name)).map((error) => error.message))]
              return (
                <div key={param.name} className="border-b border-line/60 py-1.5">
                  <div className="grid items-center gap-2 @min-[380px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                    <label htmlFor={field} className="num break-all" title={param.description}>{param.name}</label>
                    <div className="flex items-center gap-2">
                      <input id={field} className={tuningInputClass} inputMode="decimal" value={draft[param.name] ?? param.default}
                        disabled={saved === null || pending !== null}
                        aria-invalid={messages.length > 0} aria-describedby={`${field}-default ${field}-reference${messages.length ? ` ${field}-error` : ''}`}
                        onChange={(event) => change(param.name, event.target.value)} />
                      <span id={`${field}-default`} className="shrink-0 text-[11.5px] text-fg-muted">PX4 default <span className="num text-fg">{param.default}</span></span>
                      <Button type="button" size="sm" variant="ghost" aria-label={`Reset ${param.name}`}
                        disabled={saved === null || pending !== null || !(param.name in draft)}
                        onClick={() => change(param.name, null)}>Reset</Button>
                    </div>
                  </div>
                  <p id={`${field}-reference`} className="mt-1 flex flex-wrap gap-x-3 text-[11.5px] text-fg-muted" title={param.source.locator}>
                    <span>{param.unit === null ? 'Unit not documented' : <>Unit <span className="num">{param.unit}</span></>}</span>
                    <span>Range <span className="num">{documentedRange(param)}</span></span>
                  </p>
                  {messages.length > 0 && <p id={`${field}-error`} className="mt-1 text-[11.5px] text-fault">{messages.join('. ')}</p>}
                </div>
              )
            })}
          </div>
        </Section>
      ))}
    </div>
  )
}
