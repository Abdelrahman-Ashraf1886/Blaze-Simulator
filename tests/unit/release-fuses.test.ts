import { describe, expect, it } from 'vitest'
import { parseFuseWire, verifyFusePolicy } from '../../scripts/release/fuses.mjs'

// Wire order and state bytes from @electron/fuses/dist/{config,constants}.js:13–18,7–8.
// Stock Electron for 0.8.0 reads 101100 at these positions.
const stock = { version: '1', 0: 49, 1: 48, 2: 49, 3: 49, 4: 48, 5: 48 }
const release = { version: '1', 0: 48, 1: 48, 2: 48, 3: 48, 4: 49, 5: 49 }

describe('packaged fuse readback', () => {
  it('decodes and enforces the five hardening switches and the inherited cookie switch', () => {
    const expected = {
      RunAsNode: false,
      EnableCookieEncryption: false,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
    }
    expect(parseFuseWire(release)).toEqual(expected)
    const defaults = parseFuseWire(stock)
    expect(() => verifyFusePolicy(expected, defaults)).not.toThrow()
    for (const [key, value] of Object.entries(expected)) {
      expect(() => verifyFusePolicy({ ...expected, [key]: !value }, defaults)).toThrow(key)
    }
  })

  it('rejects missing, unknown or unsupported fuse states', () => {
    expect(() => parseFuseWire({ ...release, version: '2' })).toThrow('wire version')
    expect(() => parseFuseWire({ ...release, 3: 114 })).toThrow('EnableNodeCliInspectArguments')
    expect(() => parseFuseWire({ version: '1' })).toThrow('RunAsNode')
  })
})
