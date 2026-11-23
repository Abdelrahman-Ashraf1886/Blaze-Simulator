import { tmpdir } from 'node:os'
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
    expect(html).toContain('--color-setpoint:magenta')
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
  } finally {
    await server.close()
  }
})
