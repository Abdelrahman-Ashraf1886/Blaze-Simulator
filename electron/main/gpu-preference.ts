import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { GpuPreference } from '../ipc/contract'
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
    return gpuPreferenceSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).preference
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
