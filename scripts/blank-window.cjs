// Minimal Electron entry used by scripts/render-icon.mjs: one hidden blank window.
const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600 })
  void win.loadURL('about:blank')
})
