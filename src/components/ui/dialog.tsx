import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({
  title,
  description,
  wide = false,
  children,
}: {
  title: string
  description?: string
  /** For forms with many fields (760 px instead of 440 px). */
  wide?: boolean
  children: ReactNode
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/55 motion-safe:animate-fade-in" />
      <DialogPrimitive.Content className={`fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-32px)] ${wide ? 'w-[min(760px,calc(100vw-32px))]' : 'w-[min(440px,calc(100vw-32px))]'} -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[var(--radius-md)] border border-line-strong bg-raised shadow-[0_24px_64px_-16px_rgb(0_0_0/0.7)] motion-safe:animate-pop-in`}>
        <div className="flex items-start justify-between gap-4 px-5 pt-4">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-[14px] font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className={description ? 'mt-1 text-[12.5px] text-fg-muted' : 'sr-only'}>
              {description ?? title}
            </DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close
            className="-mr-1.5 rounded-[var(--radius-sm)] p-1 text-fg-subtle hover:bg-hover hover:text-fg"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="px-5 pb-5 pt-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
