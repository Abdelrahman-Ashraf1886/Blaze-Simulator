import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: '.', testMatch: 'prepare-old-userdata.spec.ts', timeout: 60_000, workers: 1 })
