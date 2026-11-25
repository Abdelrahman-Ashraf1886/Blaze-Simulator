import type { ReactNode } from 'react'

// DESIGN.md:20–22 uses six significant digits for instrument values.
const decimal = new Intl.NumberFormat('en', { maximumSignificantDigits: 6, useGrouping: false })
const scientific = new Intl.NumberFormat('en', { maximumSignificantDigits: 6, notation: 'scientific' })

export function reportNumber(value: number) {
  return (value !== 0 && Math.abs(value) < 1e-3 ? scientific : decimal).format(value).replace('E', 'e')
}

export function quantity(value: number, unit: string) {
  return reportNumber(value) + ' ' + unit
}

export function vector(values: readonly number[], unit?: string) {
  return '(' + values.map(reportNumber).join(', ') + ')' + (unit ? ' ' + unit : '')
}

export function Value({ value }: { value: unknown }) {
  if (value === undefined) return <span className="report-muted">Not recorded</span>
  if (value !== null && typeof value === 'object') {
    return <pre className="report-value num">{JSON.stringify(value, null, 2)}</pre>
  }
  return <span className={typeof value === 'number' ? 'num' : undefined}>
    {typeof value === 'number' ? reportNumber(value) : String(value)}
  </span>
}

export type Fact = [label: string, value: unknown]

export function Facts({ rows }: { rows: Fact[] }) {
  return <dl className="report-facts">
    {rows.map(([label, value]) => <div key={label}>
      <dt className="report-muted">{label}</dt><dd><Value value={value} /></dd>
    </div>)}
  </dl>
}

export function ReportTable({ title, columns, rows }: {
  title: string
  columns: string[]
  rows: [label: string, ...cells: ReactNode[]][]
}) {
  return <table className="report-table">
    <caption>{title}</caption>
    <thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{rows.map(([label, ...cells]) => <tr key={label}>
      <th scope="row">{label}</th>
      {cells.map((cell, index) => <td key={columns[index + 1]}>{cell}</td>)}
    </tr>)}</tbody>
  </table>
}
