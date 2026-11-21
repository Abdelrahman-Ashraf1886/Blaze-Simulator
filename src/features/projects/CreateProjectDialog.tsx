import { Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { FRAME_SPECS, FRAME_TYPES, type FrameType } from '../../../electron/ipc/contract'
import { FrameGlyph } from '@/components/frame-glyph'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/field'
import { useProjects } from '@/stores/projects'

export function CreateProjectDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [frameType, setFrameType] = useState<FrameType>('quad-x')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await useProjects.getState().create({ name, frameType })
      setOpen(false)
      setName('')
      setFrameType('quad-x')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setError(null)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary" data-testid="new-project">
          <Plus /> New project
        </Button>
      </DialogTrigger>
      <DialogContent title="New project" description="The frame layout sets rotor count and arm geometry.">
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              autoFocus
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!error}
              placeholder="e.g. 5-inch survey quad"
            />
          </div>

          <fieldset>
            <legend className="mb-1.5 text-[12px] font-medium text-fg-muted">Frame layout</legend>
            <div className="grid grid-cols-3 gap-2">
              {FRAME_TYPES.map((f) => (
                <label
                  key={f}
                  className="group flex cursor-pointer flex-col items-center gap-1 rounded-[var(--radius-sm)] border border-line-strong px-2 pb-2 pt-3 hover:border-fg-subtle has-[:checked]:border-accent has-[:checked]:bg-accent/8 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent"
                >
                  <input
                    type="radio"
                    name="frame-layout"
                    value={f}
                    checked={frameType === f}
                    onChange={() => setFrameType(f)}
                    className="sr-only"
                  />
                  <FrameGlyph type={f} className="mb-1 size-9 text-fg-subtle group-has-[:checked]:text-accent" />
                  <span className="text-[12.5px] font-medium">{FRAME_SPECS[f].name}</span>
                  <span className="num text-[11px] text-fg-subtle">{FRAME_SPECS[f].rotors} rotors</span>
                </label>
              ))}
            </div>
          </fieldset>

          {error && (
            <p role="alert" className="text-[12.5px] text-fault">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
              Create project
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
