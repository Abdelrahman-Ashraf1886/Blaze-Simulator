import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { RecordingHeader, RecordingVerifyResult } from '../../ipc/contract'
import {
  FlightSessionStartResultSchema, FlightSessionStepResultSchema, isEngineResponse, PROTOCOL_VERSION,
  ScenarioRunResultSchema, StepTestRunResultSchema, VehicleLoadResultSchema,
} from '../engine/protocol'
import type { RecordingReader } from './reader'
import { traceRows } from './session-recorder'

// Match the sidecar request timeout in engine/supervisor.ts.
const REQUEST_TIMEOUT_MS = 3000

async function withEngine<T>(path: string, signal: AbortSignal, use: (send: Send) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const child = spawn(path, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  const stdout = createInterface({ input: child.stdout })
  const exited = new AbortController()
  const closed = new Promise<void>((resolve) => child.once('close', () => {
    exited.abort(new Error('Verification engine closed its connection'))
    resolve()
  }))
  const failed = (error: Error) => exited.abort(error)
  child.on('error', failed)
  child.stdin.on('error', failed)
  stdout.on('error', failed)
  try {
    return await use(async (line, id) => {
      const waiting = AbortSignal.any([signal, exited.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      waiting.throwIfAborted()
      const reply = once(stdout, 'line', { signal: waiting })
      child.stdin.write(line)
      const [raw] = await reply
      const response: unknown = JSON.parse(raw)
      if (!isEngineResponse(response) || response.id !== id) throw new Error('Unexpected verification engine response')
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      return response.result
    })
  } finally {
    stdout.close()
    child.stdin.end()
    child.kill()
    await closed
  }
}

type Send = (line: string, id: number) => Promise<unknown>

function sendRecorded(send: Send, line: string, type: string): Promise<unknown> {
  // Only the expected command may run and the original JSON bytes reach the sidecar.
  if (!/^[^\r\n]+\n$/.test(line)) throw new Error(`Invalid recorded ${type} line`)
  const request = JSON.parse(line)
  if (request?.type !== type || !Number.isSafeInteger(request.id) || request.id < 1) {
    throw new Error(`Invalid recorded ${type} request`)
  }
  return send(line, request.id)
}

type Samples = { steps: number[]; rows: readonly (readonly (number | null)[])[] }

function reconcileRows(header: RecordingHeader, saved: AsyncIterator<(number | null)[]>) {
  let nextStep = header.firstSampleStep
  return async (samples?: Samples, channels?: string[]): Promise<RecordingVerifyResult | undefined> => {
    if (channels && (channels.length !== header.channels.length || channels.some((name, i) => name !== header.channels[i]?.name))) {
      return { status: 'different', step: nextStep, reason: 'Sample channels differ' }
    }
    if (!samples) return
    for (const [index, actual] of samples.rows.entries()) {
      const step = samples.steps[index]
      const { done, value } = await saved.next()
      if (done || step !== nextStep || value.length !== actual.length || actual.some((number, i) => !Object.is(number, value[i]))) {
        return { status: 'different', step: nextStep, reason: 'Sample row differs' }
      }
      nextStep += header.samplePeriodSteps
    }
  }
}

export async function verifyRecording(
  reader: RecordingReader, binaryPath: string, signal: AbortSignal, progress: (step: number, totalSteps: number) => void,
): Promise<RecordingVerifyResult> {
  try {
    signal.throwIfAborted()
    const summary = await reader.summary()
    const { header, end, incomplete, integrityError, sampleCount } = summary
    if (!header || !end || incomplete || integrityError) {
      return { status: 'cannot-verify', reason: integrityError ?? 'Recording is incomplete' }
    }
    if (!end.finalStateHash) return { status: 'cannot-verify', reason: 'Recording has no final state hash' }
    if (header.protocolVersion !== PROTOCOL_VERSION) return { status: 'cannot-verify', reason: 'Engine protocol differs' }
    const requests = await reader.readRequests()
    if (requests.integrityError || requests.lines.length !== summary.requestCount) {
      return { status: 'cannot-verify', reason: requests.integrityError ?? 'Recording changed during verification' }
    }
    if (header.kind !== 'flight' && requests.lines.length > 0) {
      return { status: 'cannot-verify', reason: 'Expected a single recorded run request' }
    }
    const stepAt = (timeS: number) => Math.round(timeS / header.stepLengthS)
    const totalSteps = stepAt(end.elapsedS)
    progress(0, totalSteps)

    return await withEngine(binaryPath, signal, async (send) => {
      const hello = await send('{"id":0,"type":"hello"}\n', 0) as { engineVersion?: unknown; protocolVersion?: unknown }
      if (hello.engineVersion !== header.engineVersion || hello.protocolVersion !== header.protocolVersion) {
        return { status: 'cannot-verify', reason: 'Engine version or protocol differs' }
      }
      if (!VehicleLoadResultSchema.parse(await sendRecorded(send, header.vehicleLoad, 'vehicle.load')).valid) {
        return { status: 'cannot-verify', reason: 'Verification engine refused the recorded vehicle' }
      }

      const saved = reader.sampleValues()
      const compare = reconcileRows(header, saved)
      const check = sampleCount ? compare : async () => undefined
      let step = 0
      let hash: string | undefined
      try {
        switch (header.kind) {
          case 'flight': {
            const start = FlightSessionStartResultSchema.parse(await sendRecorded(send, header.startRequest, 'flight.session.start'))
            const initialDifference = await check(start.samples, start.channels)
            if (initialDifference) return initialDifference
            for (const line of requests.lines) {
              const reply = FlightSessionStepResultSchema.parse(await sendRecorded(send, line, 'flight.session.step'))
              step += reply.stepsRun
              const difference = await check(reply.samples)
              if (difference) return difference
              hash = reply.stateHash
              progress(step, totalSteps)
            }
            break
          }
          case 'scenario': {
            const reply = ScenarioRunResultSchema.parse(await sendRecorded(send, header.startRequest, 'scenario.run'))
            step = stepAt(reply.report.elapsedS)
            const difference = await check(reply.samples, reply.channels)
            if (difference) return difference
            hash = reply.stateHash
            break
          }
          case 'step-test': {
            const reply = StepTestRunResultSchema.parse(await sendRecorded(send, header.startRequest, 'stepTest.run'))
            step = stepAt(reply.elapsedS)
            const difference = await check({ rows: traceRows(reply.trace), steps: reply.trace.samples.map(({ timeS }) => stepAt(timeS)) })
            if (difference) return difference
            hash = reply.stateHash
            break
          }
        }
        signal.throwIfAborted()
        if (!(await saved.next()).done) {
          return { status: 'different', step, reason: 'Recorded sample rows are absent from the replay' }
        }
        progress(step, totalSteps)
        return hash === end.finalStateHash && step === totalSteps
          ? { status: 'same', step }
          : { status: 'different', step, reason: 'Final state hash or step count differs' }
      } finally {
        await saved.return(undefined)
      }
    })
  } catch (error) {
    return signal.aborted ? { status: 'cancelled' } : {
      status: 'cannot-verify', reason: error instanceof Error ? error.message : String(error),
    }
  }
}
