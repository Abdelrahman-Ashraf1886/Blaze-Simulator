/**
 * Checks for viewport images sent by the renderer before main writes them to a
 * file the user picked. Pure, so it is unit tested.
 */
import { link, lstat, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const savePngSchema = z.object({
  bytes: z
    .instanceof(Uint8Array, { message: 'Image data is missing' })
    .refine((b) => b.byteLength > 0 && b.byteLength <= MAX_IMAGE_BYTES, 'Image is empty or larger than 50 MB')
    .refine((b) => PNG_SIGNATURE.every((v, i) => b[i] === v), 'Image is not a PNG'),
  /** Proposed file name without extension; cleaned before use. */
  name: z.string().max(200),
})

/** A file name that is valid on Windows, macOS and Linux, with a fallback. */
export function safeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120)
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i
  return cleaned && !reserved.test(cleaned) ? cleaned : 'Blaze UAV view'
}

/** Publish the file the dialog confirmed. An appended extension never authorizes replacement. */
export async function writeConfirmedFile(selected: string, extension: string, write: (path: string) => Promise<void>): Promise<string> {
  const appended = !selected.toLowerCase().endsWith(extension)
  const destination = appended ? selected + extension : selected
  const exists = () => new Error(`"${destination}" already exists. Choose that exact file to replace it.`)
  if (appended) {
    const stat = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (stat) throw exists()
  }
  const staging = await mkdtemp(join(dirname(destination), '.blaze-save-'))
  const temp = join(staging, `output${extension}`)
  try {
    await write(temp)
    if (appended) {
      await link(temp, destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw exists()
        throw error
      })
    } else {
      await rename(temp, destination)
    }
    return destination
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
