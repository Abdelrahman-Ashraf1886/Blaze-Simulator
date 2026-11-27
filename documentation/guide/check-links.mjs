import console from 'node:console'
import process from 'node:process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const guide = dirname(fileURLToPath(import.meta.url))
const root = resolve(guide, '../..')
const pages = [
  resolve(root, 'README.md'),
  ...readdirSync(guide).filter((name) => name.endsWith('.md')).map((name) => resolve(guide, name)),
]

function headingIds(lines) {
  const seen = new Map()
  const ids = new Set()
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!heading) continue
    const base = heading[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    ids.add(count ? `${base}-${count}` : base)
  }
  return ids
}

function verifyLink(page, target) {
  const [path, fragment] = target.split('#', 2).map(decodeURIComponent)
  const destination = path ? resolve(dirname(page), path) : page
  if (!statSync(destination, { throwIfNoEntry: false })) throw new Error('missing path')
  if (!fragment) return

  const lines = readFileSync(destination, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/)
  const range = /^L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$/.exec(fragment)
  if (range) {
    const first = Number(range[1])
    const last = Number(range[2] ?? range[1])
    if (first <= last && last <= lines.length) return
    throw new Error('source line outside the file')
  }
  if (!headingIds(lines).has(fragment)) throw new Error('missing heading')
}

let checked = 0
let failed = 0
for (const page of pages) {
  const markdown = readFileSync(page, 'utf8')
  for (const [, target] of markdown.matchAll(/!?\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue
    checked++
    try {
      verifyLink(page, target)
    } catch (error) {
      failed++
      console.error(`${relative(root, page)} → ${target} (${error.message})`)
    }
  }
}

console.log(`Checked ${checked} local links in ${pages.length} Markdown files. ${failed} failures.`)
if (failed) process.exitCode = 1
