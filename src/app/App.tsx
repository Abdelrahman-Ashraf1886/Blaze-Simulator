import { lazy, Suspense } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { ComponentsPage } from '@/features/components/ComponentsPage'
import { ProjectsPage } from '@/features/projects/ProjectsPage'
import { AppShell } from './AppShell'

// The workshop pulls in three.js; load it only when the workshop is opened.
const WorkshopPage = lazy(() => import('@/features/workshop/WorkshopPage'))

// The Electrical Designer pulls in React Flow; load it only when opened.
const ElectricalPage = lazy(() => import('@/features/electrical/ElectricalPage'))
const electrical = (
  <Suspense fallback={<p className="px-6 pt-5 text-[12.5px] text-fg-subtle">Loading Electrical Designer…</p>}>
    <ElectricalPage />
  </Suspense>
)

const workshop = (
  <Suspense fallback={<p className="px-6 pt-5 text-[12.5px] text-fg-subtle">Loading workshop…</p>}>
    <WorkshopPage />
  </Suspense>
)

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="workshop" element={workshop} />
          <Route path="workshop/:projectId" element={workshop} />
          <Route path="components" element={<ComponentsPage />} />
          <Route path="electrical" element={electrical} />
          <Route path="electrical/:projectId" element={electrical} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
