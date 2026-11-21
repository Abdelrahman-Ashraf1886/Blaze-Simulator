import { Check, Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { FRAME_SPECS, type Project } from '../../../electron/ipc/contract'
import { FrameGlyph } from '@/components/frame-glyph'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/section'
import { Table, Td, Th } from '@/components/table'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/field'
import { formatTimestamp } from '@/lib/utils'
import { useProjects } from '@/stores/projects'
import { CreateProjectDialog } from './CreateProjectDialog'

export function ProjectsPage() {
  const { projects, error, loading } = useProjects()
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    void useProjects.getState().load()
  }, [])

  async function act(fn: () => Promise<void>) {
    setActionError(null)
    try {
      await fn()
    } catch (e) {
      setActionError((e as Error).message)
    }
  }

  return (
    <>
      <PageHeader title="Projects" count={projects.length} actions={<CreateProjectDialog />} />
      <div className="mx-auto w-full max-w-[1600px] px-6 pb-10 pt-5">
        {actionError && (
          <p role="alert" className="mb-3 text-[12.5px] text-fault">
            {actionError}
          </p>
        )}
        <section className="@container" data-testid="projects-table" aria-label="All projects">
          {error ? (
            <EmptyState>Could not load projects: {error}</EmptyState>
          ) : projects.length === 0 ? (
            <EmptyState>{loading ? 'Loading…' : 'No projects yet.'}</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-full">Name</Th>
                  <Th className="hidden @min-[480px]:table-cell">Frame</Th>
                  <Th className="hidden @min-[720px]:table-cell">Created</Th>
                  <Th>Modified</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className="group hover:bg-hover/50" data-testid="project-row">
                    <Td className="max-w-0">
                      {editing?.id === p.id ? (
                        <form
                          className="flex items-center gap-1"
                          onSubmit={(e) => {
                            e.preventDefault()
                            void act(async () => {
                              await useProjects.getState().rename(p.id, editing.name)
                              setEditing(null)
                            })
                          }}
                        >
                          <Input
                            autoFocus
                            aria-label="Project name"
                            className="h-7"
                            value={editing.name}
                            maxLength={80}
                            onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                            onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                          />
                          <Button size="icon" variant="ghost" type="submit" aria-label="Save name">
                            <Check />
                          </Button>
                          <Button size="icon" variant="ghost" type="button" aria-label="Cancel" onClick={() => setEditing(null)}>
                            <X />
                          </Button>
                        </form>
                      ) : (
                        <Link
                          to={`/workshop/${p.id}`}
                          className="flex min-w-0 items-center gap-2.5 hover:text-accent"
                          title={`Open ${p.name} in the workshop`}
                        >
                          <FrameGlyph type={p.frameType} className="size-4 shrink-0 text-fg-subtle" />
                          <span className="truncate">{p.name}</span>
                        </Link>
                      )}
                    </Td>
                    <Td className="hidden text-fg-muted @min-[480px]:table-cell">
                      {FRAME_SPECS[p.frameType].name}
                      <span className="ml-1.5 text-fg-subtle">· {FRAME_SPECS[p.frameType].rotors} rotors</span>
                    </Td>
                    <Td className="num hidden text-fg-muted @min-[720px]:table-cell">{formatTimestamp(p.createdAt)}</Td>
                    <Td className="num text-fg-muted">{formatTimestamp(p.updatedAt)}</Td>
                    <Td className="py-0 text-right">
                      <div className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Rename ${p.name}`}
                          title="Rename"
                          onClick={() => setEditing({ id: p.id, name: p.name })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete ${p.name}`}
                          title="Delete"
                          onClick={() => setDeleting(p)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent
          title="Delete project?"
          description={`“${deleting?.name ?? ''}” and its simulation history will be permanently deleted. This can’t be undone.`}
        >
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() =>
                void act(async () => {
                  if (deleting) await useProjects.getState().remove(deleting.id)
                  setDeleting(null)
                })
              }
            >
              Delete project
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
