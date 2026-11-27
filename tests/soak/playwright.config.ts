import { defineConfig } from '@playwright/test'
import base from '../../playwright.config'

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'flight.spec.ts',
  outputDir: '../../test-results/soak',
})
