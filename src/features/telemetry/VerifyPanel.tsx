import { useEffect, useRef, useState } from 'react'
import type { DesktopApi, RecordingVerifyProgress, RecordingVerifyResult } from '../../../electron/ipc/contract'
import { Button } from '@/components/ui/button'

function resultLabel(result: RecordingVerifyResult): string {
  switch (result.status) {
    case 'same': return `Same · verified through step ${result.step}`
    case 'different': return `Different at step ${result.step} · ${result.reason}`
    case 'cannot-verify': return `Cannot verify · ${result.reason}`
    case 'cancelled': return 'Verification cancelled'
  }
}

export function VerifyPanel({ id, api }: { id: string; api: NonNullable<DesktopApi['recording']> }) {
  const request = useRef<string>(undefined)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<RecordingVerifyProgress>()
  const [result, setResult] = useState<RecordingVerifyResult>()

  useEffect(() => {
    const unsubscribe = api.onVerifyProgress((progress) => {
      if (progress.requestId === request.current) setProgress(progress)
    })
    return () => {
      unsubscribe()
      if (request.current) void api.cancelVerify(request.current).catch(() => {})
      request.current = undefined
    }
  }, [api])

  async function verify() {
    const key = crypto.randomUUID()
    request.current = key
    setProgress(undefined)
    setResult(undefined)
    setRunning(true)
    let outcome: RecordingVerifyResult
    try {
      const reply = await api.verify(id, key)
      outcome = reply.ok ? reply.data : { status: 'cannot-verify', reason: reply.error.message }
    } catch (error) {
      outcome = { status: 'cannot-verify', reason: String(error) }
    }
    if (request.current !== key) return
    request.current = undefined
    setRunning(false)
    setResult(outcome)
  }

  return <div className="flex flex-wrap items-center gap-2">
    <Button size="sm" disabled={running} onClick={() => void verify()}>Verify</Button>
    {running && <Button size="sm" onClick={() => {
      if (request.current) void api.cancelVerify(request.current).catch(() => {})
    }}>Cancel verification</Button>}
    <div role="status" aria-label="Verification result">
      {running ? progress ? `Verifying step ${progress.step} / ${progress.totalSteps}` : 'Starting verification…'
        : result && resultLabel(result)}
    </div>
  </div>
}
