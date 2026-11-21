import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A titled region of a page. Sections are separated by whitespace and hairlines,
 * not boxed cards. Each section is a container so its contents respond to the
 * section's own width (e.g. table columns that drop out when space runs short).
 */
export function Section({
  title,
  count,
  actions,
  children,
  className,
  testId,
}: {
  title: string
  count?: number
  actions?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
}) {
  return (
    <section data-testid={testId} className={cn('@container min-w-0', className)}>
      <header className="flex h-8 items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-2 text-[13px] font-semibold">
          {title}
          {count !== undefined && <span className="num font-normal text-fg-subtle">{count}</span>}
        </h2>
        {actions}
      </header>
      {children}
    </section>
  )
}

/** Bleeds like <Table> so hairlines line up whether a section has rows or not. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="-mx-3 border-t border-line px-3 py-4 text-[12.5px] text-fg-subtle">{children}</p>
}

export function Readouts({ children }: { children: ReactNode }) {
  return <dl className="border-t border-line">{children}</dl>
}

/**
 * One labelled measurement: muted label, bright value, muted unit. Numbers use
 * the monospaced face; set `mono={false}` for word values such as a state.
 */
export function Readout({
  label,
  value,
  unit,
  title,
  mono = true,
}: {
  label: string
  value: ReactNode
  unit?: string
  title?: string
  mono?: boolean
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
      <dt className="shrink-0 text-[12.5px] text-fg-muted">{label}</dt>
      <dd className={cn('min-w-0 truncate text-right text-fg', mono ? 'num' : 'text-[12.5px]')} title={title}>
        {value}
        {unit && <span className="ml-1 text-fg-subtle">{unit}</span>}
      </dd>
    </div>
  )
}
