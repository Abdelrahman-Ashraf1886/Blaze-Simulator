// Renders build/icon.svg to build/icon.png (512×512, transparent) with Electron's
// own Chromium, so no image library is needed. electron-builder converts the PNG
// into the Windows .ico at package time. Usage: npm run icon
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import playwright from '@playwright/test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8')

const app = await playwright._electron.launch({ args: [join(root, 'scripts', 'blank-window.cjs')] })
const page = await app.firstWindow()
const base64 = await page.evaluate(async (source) => {
  const img = new Image()
  img.src = `data:image/svg+xml;base64,${btoa(source)}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 512
  canvas.getContext('2d').drawImage(img, 0, 0, 512, 512)
  return canvas.toDataURL('image/png').split(',')[1]
}, svg)
await app.close()

writeFileSync(join(root, 'build', 'icon.png'), Buffer.from(base64, 'base64'))
console.log('wrote build/icon.png')
