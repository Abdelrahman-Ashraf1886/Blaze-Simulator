const { app } = require('electron')
const { performance } = require('node:perf_hooks')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '../..')
const startup = {}
globalThis.blazeStartup = startup
app.setAppPath(root)
app.setName(require(join(root, 'package.json')).productName)

app.once('browser-window-created', (_event, window) => {
  const contents = window.webContents
  window.once('show', () => { startup.shownEpochMs = performance.timeOrigin + performance.now() })

  // electron/main/index.ts:392–398 publishes the completed sidecar handshake.
  const send = contents.send
  contents.send = function (channel, ...args) {
    if (channel === 'engine:statusChanged' && args[0]?.state === 'connected') {
      startup.engineEpochMs = performance.timeOrigin + performance.now()
      contents.send = send
    }
    return send.call(this, channel, ...args)
  }

  // DashboardPage.tsx:42–49. Require a visible dashboard and a paint opportunity
  // between the two callbacks. Store the observation itself, before DevTools polls it.
  contents.once('dom-ready', () => {
    void contents.executeJavaScript(`new Promise((resolve) => {
      const observe = () => {
        const dashboard = document.querySelector('[data-testid="recent-projects"]')
        if (document.visibilityState !== 'visible' || !dashboard?.getClientRects().length) {
          requestAnimationFrame(observe)
          return
        }
        requestAnimationFrame(() => resolve({
          dashboardEpochMs: performance.timeOrigin + performance.now(),
          firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
        }))
      }
      requestAnimationFrame(observe)
    })`).then((result) => Object.assign(startup, result), (error) => { startup.error = String(error) })
  })
})

require(join(root, require(join(root, 'package.json')).main))
