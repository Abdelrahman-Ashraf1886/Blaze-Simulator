import { writeFile } from 'node:fs/promises'
import type { WebContents } from 'electron'
import { recordingIdSchema } from '../../ipc/schemas'
import { safeFileName, writeConfirmedFile } from '../screenshot'

type ReportContents = Pick<WebContents, 'getURL' | 'printToPDF'>

function currentReportId(url: string) {
  const hash = new URL(url).hash
  const path = /^#\/telemetry\/report\/([^/?#]+)$/.exec(hash)
  return path && recordingIdSchema.safeParse({ id: path[1] }).data?.id
}

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

/** Chromium fills the page number spans; the title is user text and the template is HTML. */
function footer(title: string) {
  return '<div style="width: 100%; margin: 0 12mm; font: 8px sans-serif; color: #333; display: flex; justify-content: space-between">' +
    '<span>' + title.replace(/[&<>"]/g, (char) => escapes[char]!) + '</span>' +
    '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>'
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
  const bytes = await contents.printToPDF({
    pageSize: 'A4', preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer(title || 'Blaze UAV flight'),
  })
  assertCurrentReport()
  return { path: await writeConfirmedFile(path, '.pdf', (target) => write(target, bytes)) }
}
