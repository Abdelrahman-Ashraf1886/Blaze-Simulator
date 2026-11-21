import type { AssemblyDocument, AssemblyPart, PartInertia } from '../../../electron/ipc/contract'
import { inertiaProblem } from '../../../electron/ipc/inertia'
import { Readout, Readouts } from '@/components/section'
import { NumberField } from '@/components/number-field'
import { Button } from '@/components/ui/button'
import { shapeInertia, type Inertia6 } from '@/domain/mass'
import { updatePart } from './assembly-ops'
import { useAssembly } from './assembly-store'
import { useAssets } from './asset-store'
import { effectiveMass, effectiveShape, type ComponentIndex } from './links'
import { collisionShape } from './mass-input'

const LABELS = ['Ixx', 'Iyy', 'Izz', 'Ixy', 'Ixz', 'Iyz'] as const
const AXES = ['x', 'y', 'z'] as const

/** g·m² (10⁻³ kg·m²) with enough digits for small parts. */
const gm2 = (kgm2: number) => String(Math.round(kgm2 * 1e3 * 1e6) / 1e6)

const edit = (label: string, recipe: (d: AssemblyDocument) => AssemblyDocument) => useAssembly.getState().edit(label, recipe)

type Parsed = { ok: true; value: number } | { ok: false; message: string }

const parseNumber = (text: string): number | null => {
  const v = Number(text.trim().replace(',', '.'))
  return text.trim() === '' || !Number.isFinite(v) ? null : v
}

/**
 * A part's inertia in the inspector: the value derived from its size (read-only),
 * or the user's own tensor and CoM offset. Entered values are checked for physical
 * validity (positive definite, triangle inequality) before they are saved.
 */
export function InertiaEditor({ part, components }: { part: AssemblyPart; components: ComponentIndex }) {
  const assets = useAssets((s) => s.assets)
  const mass = effectiveMass(part, components)?.valueKg ?? null
  const model = part.kind === 'propeller' ? 'propeller' : 'solid'
  const derived: Inertia6 | null = mass ? shapeInertia(collisionShape(effectiveShape(part, components), assets), mass, model) : null
  const own = part.inertia ?? null
  const set = (label: string, inertia: PartInertia | null) => edit(label, (d) => updatePart(d, part.id, { inertia }))

  if (!own) {
    return (
      <div data-testid="inertia-derived">
        {derived ? (
          <>
            <Readouts>
              {LABELS.slice(0, 3).map((l, i) => (
                <Readout key={l} label={l} value={<span data-testid={`inertia-derived-${l.toLowerCase()}`}>{gm2(derived[i]!)}</span>} unit="g·m²" />
              ))}
            </Readouts>
            <p className="mt-1.5 text-[12px] text-fg-subtle">
              {model === 'propeller'
                ? 'From its mass and radius: thin blades to the tip, averaged over a turn.'
                : 'From its mass and size as a uniform solid.'}{' '}
              About its own centre, in its own axes.
            </p>
          </>
        ) : (
          <p className="border-t border-line py-1.5 text-[12px] text-fg-subtle">Needs a mass first.</p>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="mt-1"
          data-testid="inertia-enter"
          disabled={!derived}
          onClick={() => derived && set(`Enter ${part.name} inertia`, { inertia: derived, comOffset: [0, 0, 0], source: 'user' })}
        >
          Enter measured values
        </Button>
      </div>
    )
  }

  const tensorField = (i: number) => {
    const parse = (text: string): Parsed => {
      const v = parseNumber(text)
      if (v === null) return { ok: false, message: 'Enter a number' }
      const next = [...own.inertia] as Inertia6
      next[i] = v / 1e3
      const problem = inertiaProblem(next)
      return problem ? { ok: false, message: problem } : { ok: true, value: v / 1e3 }
    }
    return (
      <NumberField
        key={`${LABELS[i]}:${own.inertia[i]}`}
        id={`inertia-${LABELS[i]!.toLowerCase()}`}
        label={LABELS[i]!}
        initial={gm2(own.inertia[i]!)}
        unit="g·m²"
        width={120}
        parse={parse}
        onCommit={(v) => {
          const next = [...own.inertia] as Inertia6
          next[i] = v
          set(`Set ${part.name} ${LABELS[i]}`, { ...own, inertia: next })
        }}
      />
    )
  }
  const offsetMm = (text: string): Parsed => {
    const v = parseNumber(text)
    if (v === null) return { ok: false, message: 'Enter a number' }
    return Math.abs(v) > 1000 ? { ok: false, message: 'Within ±1000 mm' } : { ok: true, value: v / 1000 }
  }
  return (
    <div data-testid="inertia-own">
      <div className="border-t border-line">{[0, 1, 2, 3, 4, 5].map(tensorField)}</div>
      <p className="mt-2 text-[12px] font-medium text-fg-muted">Centre of mass from the shape centre</p>
      <div className="border-t border-line">
        {AXES.map((a, i) => (
          <NumberField
            key={`${a}:${own.comOffset[i]}`}
            id={`com-offset-${a}`}
            label={a.toUpperCase()}
            initial={String(Math.round(own.comOffset[i]! * 1e7) / 1e4)}
            unit="mm"
            parse={offsetMm}
            onCommit={(v) => {
              const next = [...own.comOffset] as [number, number, number]
              next[i] = v
              set(`Set ${part.name} CoM offset`, { ...own, comOffset: next })
            }}
          />
        ))}
      </div>
      <p className="mt-1.5 text-[12px] text-fg-subtle">
        Entered by you: about the part&apos;s own centre of mass, in its own axes, with Ixy = −Σ m·x·y.
      </p>
      <Button size="sm" variant="ghost" className="mt-1" data-testid="inertia-derive" onClick={() => set(`Derive ${part.name} inertia from size`, null)}>
        Use values from size
      </Button>
    </div>
  )
}
