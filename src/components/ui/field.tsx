import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-8 w-full min-w-0 rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-2.5 text-[13px] text-fg placeholder:text-fg-subtle hover:border-fg-subtle/70 focus:border-accent focus:outline-none aria-invalid:border-fault',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('mb-1.5 block text-[12px] font-medium text-fg-muted', className)} {...props} />
}
