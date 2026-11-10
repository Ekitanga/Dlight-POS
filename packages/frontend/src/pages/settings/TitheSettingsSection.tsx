import { useEffect, useState, type KeyboardEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { HandCoins, Loader2, Save } from 'lucide-react'
import { titheBasisLabels, useTitheSettings, type TitheBasis, type TitheSettings } from '../../lib/tithe'

const inputClass = 'w-full rounded-md border px-3 py-2.5 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none'

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/**
 * Tithe controls. Rendered inside the main Settings form, so it saves through
 * its own button and never submits the surrounding form.
 */
export function TitheSettingsSection() {
  const queryClient = useQueryClient()
  const { data: settings, isLoading } = useTitheSettings()
  const [draft, setDraft] = useState<TitheSettings | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (settings) setDraft(settings)
  }, [settings])

  const save = useMutation({
    mutationFn: async (next: TitheSettings) => (await axios.put('/api/tithe/settings', {
      enabled: next.enabled,
      rate_percent: Number(next.rate_percent),
      basis: next.basis,
      start_date: next.start_date,
      recipient_name: next.recipient_name || ''
    })).data as TitheSettings,
    onSuccess: saved => {
      queryClient.setQueryData(['tithe-settings'], saved)
      queryClient.invalidateQueries({ queryKey: ['tithe-summary'] })
      setError('')
      setMessage(saved.enabled ? 'Tithe settings saved.' : 'Tithe tracking switched off. History is kept.')
    },
    onError: err => {
      setMessage('')
      setError((err as any)?.response?.data?.error?.message || 'Could not save tithe settings')
    }
  })

  const stopEnter = (event: KeyboardEvent) => {
    if (event.key === 'Enter') event.preventDefault()
  }

  return (
    <section className="min-w-0 space-y-5 border-b pb-8">
      <div className="flex items-center gap-2">
        <HandCoins className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-semibold">Tithe</h2>
          <p className="text-sm text-muted-foreground">Work out the tithe due from the business each month. Only owners and administrators can see it.</p>
        </div>
      </div>

      {isLoading || !draft ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={event => setDraft({ ...draft, enabled: event.target.checked })}
              className="h-4 w-4"
            />
            Tithe tracking enabled
          </label>

          {draft.enabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">Tithe rate (%)
                <input
                  type="number" min="0.01" max="100" step="0.01"
                  value={draft.rate_percent}
                  onKeyDown={stopEnter}
                  onChange={event => setDraft({ ...draft, rate_percent: event.target.value as unknown as number })}
                  className={`${inputClass} mt-1.5`}
                />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">A tithe is traditionally 10%.</span>
              </label>
              <label className="text-sm font-medium">Calculate on
                <select
                  value={draft.basis}
                  onChange={event => setDraft({ ...draft, basis: event.target.value as TitheBasis })}
                  className={`${inputClass} mt-1.5`}
                >
                  {(Object.keys(titheBasisLabels) as TitheBasis[]).map(basis => (
                    <option key={basis} value={basis}>{titheBasisLabels[basis].label}{basis === 'net_profit' ? ' (recommended)' : ''}</option>
                  ))}
                </select>
                <span className="mt-1 block text-xs font-normal text-muted-foreground">{titheBasisLabels[draft.basis].help}</span>
              </label>
              <label className="text-sm font-medium">Count from
                <input
                  type="date" max={today()}
                  value={draft.start_date}
                  onKeyDown={stopEnter}
                  onChange={event => setDraft({ ...draft, start_date: event.target.value })}
                  className={`${inputClass} mt-1.5`}
                />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">Tithe is owed on business from this date onward.</span>
              </label>
              <label className="text-sm font-medium">Usually given to
                <input
                  value={draft.recipient_name || ''}
                  onKeyDown={stopEnter}
                  onChange={event => setDraft({ ...draft, recipient_name: event.target.value })}
                  className={`${inputClass} mt-1.5`}
                  placeholder="Church or ministry name"
                />
              </label>
            </div>
          )}

          {(message || error) && (
            <div className={`rounded-lg border p-3 text-sm ${error ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'}`}>
              {error || message}
            </div>
          )}

          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate(draft)}
            className="inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save tithe settings
          </button>
        </>
      )}
    </section>
  )
}
