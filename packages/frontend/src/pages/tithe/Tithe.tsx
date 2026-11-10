import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { HandCoins, Info, Plus, X } from 'lucide-react'
import { formatMoney } from '../../lib/format'
import { titheBasisLabels, useTitheSettings, type TitheSettings } from '../../lib/tithe'

interface TitheMonth {
  month: string
  period_start: string
  period_end: string
  in_progress: boolean
  revenue: number
  gross_profit: number
  net_profit: number
  basis_amount: number
  tithe_due: number
  paid: number
  balance_after: number
}

interface TitheSummary {
  as_of: string
  settings: TitheSettings
  totals: {
    total_due: number
    total_paid: number
    outstanding: number
    outstanding_completed_months: number
    current_month_accrued: number
  }
  months: TitheMonth[]
}

interface TithePayment {
  id: string
  amount: string
  paid_on: string
  payment_method: string
  recipient: string | null
  reference: string | null
  notes: string | null
  created_by_name: string | null
  voided_at: string | null
  void_reason: string | null
}

const methodLabels: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', bank_transfer: 'Bank transfer', other: 'Other' }

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function monthLabel(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleDateString('en-KE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function dateLabel(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function apiError(error: unknown, fallback: string) {
  return (error as any)?.response?.data?.error?.message || fallback
}

const inputClass = 'w-full rounded-lg border px-3 py-2'

export function Tithe() {
  const queryClient = useQueryClient()
  const { data: settings, isLoading: settingsLoading } = useTitheSettings()
  const enabled = settings?.enabled === true
  const [showForm, setShowForm] = useState(false)
  const [formError, setFormError] = useState('')
  const [form, setForm] = useState({ amount: '', paid_on: today(), payment_method: 'mpesa', recipient: '', reference: '', notes: '' })
  const [voiding, setVoiding] = useState<TithePayment | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidError, setVoidError] = useState('')

  const { data: summary, isLoading: summaryLoading, error: summaryError } = useQuery<TitheSummary>({
    queryKey: ['tithe-summary'],
    queryFn: async () => (await axios.get('/api/tithe/summary')).data,
    enabled
  })

  const { data: payments = [] } = useQuery<TithePayment[]>({
    queryKey: ['tithe-payments'],
    queryFn: async () => (await axios.get('/api/tithe/payments?include_voided=true')).data,
    enabled
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['tithe-summary'] })
    queryClient.invalidateQueries({ queryKey: ['tithe-payments'] })
  }

  const recordPayment = useMutation({
    mutationFn: async () => (await axios.post('/api/tithe/payments', { ...form, amount: Number(form.amount) })).data,
    onSuccess: () => {
      setShowForm(false)
      setFormError('')
      setForm({ amount: '', paid_on: today(), payment_method: 'mpesa', recipient: '', reference: '', notes: '' })
      refresh()
    },
    onError: error => setFormError(apiError(error, 'Could not record the payment'))
  })

  const voidPayment = useMutation({
    mutationFn: async () => (await axios.post(`/api/tithe/payments/${voiding?.id}/void`, { reason: voidReason })).data,
    onSuccess: () => {
      setVoiding(null)
      setVoidReason('')
      setVoidError('')
      refresh()
    },
    onError: error => setVoidError(apiError(error, 'Could not void the payment'))
  })

  if (settingsLoading) {
    return <div className="flex h-64 items-center justify-center text-muted-foreground">Loading tithe…</div>
  }

  if (!settings || !enabled) {
    return (
      <div className="mx-auto max-w-xl space-y-3 rounded-lg border bg-card p-6 text-center">
        <HandCoins className="mx-auto h-8 w-8 text-primary" />
        <h1 className="text-xl font-semibold">Tithe tracking is off</h1>
        <p className="text-sm text-muted-foreground">Switch it on in Settings to see how much tithe is due from the business each month.</p>
        <Link to="/settings" className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Open Settings</Link>
      </div>
    )
  }

  const totals = summary?.totals
  const basis = titheBasisLabels[settings.basis]
  const outstanding = totals?.outstanding || 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Tithe</h1>
          <p className="text-muted-foreground">
            {settings.rate_percent}% of {basis.label.toLowerCase()} since {dateLabel(settings.start_date)}
            {settings.recipient_name ? ` · given to ${settings.recipient_name}` : ''}
          </p>
        </div>
        <button
          onClick={() => { setShowForm(true); setFormError(''); setForm(current => ({ ...current, amount: outstanding > 0 ? String(Math.round(outstanding)) : '' })) }}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Record tithe given
        </button>
      </div>

      {summaryError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {apiError(summaryError, 'Could not load the tithe summary')}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4 sm:col-span-2 lg:col-span-1">
          <p className="text-sm text-muted-foreground">{outstanding >= 0 ? 'Tithe to pay now' : 'Given in advance'}</p>
          <p className={`mt-1 text-2xl font-bold ${outstanding > 0 ? 'text-primary' : 'text-emerald-600'}`}>
            {summaryLoading ? '…' : formatMoney(Math.abs(outstanding))}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Everything owed to date, including this month so far, less what has been given.</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Owed for finished months</p>
          <p className="mt-1 text-xl font-semibold">{summaryLoading ? '…' : formatMoney(Math.max(0, totals?.outstanding_completed_months || 0))}</p>
          <p className="mt-1 text-xs text-muted-foreground">Months that have closed, after payments.</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">This month so far</p>
          <p className="mt-1 text-xl font-semibold">{summaryLoading ? '…' : formatMoney(totals?.current_month_accrued || 0)}</p>
          <p className="mt-1 text-xs text-muted-foreground">Keeps growing until the month ends.</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Total given</p>
          <p className="mt-1 text-xl font-semibold">{summaryLoading ? '…' : formatMoney(totals?.total_paid || 0)}</p>
          <p className="mt-1 text-xs text-muted-foreground">Of {formatMoney(totals?.total_due || 0)} due since {dateLabel(settings.start_date)}.</p>
        </div>
      </div>

      <div className="flex gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="space-y-1">
          <p><strong>How this is worked out:</strong> each month, {settings.rate_percent}% of the business&apos;s {basis.label.toLowerCase()}. {basis.help}</p>
          <p className="text-muted-foreground">Only completed (delivered or collected) orders count, the same as Reports &gt; Profit. A month that made a loss owes no tithe and does not reduce other months. Change the rate or basis in Settings.</p>
        </div>
      </div>

      {showForm && (
        <div className="rounded-lg border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Record tithe given</h2>
            <button onClick={() => setShowForm(false)} className="rounded p-1 hover:bg-muted" aria-label="Close"><X className="h-4 w-4" /></button>
          </div>
          {formError && <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{formError}</div>}
          <form
            onSubmit={event => { event.preventDefault(); recordPayment.mutate() }}
            className="grid grid-cols-1 gap-4 md:grid-cols-3"
          >
            <label className="text-sm font-medium">Amount (KES) *
              <input type="number" min="1" step="0.01" required value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className={`${inputClass} mt-1`} />
            </label>
            <label className="text-sm font-medium">Date given *
              <input type="date" required max={today()} min={settings.start_date} value={form.paid_on} onChange={e => setForm({ ...form, paid_on: e.target.value })} className={`${inputClass} mt-1`} />
            </label>
            <label className="text-sm font-medium">Paid by *
              <select value={form.payment_method} onChange={e => setForm({ ...form, payment_method: e.target.value })} className={`${inputClass} mt-1`}>
                {Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium">Given to
              <input value={form.recipient} onChange={e => setForm({ ...form, recipient: e.target.value })} className={`${inputClass} mt-1`} placeholder={settings.recipient_name || 'Church or ministry'} />
            </label>
            <label className="text-sm font-medium">Reference
              <input value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} className={`${inputClass} mt-1`} placeholder="M-Pesa code, receipt no." />
            </label>
            <label className="text-sm font-medium">Notes
              <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className={`${inputClass} mt-1`} placeholder="Optional" />
            </label>
            <div className="md:col-span-3">
              <button disabled={recordPayment.isPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                {recordPayment.isPending ? 'Saving…' : 'Save payment'}
              </button>
            </div>
          </form>
        </div>
      )}

      <section className="rounded-lg border bg-card">
        <h2 className="border-b px-4 py-3 font-semibold">Month by month</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Month</th>
                <th className="px-4 py-2 text-right">Sales</th>
                <th className="px-4 py-2 text-right">{basis.label}</th>
                <th className="px-4 py-2 text-right">Tithe ({settings.rate_percent}%)</th>
                <th className="px-4 py-2 text-right">Given</th>
                <th className="px-4 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.months || []).map(row => (
                <tr key={row.month} className="border-t">
                  <td className="px-4 py-2 whitespace-nowrap">
                    {monthLabel(row.month)}
                    {row.in_progress && <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">so far</span>}
                  </td>
                  <td className="px-4 py-2 text-right">{formatMoney(row.revenue)}</td>
                  <td className={`px-4 py-2 text-right ${row.basis_amount < 0 ? 'text-destructive' : ''}`}>{formatMoney(row.basis_amount)}</td>
                  <td className="px-4 py-2 text-right font-medium">{formatMoney(row.tithe_due)}</td>
                  <td className="px-4 py-2 text-right">{row.paid ? formatMoney(row.paid) : '—'}</td>
                  <td className={`px-4 py-2 text-right ${row.balance_after > 0 ? 'text-primary' : 'text-emerald-600'}`}>
                    {row.balance_after < 0 ? `${formatMoney(-row.balance_after)} ahead` : formatMoney(row.balance_after)}
                  </td>
                </tr>
              ))}
              {!summaryLoading && !summary?.months?.length && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">No months to show yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border bg-card">
        <h2 className="border-b px-4 py-3 font-semibold">Tithe given</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2">Method</th>
                <th className="px-4 py-2">Given to</th>
                <th className="px-4 py-2">Reference</th>
                <th className="px-4 py-2">Recorded by</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {payments.map(payment => (
                <tr key={payment.id} className={`border-t ${payment.voided_at ? 'text-muted-foreground line-through' : ''}`}>
                  <td className="px-4 py-2 whitespace-nowrap">{dateLabel(payment.paid_on)}</td>
                  <td className="px-4 py-2 text-right">{formatMoney(payment.amount)}</td>
                  <td className="px-4 py-2">{methodLabels[payment.payment_method] || payment.payment_method}</td>
                  <td className="px-4 py-2">{payment.recipient || '—'}</td>
                  <td className="px-4 py-2">{payment.reference || '—'}</td>
                  <td className="px-4 py-2">{payment.created_by_name || '—'}</td>
                  <td className="px-4 py-2 text-right no-underline">
                    {payment.voided_at
                      ? <span className="text-xs" title={payment.void_reason || ''}>Voided</span>
                      : <button onClick={() => { setVoiding(payment); setVoidReason(''); setVoidError('') }} className="text-xs text-destructive hover:underline">Void</button>}
                  </td>
                </tr>
              ))}
              {!payments.length && (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">No tithe recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {voiding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6">
            <h2 className="font-semibold">Void tithe payment</h2>
            <p className="text-sm text-muted-foreground">
              {formatMoney(voiding.amount)} given on {dateLabel(voiding.paid_on)}. The record stays in the history, marked as voided, and the amount is added back to what is owed.
            </p>
            {voidError && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{voidError}</div>}
            <label className="block text-sm font-medium">Reason *
              <input value={voidReason} onChange={e => setVoidReason(e.target.value)} className={`${inputClass} mt-1`} placeholder="Example: entered twice" />
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setVoiding(null)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button
                disabled={!voidReason.trim() || voidPayment.isPending}
                onClick={() => voidPayment.mutate()}
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
              >
                {voidPayment.isPending ? 'Voiding…' : 'Void payment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
