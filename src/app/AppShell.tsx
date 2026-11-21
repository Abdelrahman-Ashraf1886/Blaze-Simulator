import { useEffect } from 'react'
import { Outlet } from 'react-router'
import { useSystem } from '@/stores/system'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'

export function AppShell() {
  useEffect(() => {
    const unsubscribe = useSystem.getState().subscribe()
    void useSystem.getState().refresh()
    return unsubscribe
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {/* The work area is a size container: pages lay out against its width, not the window's. */}
        <main className="@container min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
