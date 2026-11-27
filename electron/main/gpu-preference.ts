import { readBoundedFileSync } from './assets/bounded-file'
import { jsonDepthWithin } from './assets/json-depth'
import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { GPU_PREFERENCES, type GpuPreference } from '../ipc/contract'
import { gpuPreferenceSchema } from '../ipc/schemas'

export const GPU_PREFERENCE_FILE = 'gpu-preference.json'

// Default chosen by the user on 2026-11-26 (phase-8-quality.md, D9).
const DEFAULT_GPU_PREFERENCE: GpuPreference = 'high-performance'

// Switch spellings checked in the Chromium binary shipped with Electron 45.4.1.
const GPU_SWITCHES: Record<GpuPreference, string | undefined> = {
  'high-performance': 'force_high_performance_gpu',
  'power-saving': 'force_low_power_gpu',
  system: undefined,
}

export function gpuSwitchFor(preference: GpuPreference): string | undefined {
  return GPU_SWITCHES[preference]
}

export function readGpuPreference(path: string): GpuPreference {
  try {
    // The writer uses compact JSON. Allow the longest value in the same enum.
    const limit = Math.max(...GPU_PREFERENCES.map((preference) => Buffer.byteLength(JSON.stringify({ preference }))))
    const text = readBoundedFileSync(path, limit).toString('utf8')
    if (!jsonDepthWithin(text, 1)) throw new Error('Invalid graphics preference depth.')
    return gpuPreferenceSchema.parse(JSON.parse(text)).preference
  } catch (error) {
    console.warn(`[graphics] Could not read ${path}. Using ${DEFAULT_GPU_PREFERENCE}.`, error)
    return DEFAULT_GPU_PREFERENCE
  }
}

export function writeGpuPreference(path: string, preference: GpuPreference): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify({ preference }), { encoding: 'utf8', flag: 'wx' })
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true })
    } catch (cleanupError) {
      console.warn('[graphics] Could not remove the temporary preference file.', cleanupError)
    }
    throw error
  }
}
