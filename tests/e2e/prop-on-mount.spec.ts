import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
let app: ElectronApplication | undefined
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-prop-mount-'))
})
test.afterEach(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const row = (page: Page, name: string) => page.locator(`[data-testid=part-row][data-name="${name}"]`)
const add = (page: Page, kind: string) => page.getByTestId('part-library').getByRole('button', { name: kind, exact: true }).click()
const commit = async (page: Page, id: string, value: string) => {
  await page.getByTestId(id).fill(value)
  await page.getByTestId(id).press('Enter')
}

async function dropProp(page: Page, mount: number) {
  // Markers appear once a library drag starts (a selected mount alone does not show them).
  const source = (await page.getByTestId('part-library').getByRole('button', { name: 'Propeller', exact: true }).boundingBox())!
  const x = source.x + source.width / 2
  const y = source.y + source.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 15, y, { steps: 3 })
  const marker = page.getByTestId(`mount-marker-motor-${mount}`)
  await expect(marker).toBeVisible()
  const box = (await marker.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 })
  await page.mouse.up()
}

test('Hex X: add and drop a prop onto the mount motor; refuse an empty mount and explain oversized props', async () => {
  const launched = await launchApp(userData)
  app = launched.app
  const page = launched.page
  const errors = trackErrors(page)
  await createProject(page, 'Prop mount hex', 'Hex X')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Prop mount hex' }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
  // At 135 mm adjacent spacing, a bare-mount 254 mm disc intersects the next motor.
  await commit(page, 'frame-motorDiagonal', '270')
  await page.getByTestId('mount-motor-3').click()
  await add(page, 'Propeller')
  await expect(page.getByTestId('placement-error')).toHaveText('Cannot add Propeller 1: add a motor to Motor 3 mount first.')
  await expect(page.getByTestId('status-parts')).toHaveText('0 parts')
  await dropProp(page, 3)
  await expect(page.getByTestId('placement-error')).toHaveText('Cannot add Propeller 1: add a motor to Motor 3 mount first.')
  await expect(page.getByTestId('status-parts')).toHaveText('0 parts')

  for (let n = 1; n <= 6; n++) {
    await page.getByTestId(`mount-motor-${n}`).click()
    await add(page, 'Motor')
  }
  // Existing working path: select the motor part, then add its propeller.
  await row(page, 'Motor 4').click()
  await add(page, 'Propeller')
  await page.getByTestId('mount-motor-3').click()
  await expect(page.getByTestId('add-target')).toContainText('Motor 3 mount')
  await add(page, 'Propeller')
  await expect(page.getByTestId('status-parts')).toHaveText('8 parts')
  await expect(page.getByLabel('Attached to').locator('option:checked')).toHaveText('Motor 3')
  await expect(page.getByTestId('part-pos-z')).toHaveValue('19')
  await expect(page.getByTestId('placement-error')).toHaveCount(0)
  await expect(page.locator('[data-testid=finding][data-rule=interference][data-severity=error]')).toHaveCount(0)

  // One undo removes only the new prop. Dropping it on the mount uses the same rule.
  await page.getByRole('button', { name: /^Undo add propeller/i }).click()
  await expect(page.getByTestId('status-parts')).toHaveText('7 parts')
  await page.getByTestId('mount-motor-3').click()
  await dropProp(page, 3)
  await expect(page.getByTestId('status-parts')).toHaveText('8 parts')
  await expect(page.getByLabel('Attached to').locator('option:checked')).toHaveText('Motor 3')
  await expect(page.getByTestId('part-pos-z')).toHaveValue('19')

  // A taller neighbour clears the normal prop, but obstructs an oversized one.
  await row(page, 'Motor 2').click()
  await commit(page, 'part-height', '50')
  await row(page, 'Propeller 2').click()
  await commit(page, 'part-diameter', '1000')
  await expect(page.getByTestId('placement-error')).toContainText('Propeller 2 (1000 × 1000 × 8 mm)')
  await expect(page.getByTestId('placement-error')).toContainText('too large for the available motor spacing')
  await expect(page.getByTestId('placement-error')).toContainText('Motor 2 (28 × 28 × 50 mm), with centres 135 mm apart (frame motor diagonal 270 mm)')

  // A smaller frame makes even the starting prop too large beside that tall motor.
  await row(page, 'Propeller 2').click()
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('status-parts')).toHaveText('7 parts')
  await commit(page, 'frame-motorDiagonal', '250')
  await page.getByTestId('mount-motor-3').click()
  await add(page, 'Propeller')
  await expect(page.getByTestId('status-parts')).toHaveText('7 parts')
  await expect(page.getByTestId('placement-error')).toContainText('Propeller 2 (254 × 254 × 8 mm)')
  await expect(page.getByTestId('placement-error')).toContainText('too large for the available motor spacing')
  await expect(page.getByTestId('placement-error')).toContainText('frame motor diagonal 250 mm')
  expect(errors).toEqual([])
})
