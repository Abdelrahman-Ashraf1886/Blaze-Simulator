import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/*
 * Flat data table. The wrapper bleeds 12 px past the section edges so row
 * highlights have room while cell text stays aligned with the section title.
 */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="-mx-3">
      <table className={cn('w-full border-collapse text-[13px]', className)} {...props} />
    </div>
  )
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'h-8 whitespace-nowrap border-y border-line px-3 text-left text-[12px] font-medium text-fg-subtle',
        className,
      )}
      {...props}
    />
  )
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('h-9 whitespace-nowrap border-b border-line/70 px-3', className)} {...props} />
}
