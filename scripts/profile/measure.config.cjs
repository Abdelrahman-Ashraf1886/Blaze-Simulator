const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'measure.spec.ts',
  outputDir: '../../test-results/profile',
  workers: 1,
  reporter: 'list',
  use: { trace: 'off', screenshot: 'off' },
})
