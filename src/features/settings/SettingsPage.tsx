import { useEffect, useState } from 'react'
import type { GraphicsCommand, GraphicsStatus } from '../../../electron/ipc/contract'
import { PageHeader } from '@/components/page-header'
import { getApi, unwrap } from '@/services/api'
import { GraphicsSection } from './GraphicsSection'
import { getDrawingRenderer } from './drawing-renderer'

export function SettingsPage() {
  const [status, setStatus] = useState<GraphicsStatus | null>(null)
  const [onBattery, setOnBattery] = useState<boolean | null>(null)
  const [renderer, setRenderer] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const probeFrame = requestAnimationFrame(() => setRenderer(getDrawingRenderer()))
    const graphics = getApi().graphics
    const unsubscribe = graphics.onPowerChange(setOnBattery)
    let active = true
    void graphics.status().then((result) => {
      if (active) setStatus(unwrap(result))
    }).catch(() => {
      if (active) setError('Could not load the graphics preference.')
    })
    return () => {
      active = false
      cancelAnimationFrame(probeFrame)
      unsubscribe()
    }
  }, [])

  async function command(input: GraphicsCommand) {
    setBusy(true)
    setError(null)
    try {
      unwrap(await getApi().graphics.command(input))
      if (input.action === 'set') {
        const preference = input.preference
        setStatus((current) => current && { ...current, preference })
        setBusy(false)
      }
    } catch {
      setError(input.action === 'set' ? 'Could not save the graphics preference.' : 'Could not restart the app.')
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Settings" />
      <div className="mx-auto max-w-[1600px] px-6 py-5">
        <GraphicsSection
          status={status && { ...status, onBattery: onBattery ?? status.onBattery }}
          renderer={renderer}
          busy={busy}
          error={error}
          onSelect={(preference) => void command({ action: 'set', preference })}
          onRestart={() => void command({ action: 'restart' })}
        />
      </div>
    </>
  )
}
