import { writeFile } from 'node:fs/promises'
import type { WebContents } from 'electron'
import { recordingIdSchema } from '../../ipc/schemas'
import { safeFileName } from '../screenshot'

type ReportContents = Pick<WebContents, 'getURL' | 'printToPDF'>

function currentReportId(url: string) {
  const hash = new URL(url).hash
  const path = /^#\/telemetry\/report\/([^/?#]+)$/.exec(hash)
  return path && recordingIdSchema.safeParse({ id: path[1] }).data?.id
}

export async function printCurrentReportPdf(
  contents: ReportContents,
  getTitle: (id: string) => Promise<string | undefined>,
  pickDestination: (fileName: string) => Promise<string | undefined>,
  write: (path: string, bytes: Buffer) => Promise<void> = writeFile,
) {
  const url = contents.getURL()
  const id = currentReportId(url)
  if (!id) throw new Error('Open a recording report to save a PDF.')
  const title = await getTitle(id)
  const assertCurrentReport = () => {
    if (contents.getURL() !== url) throw new Error('The current report changed before printing.')
  }
  assertCurrentReport()
  const path = await pickDestination(safeFileName((title || 'Blaze UAV flight') + ' report') + '.pdf')
  if (!path) return null
  assertCurrentReport()
  const destination = /\.pdf$/i.test(path) ? path : path + '.pdf'
  const bytes = await contents.printToPDF({ pageSize: 'A4', preferCSSPageSize: true })
  assertCurrentReport()
  await write(destination, bytes)
  return { path: destination }
}
