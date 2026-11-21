/**
 * Per-user UI conveniences (sidebar state and similar). Stored in localStorage;
 * every access is guarded because storage can be unavailable or cleared, and the
 * UI must work without it. Never use this for project data — that lives in SQLite.
 */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* preference is simply not remembered */
  }
}
