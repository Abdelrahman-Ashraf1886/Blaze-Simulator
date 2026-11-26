import { ok } from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { thirdPartyNoticesPath } from '../../electron/main/notices'
// @ts-expect-error The standalone JavaScript command has no TypeScript declarations.
import { collectNotices, packageNotice, renderNotices } from '../../scripts/notices.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

function fixture(files: Record<string, string>, run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'blaze-notices-fixture-'))
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text, 'utf8')
    run(directory)
  } finally {
    for (const name of Object.keys(files)) unlinkSync(join(directory, name))
    rmdirSync(directory)
  }
}

const sample = { name: 'sample', version: '1.0.0', source: 'https://example.com/source', kind: 'npm' }

describe('third-party notices', () => {
  it('identifies a package with a missing licence file', () => {
    fixture({ NOTICE: 'Copyright holder' }, (directory) => {
      expect(() => packageNotice({ ...sample, directory, licence: 'MIT' }))
        .toThrow('npm sample@1.0.0: missing licence file')
    })
  })

  it('rejects unknown identifiers even when an alternative is known', () => {
    fixture({ LICENSE: 'Licence text' }, (directory) => {
      expect(() => packageNotice({ ...sample, directory, licence: 'MIT OR MadeUp-1.0' }))
        .toThrow('npm sample@1.0.0: unknown licence expression "MIT OR MadeUp-1.0"')
    })
  })

  it('preserves both dual-licence texts and copyright lines', () => {
    fixture({ 'LICENSE-MIT': 'Copyright MIT holder', 'LICENSE-APACHE': 'Copyright Apache holder' }, (directory) => {
      const entry = packageNotice({ ...sample, directory, licence: 'MIT OR Apache-2.0' })
      expect(entry.expression).toBe('MIT OR Apache-2.0')
      expect(entry.texts).toEqual([
        ['LICENSE-APACHE', 'Copyright Apache holder'],
        ['LICENSE-MIT', 'Copyright MIT holder'],
      ])
    })
  })

  it('sorts by licence and package regardless of discovery order', () => {
    fixture({ LICENSE: 'Licence text' }, (directory) => {
      const first = packageNotice({ ...sample, directory, licence: 'Apache-2.0' })
      const second = packageNotice({ ...sample, directory, licence: 'MIT' })
      const third = { ...second, name: 'zzz' }
      const ordered = renderNotices([first, second, third])
      expect(renderNotices([third, second, first])).toBe(ordered)
      expect(ordered).toMatch(/=== Apache-2\.0 ===[\s\S]*=== MIT ===[\s\S]*sample@1\.0\.0[\s\S]*zzz@1\.0\.0/)
    })
  })

  it('lists all discovered runtime crates and npm packages and matches the generated file', async () => {
    const notice = read(thirdPartyNoticesPath(false, '', root))
    const { entries, issues, otherSources } = await collectNotices({ draft: true })
    for (const entry of entries) expect(notice).toContain(`${entry.name}@${entry.version} [${entry.kind}]`)
    expect(notice).toBe(renderNotices(entries, issues, otherSources))
    expect(notice).toContain(read(join(root, 'simulation-engine/NOTICE-PX4.md')).trimEnd())
  }, 60_000)

  it('opens the development file and the corresponding Electron Builder resource path', () => {
    const config = read(join(root, 'electron-builder.yml'))
    const [, from, to] = config.match(/^ {2}- from: (build\/notices\/[^\n]+)\n {4}to: (notices\/[^\n]+)$/m) ?? []
    ok(from && to, 'Electron Builder must map the notice file into resources')
    const devPath = thirdPartyNoticesPath(false, '', root)
    expect(devPath).toBe(join(root, from))

    const resources = mkdtempSync(join(tmpdir(), 'blaze-notices-resources-'))
    const packagedPath = join(resources, to)
    mkdirSync(dirname(packagedPath))
    try {
      copyFileSync(devPath, packagedPath)
      expect(thirdPartyNoticesPath(true, resources, root)).toBe(packagedPath)
      expect(read(packagedPath)).toBe(read(devPath))
    } finally {
      unlinkSync(packagedPath)
      rmdirSync(dirname(packagedPath))
      rmdirSync(resources)
    }
  })
})
