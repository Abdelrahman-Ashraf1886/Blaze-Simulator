import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { groupAxes, MAX_AXES, type PlotChannel } from './layout'

export const fieldClass = 'min-w-0 rounded-sm border border-line-strong bg-bg px-2 py-1 text-fg'

interface PickerProps {
  available: readonly PlotChannel[]
  selected: readonly string[]
  onChange: (names: string[]) => void
}

export function ChannelPicker({ available, selected, onChange }: PickerProps) {
  const searchId = useId()
  const channelId = useId()
  const [search, setSearch] = useState('')
  const [choice, setChoice] = useState('')
  const [notice, setNotice] = useState('')
  const byName = new Map(available.map((channel) => [channel.name, channel]))
  const query = search.trim().toLowerCase()
  const groups = new Map<string, PlotChannel[]>()
  for (const channel of available) {
    if (selected.includes(channel.name)) continue
    if (!`${channel.label} ${channel.name} ${channel.unit} ${channel.group}`.toLowerCase().includes(query)) continue
    const group = groups.get(channel.group)
    if (group) group.push(channel)
    else groups.set(channel.group, [channel])
  }
  const selectable = [...groups.values()].some((channels) => channels.some(({ name }) => name === choice))

  function add() {
    if (!selectable) return
    const next = [...selected, choice]
    const channels = next.flatMap((name) => byName.get(name) ?? [])
    if (groupAxes(channels).size > MAX_AXES) {
      setNotice('This graph already uses two units. Add another graph for this channel.')
      return
    }
    setNotice('')
    setChoice('')
    onChange(next)
  }

  return (
    <details className="rounded-sm border border-line bg-bg p-3">
      <summary className="cursor-pointer font-medium text-accent">Edit channels</summary>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label htmlFor={searchId} className="grid min-w-0 gap-1 text-fg-muted">
          Search channels
          <input id={searchId} type="search" className={fieldClass} value={search}
            onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label htmlFor={channelId} className="grid min-w-0 gap-1 text-fg-muted">
          Channel
          <select id={channelId} className={fieldClass} value={selectable ? choice : ''}
            onChange={(event) => { setChoice(event.target.value); setNotice('') }}>
            <option value="">{groups.size ? 'Choose a channel' : 'No matching channels'}</option>
            {[...groups].map(([group, channels]) => (
              <optgroup key={group} label={group[0]!.toUpperCase() + group.slice(1)}>
                {channels.map(({ name, label, unit }) => <option key={name} value={name}>{label} ({unit})</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <Button size="sm" disabled={!selectable} onClick={add}>Add channel</Button>
      </div>
      {notice && <p role="status" className="mt-2 text-warn">{notice}</p>}
      {selected.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {selected.map((name) => {
            const channel = byName.get(name)
            return (
              <li key={name} className="flex min-w-0 items-center gap-1 rounded-sm border border-line pl-2">
                <span className={channel ? 'break-all' : 'break-all text-warn'}>
                  {channel ? `${channel.label} (${channel.unit})` : `${name} (not in this run)`}
                </span>
                <Button size="sm" variant="ghost" aria-label={`Remove ${channel?.label ?? name}`}
                  onClick={() => { setNotice(''); onChange(selected.filter((item) => item !== name)) }}>×</Button>
              </li>
            )
          })}
        </ul>
      )}
    </details>
  )
}
