import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { describe, expect, it } from 'vitest'
import { CONTROLLER_PARAM_GROUPS, CONTROLLER_PARAMS, controllerParam } from '../../src/domain/controller-params'
import { documentedRange, readOverrides } from '../../src/features/tuning/tuning-values'

const tilt = controllerParam('MPC_TILTMAX_AIR')!

describe('tuning draft', () => {
  it('sends only overrides and marks resetting a saved value as a change', () => {
    const saved = { [tilt.name]: tilt.min! }
    expect(readOverrides({ [tilt.name]: String(tilt.min) }, saved)).toEqual({
      overrides: saved, dirty: false, validation: { ok: true },
    })
    expect(readOverrides({ [tilt.name]: String(tilt.default) }, saved)).toEqual({
      overrides: {}, dirty: true, validation: { ok: true },
    })
    expect(readOverrides({}, saved)).toMatchObject({ overrides: {}, dirty: true })
    expect(readOverrides({ [tilt.name]: String(tilt.default) }, {})).toMatchObject({ overrides: {}, dirty: false })
  })

  it('keeps blank edits invalid and delegates range errors to the domain', () => {
    for (const [text, message] of [['', 'finite number'], [String(tilt.max! + 1), 'documented range']] as const) {
      const result = readOverrides({ [tilt.name]: text }, {})
      expect(result.dirty).toBe(true)
      expect(result.validation).toMatchObject({
        ok: false, errors: [{ name: tilt.name, message: expect.stringContaining(message) }],
      })
    }
  })

  it('formats only the documented bounds', () => {
    expect(documentedRange(tilt)).toBe(`${tilt.min} to ${tilt.max}`)
    expect(documentedRange({ ...tilt, max: null })).toBe(`≥ ${tilt.min}`)
    expect(documentedRange({ ...tilt, min: null })).toBe(`≤ ${tilt.max}`)
    expect(documentedRange(controllerParam('MC_ROLL_P')!)).toBe('No documented bounds')
  })
})

it('server-renders the parameter references and the prop-driven flight notice', async () => {
  const server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-tuning-panel-render-test'),
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  try {
    const { TuningPanel } = await server.ssrLoadModule('/src/features/tuning/TuningPanel.tsx') as {
      TuningPanel: ComponentType<{ projectId: string; gainsAffectFlights: boolean }>
    }
    const render = (gainsAffectFlights: boolean) =>
      renderToStaticMarkup(createElement(TuningPanel, { projectId: 'project', gainsAffectFlights }))
    const html = render(false)
    for (const { label } of CONTROLLER_PARAM_GROUPS) expect(html).toContain(`>${label}</h2>`)
    expect(html.match(/<input\b/g)).toHaveLength(CONTROLLER_PARAMS.length)
    expect(html).toContain('The signals are exact (no sensor noise, filtering or delay), so responses look better than on a real vehicle.')
    expect(html).toContain('Saved gains do not affect flights yet.')
    expect(html).toContain('Loading saved tuning')
    expect(html).toContain(`aria-label="Reset ${tilt.name}"`)
    expect(html).toContain(`PX4 default <span class="num text-fg">${tilt.default}</span>`)
    expect(html).toContain(documentedRange(tilt))
    expect(render(true)).not.toContain('Saved gains do not affect flights yet.')
  } finally {
    await server.close()
  }
})
