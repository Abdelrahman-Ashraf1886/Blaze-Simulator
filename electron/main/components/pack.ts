/**
 * Component packs: JSON files for sharing library records.
 *
 * Format (version 1):
 *   { "format": "blaze-uav.components", "version": 1, "exportedAt": ISO,
 *     "components": [ { "id", "category", "name", "manufacturer", "notes", "specs" } ] }
 *
 * Import is all or nothing. Every entry is validated with the same schema as a
 * user edit, so provenance rules apply to imported data too. Entries whose id is
 * already in the library are skipped (re-importing a pack adds nothing). Pure
 * apart from the repositories, so it is unit tested without dialogs.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Component, ComponentInput } from '../../ipc/component-fields'
import { componentInputSchema, describeIssues } from '../../ipc/component-schemas'
import type { Repositories } from '../db/repositories'

export const PACK_FORMAT = 'blaze-uav.components'
export const PACK_VERSION = 1
/** Large enough for thousands of components; refuses anything that is clearly not a pack. */
export const MAX_PACK_BYTES = 10 * 1024 * 1024
export const MAX_PACK_ENTRIES = 5000

export class PackError extends Error {}

export interface PackSummary {
  imported: number
  skipped: number
}

export function buildPack(components: readonly Component[], exportedAt: Date = new Date()): string {
  const pack = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    exportedAt: exportedAt.toISOString(),
    components: components.map((c) => ({
      id: c.id,
      category: c.category,
      name: c.name,
      manufacturer: c.manufacturer,
      notes: c.notes,
      specs: c.specs,
    })),
  }
  return `${JSON.stringify(pack, null, 2)}\n`
}

const headerSchema = z.object({
  format: z.literal(PACK_FORMAT, { message: 'This is not a Blaze UAV component pack' }),
  version: z.literal(PACK_VERSION, { message: `Only pack version ${PACK_VERSION} is supported` }),
  components: z.array(z.unknown()).max(MAX_PACK_ENTRIES, `A pack can hold at most ${MAX_PACK_ENTRIES} components`),
})

/** Parses and validates a whole pack; throws PackError listing every bad entry. */
export function parsePack(text: string): { id: string | null; input: ComponentInput }[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_PACK_BYTES) throw new PackError('The file is larger than 10 MB.')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new PackError('The file is not valid JSON.')
  }
  const head = headerSchema.safeParse(json)
  if (!head.success) throw new PackError(head.error.issues[0]!.message)

  const problems: string[] = []
  const entries: { id: string | null; input: ComponentInput }[] = []
  head.data.components.forEach((raw, i) => {
    const label = `Entry ${i + 1}${raw && typeof raw === 'object' && 'name' in raw ? ` (${String((raw as { name: unknown }).name).slice(0, 60)})` : ''}`
    if (!raw || typeof raw !== 'object') return void problems.push(`${label}: not an object`)
    const { id, ...rest } = raw as Record<string, unknown>
    if (id !== undefined && !z.uuid().safeParse(id).success) return void problems.push(`${label}: id must be a UUID`)
    const parsed = componentInputSchema.safeParse(rest)
    if (!parsed.success) return void problems.push(`${label}: ${describeIssues(parsed.error.issues, rest)}`)
    entries.push({ id: (id as string | undefined) ?? null, input: parsed.data })
  })
  const ids = entries.map((e) => e.id).filter(Boolean)
  if (new Set(ids).size !== ids.length) problems.push('Two entries share the same id')
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join('\n')
    throw new PackError(`Nothing was imported. ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${shown}${problems.length > 5 ? `\n…and ${problems.length - 5} more` : ''}`)
  }
  return entries
}

/** Validates the whole pack first, then inserts every new entry in one transaction. */
export function importPack(repos: Repositories, text: string): PackSummary {
  const entries = parsePack(text)
  return repos.transaction(() => {
    let imported = 0
    let skipped = 0
    for (const e of entries) {
      if (e.id && repos.components.exists(e.id)) {
        skipped++
        continue
      }
      repos.components.create(e.input, 'imported', e.id ?? randomUUID())
      imported++
    }
    return { imported, skipped }
  })
}
