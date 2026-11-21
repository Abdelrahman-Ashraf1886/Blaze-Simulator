import { create } from 'zustand'
import type { CreateProjectInput, DesktopApi, Project } from '../../electron/ipc/contract'
import { getApi, unwrap } from '../services/api'

interface ProjectsState {
  projects: Project[]
  loading: boolean
  error: string | null
  load(): Promise<void>
  create(input: CreateProjectInput): Promise<Project>
  rename(id: string, name: string): Promise<void>
  remove(id: string): Promise<void>
}

export function createProjectsStore(api: () => DesktopApi = getApi) {
  return create<ProjectsState>((set, get) => ({
    projects: [],
    loading: false,
    error: null,
    async load() {
      set({ loading: true, error: null })
      try {
        set({ projects: unwrap(await api().projects.list()), loading: false })
      } catch (e) {
        set({ error: (e as Error).message, loading: false })
      }
    },
    async create(input) {
      const project = unwrap(await api().projects.create(input))
      set({ projects: [project, ...get().projects] })
      return project
    },
    async rename(id, name) {
      const updated = unwrap(await api().projects.rename({ id, name }))
      set({ projects: [updated, ...get().projects.filter((p) => p.id !== id)] })
    },
    async remove(id) {
      unwrap(await api().projects.delete(id))
      set({ projects: get().projects.filter((p) => p.id !== id) })
    },
  }))
}

export const useProjects = createProjectsStore()
