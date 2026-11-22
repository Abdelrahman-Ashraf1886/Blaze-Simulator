import { CircleHelp, CircleX, ClipboardCopy, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AssemblyDocument } from '../../../electron/ipc/contract'
import { Button } from '@/components/ui/button'
import { cn, formatTimestamp } from '@/lib/utils'
import { report, summary, type Finding, type Severity } from '@/domain/checks'
import type { FrameGeometry } from '@/three/frame-geometry'
import { FRAME_PART_ID } from '../../../electron/ipc/contract'
import { useAssets } from './asset-store'
import { useComponentIndex } from './component-index'
import { allFindings } from './findings'
import { allowOverlap, useLiveDoc } from './InterferencePanel'
import { useWorkshopView } from './view-store'

export const SEVERITY: Record<Severity, { icon: LucideIcon; tone: string; label: string }> = {
  error: { icon: CircleX, tone: 'text-fault', label: 'Error' },
  warning: { icon: TriangleAlert, tone: 'text-warn', label: 'Warning' },
  'cannot-check': { icon: CircleHelp, tone: 'text-fg-subtle', label: 'Cannot check' },
}

/**
 * Findings for the current assembly, wiring included (recomputed when the document or
 * the library changes, and during a gizmo drag after a short pause).
 */
export function useFindings(doc: AssemblyDocument, geo: FrameGeometry): Finding[] {
  const components = useComponentIndex()
  const tolerance = useWorkshopView((s) => s.balanceTolerance)
  const assets = useAssets((s) => s.assets)
  const live = useLiveDoc(doc)
  return useMemo(() => allFindings(live, geo, components, tolerance, assets), [live, geo, components, tolerance, assets])
}

/** The two owners of an interference error, from its id `interference:<a>,<b>`. */
function overlapPair(f: Finding, doc: AssemblyDocument) {
  if (f.rule !== 'interference' || f.severity !== 'error') return null
  const [a, b] = f.id.slice('interference:'.length).split(',') as [string, string]
  const name = (id: string) => (id === FRAME_PART_ID ? 'Frame' : (doc.parts.find((p) => p.id === id)?.name ?? id))
  return { a, b, aName: name(a), bName: name(b) }
}

const select = (f: Finding) => {
  if (f.partIds[0]) useWorkshopView.getState().selectPart(f.partIds[0])
}

/** The Checks section of the workshop's left panel. */
export function ChecksPanel({ doc, geo, projectName }: { doc: AssemblyDocument; geo: FrameGeometry; projectName: string }) {
  const findings = useFindings(doc, geo)
  const [copied, setCopied] = useState<string | null>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report(projectName, findings, formatTimestamp(new Date().toISOString())))
      setCopied('Report copied as Markdown')
    } catch (e) {
      setCopied(`Could not copy: ${(e as Error).message}`)
    }
  }
  return (
    <div data-testid="checks">
      {findings.length === 0 ? (
        <p className="border-t border-line py-3 text-[12.5px] text-fg-subtle" data-testid="checks-ok">
          {doc.parts.length === 0 ? 'Add parts to check them.' : 'No problems found. Link parts to library components to check more.'}
        </p>
      ) : (
        <ul className="border-t border-line">
          {findings.map((f) => {
            const s = SEVERITY[f.severity]
            const Icon = s.icon
            const pair = overlapPair(f, doc)
            return (
              <li key={f.id} className={pair ? 'relative' : undefined}>
                <button
                  type="button"
                  data-testid="finding"
                  data-severity={f.severity}
                  data-rule={f.rule}
                  onClick={() => select(f)}
                  disabled={f.partIds.length === 0}
                  title={f.partIds.length ? 'Select the parts involved' : undefined}
                  className="flex w-full gap-2 border-b border-line/60 py-1.5 text-left text-[12.5px] leading-snug hover:bg-hover/50 disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <Icon className={cn('mt-0.5 size-3.5 shrink-0', s.tone)} aria-label={s.label} />
                  <span className={cn('min-w-0 text-fg-muted', pair && 'pr-12')}>{f.message}</span>
                </button>
                {pair && (
                  <button
                    type="button"
                    data-testid="allow-overlap"
                    title={`Accept this overlap of ${pair.aName} and ${pair.bName} (saved with the project; undo restores it)`}
                    onClick={() => allowOverlap(pair, true)}
                    className="absolute right-0 top-1.5 text-[12px] text-fg-subtle underline hover:text-fg"
                  >
                    Allow
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => void copy()} data-testid="copy-report">
          <ClipboardCopy /> Copy report
        </Button>
        {copied && (
          <span role="status" className="truncate text-[12px] text-fg-subtle">
            {copied}
          </span>
        )}
      </div>
    </div>
  )
}

/** Status strip: "1 error · 2 warnings"; a click selects the parts of the first, most severe finding. */
export function ChecksStatus({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const findings = useFindings(doc, geo)
  const s = summary(findings)
  if (s.error + s.warning === 0) return null
  const text = [s.error && `${s.error} error${s.error === 1 ? '' : 's'}`, s.warning && `${s.warning} warning${s.warning === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      type="button"
      data-testid="status-checks"
      onClick={() => select(findings[0]!)}
      title={findings[0]!.message}
      className={cn('num hover:underline', s.error ? 'text-fault' : 'text-warn')}
    >
      {text}
    </button>
  )
}
