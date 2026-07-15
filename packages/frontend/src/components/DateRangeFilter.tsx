import { CalendarDays } from 'lucide-react'
import { useEffect, useState } from 'react'

export interface DateRangeValue {
  dateFrom: string
  dateTo: string
}

interface DateRangeFilterProps extends DateRangeValue {
  onChange: (range: DateRangeValue) => void
  onClear?: () => void
  includeClear?: boolean
  className?: string
  compact?: boolean
}

const presets = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['specific', 'Specific Day'],
  ['7days', 'Last 7 Days'],
  ['30days', 'Last 30 Days'],
  ['month', 'This Month'],
  ['lastmonth', 'Last Month'],
  ['custom', 'Custom Range']
] as const
type PresetKey = typeof presets[number][0]

export function todayDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function isoDate(date: Date) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return localDate.toISOString().slice(0, 10)
}

export function presetDateRange(preset: string): DateRangeValue {
  const today = todayDate()
  const now = new Date(`${today}T00:00:00`)
  const start = new Date(now)
  const end = new Date(now)

  if (preset === 'yesterday') {
    start.setDate(now.getDate() - 1)
    end.setDate(now.getDate() - 1)
  }
  if (preset === '7days') start.setDate(now.getDate() - 6)
  if (preset === '30days') start.setDate(now.getDate() - 29)
  if (preset === 'month') start.setDate(1)
  if (preset === 'lastmonth') {
    start.setMonth(now.getMonth() - 1, 1)
    end.setDate(0)
  }

  return { dateFrom: isoDate(start), dateTo: isoDate(end) }
}

export function formatDisplayDate(value: string) {
  if (!value) return 'No date selected'
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' })
}

function matchingPreset(dateFrom: string, dateTo: string): PresetKey {
  if (!dateFrom && !dateTo) return 'custom'
  for (const [key] of presets) {
    if (key === 'specific' || key === 'custom') continue
    const range = presetDateRange(key)
    if (range.dateFrom === dateFrom && range.dateTo === dateTo) return key
  }
  if (dateFrom && dateFrom === dateTo) return 'specific'
  return 'custom'
}

function selectedLabel(dateFrom: string, dateTo: string) {
  if (!dateFrom && !dateTo) return 'All dates'
  if (dateFrom && dateTo && dateFrom === dateTo) return formatDisplayDate(dateFrom)
  if (dateFrom && dateTo) return `${formatDisplayDate(dateFrom)} to ${formatDisplayDate(dateTo)}`
  return dateFrom ? `From ${formatDisplayDate(dateFrom)}` : `Up to ${formatDisplayDate(dateTo)}`
}

export function DateRangeFilter({
  dateFrom,
  dateTo,
  onChange,
  onClear,
  includeClear = true,
  className = '',
  compact = false
}: DateRangeFilterProps) {
  const [activePreset, setActivePreset] = useState<PresetKey>(() => matchingPreset(dateFrom, dateTo))
  const showSingleDate = activePreset === 'specific'
  const showRange = activePreset === 'custom'

  useEffect(() => {
    if (!dateFrom && !dateTo) {
      setActivePreset('custom')
      return
    }
    if (activePreset !== 'specific' && activePreset !== 'custom') {
      setActivePreset(matchingPreset(dateFrom, dateTo))
    }
  }, [activePreset, dateFrom, dateTo])

  const changePreset = (preset: PresetKey) => {
    setActivePreset(preset)
    if (preset === 'custom') return
    if (preset === 'specific') {
      const value = dateFrom || dateTo || todayDate()
      onChange({ dateFrom: value, dateTo: value })
      return
    }
    onChange(presetDateRange(preset))
  }

  const changeSingleDate = (value: string) => onChange({ dateFrom: value, dateTo: value })
  const changeFrom = (value: string) => onChange({ dateFrom: value, dateTo: dateTo && value && value > dateTo ? value : dateTo })
  const changeTo = (value: string) => onChange({ dateFrom: dateFrom && value && value < dateFrom ? value : dateFrom, dateTo: value })

  return (
    <div className={`flex flex-col gap-2 ${compact ? 'sm:flex-row sm:items-center' : 'lg:flex-row lg:items-end'} ${className}`}>
      <label className="min-w-44 text-xs font-medium text-muted-foreground">
        Period
        <select
          value={activePreset}
          onChange={event => changePreset(event.target.value as PresetKey)}
          className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm text-foreground"
        >
          {presets.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
        </select>
      </label>

      {showSingleDate && (
        <label className="min-w-44 text-xs font-medium text-muted-foreground">
          Business date
          <input
            type="date"
            value={dateFrom || dateTo}
            onChange={event => changeSingleDate(event.target.value)}
            className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm text-foreground"
          />
        </label>
      )}

      {showRange && (
        <>
          <label className="min-w-40 text-xs font-medium text-muted-foreground">
            From
            <input
              type="date"
              value={dateFrom}
              onChange={event => changeFrom(event.target.value)}
              className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="min-w-40 text-xs font-medium text-muted-foreground">
            To
            <input
              type="date"
              value={dateTo}
              onChange={event => changeTo(event.target.value)}
              className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
        </>
      )}

      <div className={`flex items-center gap-2 text-sm text-muted-foreground ${compact ? 'sm:pt-5' : 'lg:pb-2'}`}>
        <CalendarDays className="h-4 w-4 shrink-0" />
        <span className="whitespace-nowrap">{selectedLabel(dateFrom, dateTo)}</span>
      </div>

      {includeClear && (dateFrom || dateTo) && (
        <button
          type="button"
          onClick={onClear || (() => onChange({ dateFrom: '', dateTo: '' }))}
          className={`rounded-lg border px-3 py-2 text-sm hover:bg-muted ${compact ? '' : 'lg:mb-0'}`}
        >
          Clear dates
        </button>
      )}
    </div>
  )
}
