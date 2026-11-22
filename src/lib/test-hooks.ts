/**
 * Handles for end-to-end tests on `window.__blazeTest`: the workshop stores and a helper
 * that projects a part to screen pixels (registered by the 3D view). They exist only in a
 * development build or when main was started for tests (`BLAZE_UAV_TEST_HOOKS=1`, which
 * sets `window.api.testHooks`); a normal launch of the packaged app has none.
 */

export function testHooksEnabled(): boolean {
  const api = (window as unknown as { api?: { testHooks?: boolean } }).api
  return import.meta.env.DEV || api?.testHooks === true
}

/** Sets `window.__blazeTest[name]` when hooks are enabled; returns a function that removes it. */
export function registerTestHook(name: string, value: unknown): () => void {
  if (!testHooksEnabled()) return () => {}
  const w = window as unknown as { __blazeTest?: Record<string, unknown> }
  const hooks = (w.__blazeTest ??= {})
  hooks[name] = value
  return () => {
    if (hooks[name] === value) delete hooks[name]
  }
}
