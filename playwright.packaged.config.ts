import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testDir: 'tests/regression',
  testMatch: 'packaged.spec.ts',
})
