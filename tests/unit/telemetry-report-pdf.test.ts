import { describe, expect, it, vi } from 'vitest'
import { handlePrintReportPdf } from '../../electron/ipc/handlers'
import { printCurrentReportPdf } from '../../electron/main/telemetry/report-pdf'

const id = '00000000-0000-4000-8000-000000000000'
const reportURL = 'file:///app/index.html#/telemetry/report/' + id

function fixture() {
  const bytes = Buffer.from('%PDF-fixture')
  return {
    bytes,
    contents: { getURL: vi.fn(() => reportURL), printToPDF: vi.fn(async () => bytes) },
    getTitle: vi.fn(async () => 'Test: ../ hover'),
    pick: vi.fn<() => Promise<string | undefined>>(async () => 'chosen'),
    write: vi.fn(async () => {}),
  }
}

describe('printing the active report', () => {
  it('returns a cancellation without printing or writing', async () => {
    const { contents, getTitle, pick, write } = fixture()
    pick.mockResolvedValue(undefined)
    const result = await handlePrintReportPdf(undefined, () => printCurrentReportPdf(contents, getTitle, pick, write))
    expect(result).toEqual({ ok: true, data: null })
    expect(getTitle).toHaveBeenCalledWith(id)
    expect(pick).toHaveBeenCalledWith('Test .. hover report.pdf')
    expect(contents.printToPDF).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('prints A4 and reports a disk write error', async () => {
    const { contents, getTitle, pick, write, bytes } = fixture()
    write.mockRejectedValue(new Error('Disk is full'))
    const result = await handlePrintReportPdf(undefined, () => printCurrentReportPdf(contents, getTitle, pick, write))
    expect(contents.printToPDF).toHaveBeenCalledWith(expect.objectContaining({
      pageSize: 'A4', preferCSSPageSize: true, displayHeaderFooter: true,
      footerTemplate: expect.stringMatching(/Test: \.\.\/ hover.*pageNumber.*totalPages/),
    }))
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/output\.pdf$/), bytes)
    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Could not save the report PDF. Disk is full' } })
  })

  it('rejects caller-supplied destinations and stops when the active report changes', async () => {
    const { contents, getTitle, pick, write } = fixture()
    const print = () => printCurrentReportPdf(contents, getTitle, pick, write)
    expect(await handlePrintReportPdf({ path: 'arbitrary.pdf' }, print)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    expect(getTitle).not.toHaveBeenCalled()
    pick.mockImplementation(async () => { contents.getURL.mockReturnValue('file:///app/index.html#/telemetry'); return 'chosen.pdf' })
    await expect(print()).rejects.toThrow('The current report changed')
    expect(contents.printToPDF).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})
