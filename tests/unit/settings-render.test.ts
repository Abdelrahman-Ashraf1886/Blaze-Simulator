import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { GPU_PREFERENCES, type GraphicsStatus } from '../../electron/ipc/contract'
let server: ViteDevServer
let GraphicsSection: ComponentType<{
  status: GraphicsStatus | null
  renderer: string | null | undefined
  busy: boolean
  error: string | null
  onSelect: () => void
  onRestart: () => void
}>

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-settings-render-test'),
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  const module = await server.ssrLoadModule('/src/features/settings/GraphicsSection.tsx')
  GraphicsSection = module.GraphicsSection as typeof GraphicsSection
})

afterAll(async () => server?.close())

function render(status: GraphicsStatus | null, renderer: string | null | undefined, error: string | null = null) {
  return renderToStaticMarkup(createElement(GraphicsSection, {
    status,
    renderer,
    busy: false,
    error,
    onSelect: () => {},
    onRestart: () => {},
  }))
}

it.each(GPU_PREFERENCES)('renders %s as the selected preference on battery', (preference) => {
  const markup = render({ preference, startupPreference: 'high-performance', onBattery: true }, 'NVIDIA GeForce GTX 1650')
  expect(markup).toContain('Graphics')
  expect(markup).toContain('NVIDIA GeForce GTX 1650')
  expect(markup).toContain('>Battery<')
  expect(markup).toContain(`checked="" value="${preference}"`)
  if (preference === 'high-performance') {
    expect(markup).toContain('while you’re on battery')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Restart now/)
  } else {
    expect(markup).not.toContain('while you’re on battery')
    expect(markup).toContain('Preference saved.')
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Restart now/)
  }
})

it('shows plugged-in power and an unavailable renderer without a battery note', () => {
  const markup = render({ preference: 'high-performance', startupPreference: 'system', onBattery: false }, null)
  expect(markup).toContain('>Plugged in<')
  expect(markup).toContain('>Unavailable<')
  expect(markup).not.toContain('while you’re on battery')
})

it('renders the pending and error states without a selected preference', () => {
  expect(render(null, undefined)).toContain('Detecting…')
  const markup = render(null, null, 'Could not load the graphics preference.')
  expect(markup).toContain('>Unknown<')
  expect(markup).toContain('Could not load the graphics preference.')
  expect(markup).toMatch(/<fieldset[^>]*disabled=""/)
  expect(markup).not.toContain('checked=""')
})
