import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, root, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-collisions-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const commit = async (page: Page, id: string, value: string) => {
  await page.getByTestId(id).fill(value)
  await page.getByTestId(id).press('Enter')
}

/** Screenshots for the DEVLOG (documentation/screenshots), refreshed by every run. */
const shots = join(root, 'documentation', 'screenshots')

async function open(page: Page, name: string) {
  await createProject(page, name)
  await page.getByTestId('recent-projects').getByRole('link', { name }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
}

/** Adds a part from the library with nothing selected (so it is free on the frame). */
async function addFree(page: Page, kind: string) {
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Escape')
  await page.getByTestId('part-library').getByRole('button', { name: kind, exact: true }).click()
}

const view = (page: Page) => page.getByTestId('collision-view')
const interference = (page: Page) => page.locator('[data-testid=finding][data-rule=interference][data-severity=error]')

/** State read through the test hooks (src/lib/test-hooks.ts). */
type Hooks = {
  assembly: { getState(): { doc: { parts: { id: string; name: string; position: number[] }[] }; revision: number; past: unknown[] } }
  workshopView: { getState(): { dragPose: unknown; setDragPose(p: unknown): void } }
  projectObject(name: string): { x: number; y: number } | null
}
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const a = (window as unknown as { __blazeTest: Hooks }).__blazeTest.assembly.getState()
    return { revision: a.revision, undo: a.past.length, parts: JSON.stringify(a.doc.parts) }
  })
const project = (page: Page, name: string) =>
  page.evaluate((n) => (window as unknown as { __blazeTest: Hooks }).__blazeTest.projectObject(n), name)
const dragging = (page: Page) => page.evaluate(() => (window as unknown as { __blazeTest: Hooks }).__blazeTest.workshopView.getState().dragPose !== null)

test('placement and interference: new parts land clear; a full frame is refused; overlap error, highlight, allow, tolerance, debug view; settings persist', async () => {
  mkdirSync(shots, { recursive: true })
  const first = await launchApp(userData)
  running.push(first.app)
  let page = first.page
  const errors = trackErrors(page)
  await open(page, 'Collision quad')

  // Batteries are 140 × 45 mm; the quad's plate is 120 mm square. The first takes the centre,
  // the next ones the nearest free spots on the plate: 45 mm to the left, then to the right.
  await addFree(page, 'Battery')
  await addFree(page, 'Battery')
  await expect(page.getByTestId('part-pos-y')).toHaveValue('45')
  await addFree(page, 'Battery')
  await expect(page.getByTestId('part-pos-y')).toHaveValue('-45')
  await expect(interference(page)).toHaveCount(0)
  await expect(view(page)).toHaveAttribute('data-highlighted', '')
  // A fourth does not fit on the plate: nothing is added, and the reason is shown.
  await addFree(page, 'Battery')
  await expect(page.getByTestId('placement-error')).toHaveText(
    'No free spot on the frame for Battery 4 (140 × 45 × 35 mm): every position overlaps another part by more than your tolerance. Move or remove a part, or add it elsewhere.',
  )
  await expect(page.getByTestId('status-parts')).toHaveText('3 parts')
  // Adding and placing was one undo step each.
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('status-parts')).toHaveText('2 parts')

  // Battery 2 moved by hand 40 mm from Battery 1: 5 mm overlap.
  await page.locator('[data-testid=part-row][data-name="Battery 2"]').click()
  await commit(page, 'part-pos-y', '40')
  await expect(interference(page)).toHaveCount(1)
  await expect(interference(page)).toContainText('Battery 1 and Battery 2 overlap by 5 mm (your tolerance: 0.5 mm)')
  await expect(view(page)).toHaveAttribute('data-highlighted', /^[^,]+,[^,]+$/)
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('f')
  await page.waitForTimeout(800)
  await page.getByTestId('viewport-3d').screenshot({ path: join(shots, '4.4-interference-highlight.png') })

  // Allowing the pair clears the error and the highlight; undo brings it back.
  await page.getByTestId('allow-overlap').click()
  await expect(interference(page)).toHaveCount(0)
  await expect(view(page)).toHaveAttribute('data-highlighted', '')
  await expect(page.getByTestId('allowed-pair')).toContainText('Battery 1 · Battery 2')
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  await expect(interference(page)).toHaveCount(1)

  // Tolerance edge: 5.01 mm accepts the 5 mm overlap, 4.99 mm does not.
  await commit(page, 'interference-tolerance', '5.01')
  await expect(interference(page)).toHaveCount(0)
  await commit(page, 'interference-tolerance', '4.99')
  await expect(interference(page)).toHaveCount(1)
  await commit(page, 'interference-tolerance', '0.5')

  // Debug view (B): the frame's plate and 4 arms, and both batteries.
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('b')
  await expect(view(page)).toHaveAttribute('data-shapes', '7')
  await page.waitForTimeout(500)
  await page.getByTestId('viewport-3d').screenshot({ path: join(shots, '4.4-collision-debug-view.png') })
  await page.keyboard.press('b')

  // Allow the pair, set a tolerance, restart: both are saved with the project.
  await page.getByTestId('allow-overlap').click()
  await commit(page, 'interference-tolerance', '1.5')
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 })
  expect(errors).toEqual([])
  await first.app.close()

  const second = await launchApp(userData)
  running.push(second.app)
  page = second.page
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Collision quad' }).click()
  await expect(page.getByTestId('interference-tolerance')).toHaveValue('1.5')
  await expect(page.getByTestId('allowed-pair')).toContainText('Battery 1 · Battery 2')
  await expect(page.locator('[data-testid=finding][data-rule=interference]')).toHaveCount(0)
})

test('live drag: the preview follows the gizmo, the saved assembly is unchanged until release, then one undo step', async () => {
  const { app, page } = await launchApp(userData)
  running.push(app)
  const errors = trackErrors(page)
  await open(page, 'Drag quad')
  await addFree(page, 'Battery')
  await addFree(page, 'Battery')
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 })
  const before = await snapshot(page)

  // 1. Preview: a drag pose 5 mm into Battery 1, set as the gizmo would, not released.
  await page.evaluate(() => {
    const t = (window as unknown as { __blazeTest: Hooks }).__blazeTest
    const b2 = t.assembly.getState().doc.parts.find((p) => p.name === 'Battery 2')!
    t.workshopView.getState().setDragPose({ id: b2.id, position: [0, 0.04, b2.position[2]], rotation: [0, 0, 0, 1] })
  })
  await expect(view(page)).toHaveAttribute('data-highlighted', /^[^,]+,[^,]+$/)
  await expect(interference(page)).toContainText('Battery 1 and Battery 2 overlap by 5 mm')
  expect(await snapshot(page)).toEqual(before)
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
  await page.evaluate(() => (window as unknown as { __blazeTest: Hooks }).__blazeTest.workshopView.getState().setDragPose(null))
  await expect(view(page)).toHaveAttribute('data-highlighted', '')
  await expect(interference(page)).toHaveCount(0)

  // 2. A real pointer drag of the gizmo, top view, orthographic.
  await page.locator('[data-testid=part-row][data-name="Battery 2"]').click()
  await page.getByTitle('Orthographic projection (P toggles)').click()
  await page.getByTitle(/^Top view/).click()
  await page.waitForTimeout(800)
  const from = await project(page, 'Battery 2')
  const to = await project(page, 'Battery 1')
  expect(from && to).toBeTruthy()
  await page.mouse.move(from!.x, from!.y)
  await page.mouse.down()
  // Most of the way towards Battery 1 (centres 45 mm apart): overlapping, not released.
  for (let i = 1; i <= 10; i++) await page.mouse.move(from!.x + ((to!.x - from!.x) * 0.6 * i) / 10, from!.y + ((to!.y - from!.y) * 0.6 * i) / 10)
  await expect.poll(() => dragging(page)).toBe(true)
  const ids = await page.evaluate(() =>
    (window as unknown as { __blazeTest: Hooks }).__blazeTest.assembly.getState().doc.parts.filter((p) => p.name.startsWith('Battery')).map((p) => p.id),
  )
  for (const id of ids) await expect(view(page)).toHaveAttribute('data-highlighted', new RegExp(id))
  expect(await snapshot(page)).toEqual(before) // nothing saved or recorded while dragging
  await page.mouse.up()
  await expect.poll(async () => (await snapshot(page)).undo).toBe(before.undo + 1)
  // The free-move handle follows the view plane, so the battery may also move a little in Z
  // (into the plate); the drag into Battery 1 is what this checks.
  await expect(interference(page).filter({ hasText: 'Battery 1 and Battery 2 overlap' })).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await expect(interference(page)).toHaveCount(0)
  expect(await snapshot(page)).toEqual(before)
  expect(errors).toEqual([])
})

test('without the test flag (a normal launch) there are no test hooks', async () => {
  const { app, page } = await launchApp(userData, { BLAZE_UAV_TEST_HOOKS: '0' })
  running.push(app)
  await open(page, 'Plain quad')
  const state = await page.evaluate(() => [
    typeof (window as unknown as { __blazeTest?: unknown }).__blazeTest,
    (window as unknown as { api: { testHooks: boolean } }).api.testHooks,
  ])
  expect(state).toEqual(['undefined', false])
})

test('environment: values are required, saved with the project, and a drop test sends them to the engine', async () => {
  mkdirSync(shots, { recursive: true })
  const first = await launchApp(userData)
  running.push(first.app)
  let page = first.page
  const errors = trackErrors(page)
  await open(page, 'Env quad')
  await commit(page, 'frame-mass', '300')

  const missing = page.getByTestId('environment-missing')
  await expect(missing.locator('li')).toHaveText([
    'Ground friction is not set: enter it under Environment in the workshop.',
    'Ground restitution is not set: enter it under Environment in the workshop.',
  ])
  await expect(page.getByTestId('run-drop-test')).toBeDisabled()
  await commit(page, 'ground-friction', '0.6')
  await expect(page.getByTestId('run-drop-test')).toBeDisabled()
  await commit(page, 'ground-restitution', '0')
  await expect(page.getByTestId('environment-ready')).toBeVisible()
  // An obstacle starts without its values: the readiness list names them.
  await page.getByTestId('add-obstacle').click()
  await expect(missing.locator('li')).toHaveText([
    'Friction of obstacle "Obstacle 1" is not set: enter it under Environment in the workshop.',
    'Restitution of obstacle "Obstacle 1" is not set: enter it under Environment in the workshop.',
  ])
  await commit(page, 'obstacle-1-friction', '0.5')
  await commit(page, 'obstacle-1-restitution', '0.1')
  await expect(page.getByTestId('environment-ready')).toBeVisible()

  // Drop test in the real engine: the frame alone, released 200 mm above the ground.
  await page.getByTestId('run-drop-test').click()
  await expect(page.getByTestId('drop-test-result')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('drop-contact').first()).toContainText('ground')
  // The frame rests on the ground: its origin (the bottom of the plate) within 0.5 mm of z = 0.
  expect(Math.abs(Number(await page.getByTestId('drop-z').textContent()))).toBeLessThan(0.5)
  await page.getByTestId('environment-panel').screenshot({ path: join(shots, '4.4-environment-drop-test.png') })
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 })
  expect(errors).toEqual([])
  await first.app.close()

  const second = await launchApp(userData)
  running.push(second.app)
  page = second.page
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Env quad' }).click()
  await expect(page.getByTestId('ground-friction')).toHaveValue('0.6')
  await expect(page.getByTestId('ground-restitution')).toHaveValue('0')
  await expect(page.getByTestId('obstacle-1-restitution')).toHaveValue('0.1')
  await expect(page.getByTestId('environment-ready')).toBeVisible()
})

test('an imported model collides as its convex hull, computed at import by the built app', async () => {
  mkdirSync(shots, { recursive: true })
  const { app, page } = await launchApp(userData)
  running.push(app)
  const errors = trackErrors(page)
  await open(page, 'Hull quad')
  const model = join(userData, 'pod.glb')
  writeFileSync(model, readFileSync(join(root, 'tests', 'fixtures', 'blender', 'pod.glb')))
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, model)
  await page.getByTestId('import-model').click()
  await page.getByRole('button', { name: 'Add to assembly' }).click()
  await expect(page.getByTestId('model-status')).toHaveAttribute('data-state', 'loaded')
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('b')
  // Plate + 4 arms + the model, which is a hull.
  await expect(view(page)).toHaveAttribute('data-shapes', '6')
  await expect(view(page)).toHaveAttribute('data-hulls', '1')
  await page.keyboard.press('f')
  await page.waitForTimeout(800)
  await page.getByTestId('viewport-3d').screenshot({ path: join(shots, '4.4-model-hull-debug-view.png') })
  expect(errors).toEqual([])
})
