/** Check container nesting before parsing. JSON.parse still validates the syntax. */
export function jsonDepthWithin(text: string, limit: number): boolean {
  let depth = 0
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const first = text[i]
    if (quoted) {
      if (first === '\\') i++
      else if (first === '"') quoted = false
      continue
    }
    if (first === '"') quoted = true
    else if (first === '[' || first === '{') {
      if (++depth > limit) return false
    } else if (first === ']' || first === '}') {
      if (--depth < 0) return false
    }
  }
  return true
}
