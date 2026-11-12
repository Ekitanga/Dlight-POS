import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { Check, Globe, Loader2, RefreshCcw, X } from 'lucide-react'
import { formatMoney } from '../../lib/format'

interface SyncRun {
  id: string
  trigger: 'scheduled' | 'manual'
  started_at: string
  finished_at: string | null
  status: 'running' | 'success' | 'failed'
  fetched: number
  new_seen: number
  added: number
  review: number
  error: string | null
  started_by_name: string | null
}

interface ReviewItem {
  website_product_id: string
  name: string
  price: string | null
  category: string | null
  permalink: string | null
  reason: string | null
  matched_product_name: string | null
  matched_product_price: string | null
}

interface AddedItem {
  website_product_id: string
  name: string
  price: string | null
  category: string | null
  added_at: string
}

interface SyncStatus {
  settings: { enabled: boolean; source_url: string; run_hour: number }
  running: boolean
  runs: SyncRun[]
  counts: Record<string, number>
  review: ReviewItem[]
  recently_added: AddedItem[]
}

function when(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function apiError(error: unknown, fallback: string) {
  return (error as any)?.response?.data?.error?.message || fallback
}

/**
 * Daily import of NEW products from the website. Rendered inside the Settings
 * form, so every button is type="button" and never submits that form.
 */
export function WebsiteSyncSection() {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busyItem, setBusyItem] = useState('')
  const [showAdded, setShowAdded] = useState(false)

  const { data, isLoading } = useQuery<SyncStatus>({
    queryKey: ['website-sync'],
    queryFn: async () => (await axios.get('/api/website-sync/status')).data
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['website-sync'] })

  const toggle = useMutation({
    mutationFn: async (enabled: boolean) => (await axios.put('/api/website-sync/settings', { enabled })).data,
    onSuccess: (_data, enabled) => { setError(''); setMessage(enabled ? 'Daily website check switched on.' : 'Daily website check switched off.'); refresh() },
    onError: err => { setMessage(''); setError(apiError(err, 'Could not save')) }
  })

  const runNow = useMutation({
    mutationFn: async () => (await axios.post('/api/website-sync/run')).data,
    onSuccess: summary => {
      setError('')
      setMessage(summary.newSeen === 0
        ? `Checked ${summary.fetched} website products. Nothing new.`
        : `Checked ${summary.fetched} website products: ${summary.added} added, ${summary.review} for review, ${summary.skippedVariant} colour versions skipped, ${summary.existing} already in the POS.`)
      refresh()
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
    onError: err => { setMessage(''); setError(apiError(err, 'Website check failed')) }
  })

  const decide = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'add' | 'skip' }) => (await axios.post(`/api/website-sync/items/${id}/${action}`)).data,
    onMutate: ({ id }) => setBusyItem(id),
    onSuccess: (_data, { action }) => { setError(''); setMessage(action === 'add' ? 'Product added to the POS.' : 'Product skipped. It will not come back.'); refresh() },
    onError: err => { setMessage(''); setError(apiError(err, 'Could not save the decision')) },
    onSettled: () => setBusyItem('')
  })

  const settings = data?.settings
  const lastRun = data?.runs?.[0]
  const runHour = String(settings?.run_hour ?? 6).padStart(2, '0')

  return (
    <section className="min-w-0 space-y-5 border-b pb-8">
      <div className="flex items-center gap-2">
        <Globe className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-semibold">Website Products</h2>
          <p className="text-sm text-muted-foreground">
            Every day at {runHour}:00 the POS checks dlightgiftshop.com and adds new products as supplier-fulfilled, stock 0, at the website price.
            Existing products are never changed. Colour versions of a model already in the POS are skipped; anything uncertain waits here for you.
          </p>
        </div>
      </div>

      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings?.enabled === true}
                disabled={toggle.isPending}
                onChange={event => toggle.mutate(event.target.checked)}
                className="h-4 w-4"
              />
              Daily website check enabled
            </label>
            <button
              type="button"
              disabled={runNow.isPending || data.running}
              onClick={() => runNow.mutate()}
              className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {runNow.isPending || data.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              {runNow.isPending || data.running ? 'Checking website…' : 'Check now'}
            </button>
          </div>

          <p className="text-sm text-muted-foreground">
            Last check: {lastRun ? (
              <>
                {when(lastRun.started_at)} ({lastRun.trigger === 'manual' ? `by ${lastRun.started_by_name || 'admin'}` : 'automatic'}) —{' '}
                {lastRun.status === 'failed'
                  ? <span className="text-destructive">failed: {lastRun.error}</span>
                  : lastRun.status === 'running'
                    ? 'still running'
                    : `${lastRun.added} added, ${lastRun.review} for review`}
              </>
            ) : 'not run yet'}
            {' · '}Tracking {Object.values(data.counts).reduce((sum, n) => sum + n, 0)} website products
          </p>

          {(message || error) && (
            <div className={`rounded-lg border p-3 text-sm ${error ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'}`}>
              {error || message}
            </div>
          )}

          <div className="rounded-lg border">
            <div className="border-b px-4 py-3">
              <h3 className="font-semibold">Needs your decision ({data.review.length})</h3>
              <p className="text-xs text-muted-foreground">These look close to a product already in the POS. Add only if it is a different product.</p>
            </div>
            {data.review.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">Nothing to review.</p>
            ) : (
              <ul className="divide-y">
                {data.review.map(item => (
                  <li key={item.website_product_id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">
                        {item.permalink ? <a href={item.permalink} target="_blank" rel="noreferrer" className="hover:underline">{item.name}</a> : item.name}
                        <span className="ml-2 text-muted-foreground">{item.price ? formatMoney(item.price) : 'no price'}</span>
                      </p>
                      {item.matched_product_name && (
                        <p className="text-xs text-muted-foreground">In POS: {item.matched_product_name}{item.matched_product_price ? ` (${formatMoney(item.matched_product_price)})` : ''}</p>
                      )}
                      {item.reason && <p className="text-xs text-muted-foreground">{item.reason}</p>}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: item.website_product_id, action: 'add' })}
                        className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {busyItem === item.website_product_id && decide.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Add to POS
                      </button>
                      <button
                        type="button"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: item.website_product_id, action: 'skip' })}
                        className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" />
                        Skip
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <button type="button" onClick={() => setShowAdded(value => !value)} className="text-sm font-medium text-primary hover:underline">
              {showAdded ? 'Hide' : 'Show'} products added in the last 60 days ({data.recently_added.length})
            </button>
            {showAdded && (
              <ul className="mt-2 divide-y rounded-lg border text-sm">
                {data.recently_added.map(item => (
                  <li key={item.website_product_id} className="flex justify-between gap-3 px-4 py-2">
                    <span className="min-w-0 truncate">{item.name}</span>
                    <span className="shrink-0 text-muted-foreground">{item.price ? formatMoney(item.price) : ''} · {when(item.added_at)}</span>
                  </li>
                ))}
                {data.recently_added.length === 0 && <li className="px-4 py-3 text-muted-foreground">None yet.</li>}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}
