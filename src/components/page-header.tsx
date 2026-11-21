import type { ReactNode } from 'react'

/** Sticky page title bar; content width matches the page body below it. */
export function PageHeader({ title, count, actions }: { title: string; count?: number; actions?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg">
      <div className="mx-auto flex h-12 w-full max-w-[1600px] items-center justify-between gap-4 px-6">
        <h1 className="flex min-w-0 items-baseline gap-2 text-[15px] font-semibold">
          <span className="truncate">{title}</span>
          {count !== undefined && <span className="num font-normal text-fg-subtle">{count}</span>}
        </h1>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    </header>
  )
}
