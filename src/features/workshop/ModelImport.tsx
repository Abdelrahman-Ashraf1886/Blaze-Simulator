import { FileUp, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  MODEL_UNITS,
  PART_KINDS,
  type AssemblyPart,
  type AssetInfo,
  type ModelUnits,
  type PartKind,
  type UpAxis,
} from '../../../electron/ipc/contract'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { placeModel, UNIT_LABELS } from '@/three/model-units'
import { getApi, unwrap } from '@/services/api'
import { PART_LABELS, addModelPart, type AttachTarget } from './assembly-ops'
import { useAssembly } from './assembly-store'
import { useAssets } from './asset-store'
import { toMm } from './frame-values'
import { useWorkshopView } from './view-store'

export const formatSize = (extent: readonly number[]) => extent.map((v) => toMm(v)).join(' × ')

/** Below 1 mm or above 3 m along any axis, the unit choice is probably wrong for a drone part. */
function scaleHint(extent: readonly number[]): string | null {
  if (Math.max(...extent) > 3) return 'Larger than 3 m. Check the units.'
  if (Math.min(...extent.filter((v) => v > 0)) < 0.001) return 'Smaller than 1 mm along one axis. Check the units.'
  return null
}

/**
 * "Import model…": main shows the file dialog and validates the file; this then
 * asks how to interpret it (units, up axis) with a live size preview, and adds
 * a part that displays it. The import is one undoable edit.
 */
export function ModelImport({ target, frameTop }: { target: AttachTarget; frameTop: number }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asset, setAsset] = useState<AssetInfo | null>(null)

  const choose = async () => {
    setBusy(true)
    setError(null)
    try {
      const info = unwrap(await getApi().assets.import())
      if (info) {
        useAssets.getState().add(info)
        setAsset(info)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2">
      <Button size="sm" className="w-full" onClick={() => void choose()} disabled={busy} data-testid="import-model">
        <FileUp /> {busy ? 'Reading file…' : 'Import model (.glb, .gltf)…'}
      </Button>
      {error && (
        <p role="alert" data-testid="import-error" className="mt-1.5 text-[12px] text-fault">
          {error}
        </p>
      )}
      {asset && (
        <ImportOptions
          key={asset.id}
          asset={asset}
          onClose={() => setAsset(null)}
          onImport={(opts) => {
            let created: AssemblyPart | null = null
            useAssembly.getState().edit(`Import ${asset.filename}`, (d) => {
              const r = addModelPart(d, asset, opts, target, frameTop, useAssets.getState().assets)
              created = r.part
              return r.doc
            })
            if (created) useWorkshopView.getState().selectPart((created as AssemblyPart).id)
            setAsset(null)
          }}
        />
      )}
    </div>
  )
}

function ImportOptions({
  asset,
  onClose,
  onImport,
}: {
  asset: AssetInfo
  onClose: () => void
  onImport: (opts: { kind: PartKind; units: ModelUnits; upAxis: UpAxis }) => void
}) {
  // glTF 2.0 specifies metres and +Y up, so those are the defaults.
  const [units, setUnits] = useState<ModelUnits>('m')
  const [upAxis, setUpAxis] = useState<UpAxis>('y')
  const [kind, setKind] = useState<PartKind>('payload')
  const { extent } = placeModel(asset.bounds, units, upAxis)
  const hint = scaleHint(extent)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Import model" description={asset.filename}>
        <div className="space-y-3" data-testid="import-options">
          <OptionRow label="Units in file">
            <Segmented
              label="Units in file"
              value={units}
              options={MODEL_UNITS.map((u) => ({ value: u, label: UNIT_LABELS[u] }))}
              onChange={setUnits}
            />
          </OptionRow>
          <OptionRow label="Up axis in file">
            <Segmented
              label="Up axis in file"
              value={upAxis}
              options={[
                { value: 'y', label: '+Y (glTF)' },
                { value: 'z', label: '+Z (CAD)' },
              ]}
              onChange={setUpAxis}
            />
          </OptionRow>
          <OptionRow label="Kind">
            <select
              aria-label="Kind of part"
              value={kind}
              onChange={(e) => setKind(e.target.value as PartKind)}
              className="h-7 w-[150px] rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-[12.5px] text-fg"
            >
              {PART_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PART_LABELS[k]}
                </option>
              ))}
            </select>
          </OptionRow>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-line pt-3 text-[12.5px]">
            <dt className="text-fg-muted">Size X × Y × Z</dt>
            <dd className="num text-right" data-testid="import-size">
              {formatSize(extent)} mm
            </dd>
            <dt className="text-fg-muted">Triangles</dt>
            <dd className="num text-right">{asset.triangles.toLocaleString('en-US')}</dd>
            <dt className="text-fg-muted">File</dt>
            <dd className="num text-right">{(asset.bytes / 1024).toFixed(0)} KB</dd>
          </dl>
          {[...asset.warnings, ...(hint ? [hint] : [])].map((w) => (
            <p key={w} className="flex gap-1.5 text-[12px] text-warn" data-testid="import-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" /> {w}
            </p>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button variant="primary" onClick={() => onImport({ kind, units, upAxis })}>
              Add to assembly
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function OptionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-[12.5px] text-fg-muted">{label}</span>
      {children}
    </div>
  )
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-[var(--radius-sm)] border border-line-strong p-px">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-6 rounded-[2px] px-2.5 text-[12px] font-medium',
            value === o.value ? 'bg-hover text-accent' : 'text-fg-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
