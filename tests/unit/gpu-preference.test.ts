import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GPU_PREFERENCES } from '../../electron/ipc/contract'
import { GPU_PREFERENCE_FILE, gpuSwitchFor, readGpuPreference, writeGpuPreference } from '../../electron/main/gpu-preference'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blazeuav-gpu-'))
  path = join(dir, GPU_PREFERENCE_FILE)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('graphics preference file', () => {
  it.each([
    { state: 'missing', contents: undefined },
    { state: 'corrupt', contents: '{' },
    { state: 'unknown', contents: '{"preference":"unsupported"}' },
  ])('uses and logs the default for a $state file', ({ contents }) => {
    if (contents !== undefined) writeFileSync(path, contents, 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readGpuPreference(path)).toBe('high-performance')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
  })

  it('uses and logs the default when the file cannot be read', () => {
    mkdirSync(path)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readGpuPreference(path)).toBe('high-performance')
    expect(warn).toHaveBeenCalledOnce()
  })

  it.each(GPU_PREFERENCES)('reads %s', (preference) => {
    writeFileSync(path, JSON.stringify({ preference }), 'utf8')
    expect(readGpuPreference(path)).toBe(preference)
  })

  it('replaces the existing file and leaves no temporary file', () => {
    writeGpuPreference(path, 'high-performance')
    writeGpuPreference(path, 'power-saving')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ preference: 'power-saving' })
    expect(readdirSync(dir)).toEqual([GPU_PREFERENCE_FILE])
  })

  it('keeps the old preference and removes the staged file when the rename fails', () => {
    writeGpuPreference(path, 'high-performance')
    vi.mocked(renameSync).mockImplementationOnce((temporaryPath, destination) => {
      expect(temporaryPath).not.toBe(path)
      expect(destination).toBe(path)
      expect(readGpuPreference(String(temporaryPath))).toBe('system')
      expect(readGpuPreference(path)).toBe('high-performance')
      throw new Error('rename failed')
    })
    expect(() => writeGpuPreference(path, 'system')).toThrow('rename failed')
    expect(readGpuPreference(path)).toBe('high-performance')
    expect(readdirSync(dir)).toEqual([GPU_PREFERENCE_FILE])
  })
})

it('maps each preference to the Electron startup switch', () => {
  expect(gpuSwitchFor('high-performance')).toBe('force_high_performance_gpu')
  expect(gpuSwitchFor('power-saving')).toBe('force_low_power_gpu')
  expect(gpuSwitchFor('system')).toBeUndefined()
})
