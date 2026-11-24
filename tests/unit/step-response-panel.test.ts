import { tmpdir } from 'node:os'
import type { StepTestInput, StepTestOutput } from '../../electron/ipc/contract'
import { EMPTY_STEP_TEST, readStepTest, type StepTestDraft, type StepTestErrors } from '../../src/features/tuning/step-test-input'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { RECOMMENDED_STEP_METRICS_OPTIONS, type ResponseStep, type StepSample } from '../../src/domain/step-response'
import { responsePlot } from '../../src/features/tuning/response-plot'

const step = { t0: 1, y0: 0, y1: 1 }
const partial = [{ t: 0, y: 0 }, { t: 2, y: 0.5 }]

it('positions the setpoint jump at the actual step time between samples', () => {
  expect(responsePlot(partial, step)).toMatchObject({
    setpoint: '0,100 50,100 50,0 100,0',
    state: '0,100 100,50',
  })
})

it('clips the setpoint to the sample window and handles singleton or unusable data', () => {
  expect(responsePlot(partial, { ...step, t0: 3 })?.setpoint).toBe('0,100 100,100')
  expect(responsePlot([partial[0]!], step)?.firstPoint).toEqual({ x: 50, y: 50, targetY: 50 })
  expect(responsePlot([], step)).toBeNull()
  expect(responsePlot([...partial].reverse(), step)).toBeNull()
  expect(responsePlot([{ t: 0, y: Number.NaN }], step)).toBeNull()
})

it('server-renders both traces, metric outcomes, editable conventions and the empty state', async () => {
  const server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-step-response-render-test'),
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  try {
    const { StepResponsePanel } = await server.ssrLoadModule('/src/features/tuning/StepResponsePanel.tsx') as {
      StepResponsePanel: ComponentType<{ samples: readonly StepSample[]; step: ResponseStep; gainsUsed: Record<string, number> }>
    }
    const render = (samples: readonly StepSample[]) =>
      renderToStaticMarkup(createElement(StepResponsePanel, { samples, step, gainsUsed: { TestGain: 0.7 } }))
    const html = render(partial)
    for (const label of ['Rise time', 'Peak time', 'Steady-state error', 'Did not settle', 'No overshoot', 'Gains used', 'TestGain', 'Our metric conventions']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('The signals are exact (no sensor noise, filtering or delay), so responses look better than on a real vehicle.')
    expect(html).toContain('class="text-setpoint"')
    expect(html).toContain('stroke="var(--color-setpoint)"')
    expect(html).toContain('stroke="currentColor"')
    expect(html).toContain('>0.7</dd>')
    expect(html.match(/<input\b/g)).toHaveLength(Object.keys(RECOMMENDED_STEP_METRICS_OPTIONS).length)
    for (const value of Object.values(RECOMMENDED_STEP_METRICS_OPTIONS)) expect(html).toContain(`value="${value}"`)
    const settled = render([{ t: 0, y: 0 }, { t: 2, y: 1.25 }, { t: 3, y: 1 }])
    expect(settled).not.toContain('Did not settle')
    expect(settled).not.toContain('No overshoot')
    expect(settled).toContain('>25<span')
    const empty = render([])
    expect(empty).toContain('No step-response samples.')
    expect(empty).not.toContain('<svg')
    expect(empty).not.toContain('Did not settle')

    const { StepTestForm, StepTestResult } = await server.ssrLoadModule('/src/features/tuning/StepTestPanel.tsx') as {
      StepTestForm: ComponentType<{
        draft: StepTestDraft; errors: StepTestErrors; disabled: boolean; running: boolean; dirty: boolean
        onSubmit: () => void; onChange: () => void
      }>
      StepTestResult: ComponentType<{ result: StepTestOutput; step: StepTestInput['test']['step']; label: string; unit: string }>
    }
    const form = renderToStaticMarkup(createElement(StepTestForm, {
      draft: EMPTY_STEP_TEST, errors: readStepTest(EMPTY_STEP_TEST).errors, disabled: true, running: false, dirty: true,
      onSubmit: () => {}, onChange: () => {},
    }))
    for (const notice of ['free space with perfect state', 'valid only after at least 2 s', 'MPC_THR_HOVER', 'Unsaved gains', 'Enter an amplitude.']) expect(form).toContain(notice)
    expect(form.match(/value=""/g)).toHaveLength(5)
    expect(form).toContain('aria-invalid="true"')

    const result: StepTestOutput = {
      trace: { decimationSteps: 1, samples: [] }, stepTimeS: 1, elapsedS: 2, hoverCollective01: 0.5,
      startImbalanceNm: [0, 0, 0], endReason: 'error', error: 'controller failed', stateHash: '0123456789abcdef',
      gains: { MPC_THR_HOVER: 0.5 },
    }
    const response = renderToStaticMarkup(createElement(StepTestResult, { result, step: { type: 'altitude', amplitudeM: 1 }, label: 'Altitude', unit: 'm' }))
    for (const notice of ['Run ended at 2 s', 'Engine error', 'controller failed', 'The controller trims it during the hold.', 'MPC_THR_HOVER', 'The signals are exact']) expect(response).toContain(notice)
  } finally {
    await server.close()
  }
})
