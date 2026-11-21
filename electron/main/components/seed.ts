/**
 * Built-in components: the cited starter set in `database/seed/components.v1.json`.
 *
 * Loaded at every start (cheap: ~20 records):
 * - a record that is not in the library is added as `built-in`;
 * - a built-in record whose stored content differs from the seed is updated in
 *   place, so corrections in a new app version reach existing installs;
 * - records the user owns are never touched, and built-ins dropped from the seed
 *   are kept (projects may reference them).
 *
 * The seed goes through the same validation as any import, so the citation rule
 * holds for built-in data too; an invalid seed fails loudly in tests.
 */
import seedText from '../../../database/seed/components.v1.json?raw'
import type { ComponentInput } from '../../ipc/component-fields'
import type { Repositories } from '../db/repositories'
import { parsePack } from './pack'

export interface SeedSummary {
  added: number
  updated: number
  unchanged: number
}

const content = (c: ComponentInput) =>
  JSON.stringify({ name: c.name, manufacturer: c.manufacturer, notes: c.notes, specs: c.specs })

export function loadBuiltIns(repos: Repositories, text: string = seedText): SeedSummary {
  const entries = parsePack(text)
  return repos.transaction(() => {
    const summary: SeedSummary = { added: 0, updated: 0, unchanged: 0 }
    for (const { id, input } of entries) {
      if (!id) throw new Error('Every built-in component needs a fixed id')
      if (!repos.components.exists(id)) {
        repos.components.create(input, 'built-in', id)
        summary.added++
        continue
      }
      const stored = repos.components.get(id)
      if (stored.origin !== 'built-in' || content(stored) === content(input)) {
        summary.unchanged++
        continue
      }
      repos.components.replaceBuiltIn(id, input)
      summary.updated++
    }
    return summary
  })
}
