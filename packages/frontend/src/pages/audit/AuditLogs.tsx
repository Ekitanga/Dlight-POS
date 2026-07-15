import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { Eye, Filter, History, Laptop, Search, ShieldCheck, UserRound, X } from 'lucide-react'
import { PaginatedResponse, Pagination } from '../../components/Pagination'
import { DateRangeFilter } from '../../components/DateRangeFilter'

interface AuditRow {
  id: string
  created_at: string
  user_name?: string
  user_email?: string
  user_role?: string
  action: string
  entity_type?: string
  entity_id?: string
  old_values?: Record<string, unknown> | null
  new_values?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  ip_address?: string | null
  user_agent?: string | null
}

interface AuditSummary {
  total: number
  users: number
  last_24h: number
  financial_events: number
}

type AuditPage = PaginatedResponse<AuditRow> & { summary?: AuditSummary }

const entityOptions = ['', 'order', 'supplier', 'rider', 'customer', 'product', 'inventory', 'expense', 'setting', 'user', 'order_refund']

function titleCase(value: string) {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}

function formatJson(value?: Record<string, unknown> | null) {
  if (!value || Object.keys(value).length === 0) return 'No data captured'
  return JSON.stringify(value, null, 2)
}

function userAgentLabel(userAgent?: string | null) {
  if (!userAgent) return 'Not captured'
  if (userAgent.includes('Chrome')) return 'Chrome'
  if (userAgent.includes('Firefox')) return 'Firefox'
  if (userAgent.includes('Edg')) return 'Edge'
  return userAgent.slice(0, 36)
}

function actionTone(action: string) {
  if (/deleted|cancelled|returned|refund|reversed/i.test(action)) return 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-200'
  if (/payment|settlement|remittance|reconciliation/i.test(action)) return 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200'
  if (/created|imported/i.test(action)) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200'
  return 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200'
}

function SummaryCard({ label, value, icon: Icon }: { label: string; value: string | number; icon: typeof ShieldCheck }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-bold">{value}</p>
        </div>
        <span className="rounded-xl bg-primary/10 p-3 text-primary"><Icon className="h-5 w-5" /></span>
      </div>
    </div>
  )
}

export function AuditLogs() {
  const [action, setAction] = useState('')
  const [entity, setEntity] = useState('')
  const [user, setUser] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<AuditRow | null>(null)

  const params = new URLSearchParams()
  if (action) params.set('action', action)
  if (entity) params.set('entity_type', entity)
  if (user) params.set('user', user)
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  params.set('page', String(page))
  params.set('page_size', String(pageSize))

  const { data: auditPage, isLoading } = useQuery<AuditPage>({
    queryKey: ['audit', action, entity, user, dateFrom, dateTo, page, pageSize],
    queryFn: async () => (await axios.get(`/api/audit?${params}`)).data
  })

  const data = auditPage?.data || []
  const summary = auditPage?.summary
  const selectedMetadata = useMemo(() => selected?.metadata || {}, [selected])

  const resetFilters = () => {
    setAction('')
    setEntity('')
    setUser('')
    setDateFrom('')
    setDateTo('')
    setPage(1)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Audit Logs</h1>
          <p className="text-muted-foreground">Full activity trail for orders, payments, stock, settings, and user actions</p>
        </div>
        <button type="button" onClick={resetFilters} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <Filter className="h-4 w-4" /> Clear filters
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Matching Events" value={summary?.total ?? auditPage?.pagination.total ?? 0} icon={History} />
        <SummaryCard label="Active Users" value={summary?.users ?? 0} icon={UserRound} />
        <SummaryCard label="Last 24 Hours" value={summary?.last_24h ?? 0} icon={ShieldCheck} />
        <SummaryCard label="Financial Events" value={summary?.financial_events ?? 0} icon={Laptop} />
      </div>

      <div className="rounded-xl border bg-card p-3 shadow-sm">
        <div className="grid gap-2 md:grid-cols-5">
          <label className="relative md:col-span-1">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <input value={action} onChange={event => { setAction(event.target.value); setPage(1) }} placeholder="Action, e.g. payment" className="w-full rounded-lg border bg-background py-2 pl-9 pr-3" />
          </label>
          <input value={user} onChange={event => { setUser(event.target.value); setPage(1) }} placeholder="User name or email" className="w-full rounded-lg border bg-background px-3 py-2" />
          <select value={entity} onChange={event => { setEntity(event.target.value); setPage(1) }} className="w-full rounded-lg border bg-background px-3 py-2">
            {entityOptions.map(option => <option key={option || 'all'} value={option}>{option ? titleCase(option) : 'All entities'}</option>)}
          </select>
          <DateRangeFilter
            dateFrom={dateFrom}
            dateTo={dateTo}
            compact
            includeClear={false}
            className="md:col-span-2"
            onChange={range => { setDateFrom(range.dateFrom); setDateTo(range.dateTo); setPage(1) }}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        {isLoading ? <div className="p-8 text-center text-muted-foreground">Loading audit trail...</div> :
          <div className="mobile-scroll-table overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-muted/80">
                <tr>
                  <th className="px-4 py-3 text-left">When</th>
                  <th className="px-4 py-3 text-left">Actor</th>
                  <th className="px-4 py-3 text-left">Action</th>
                  <th className="px-4 py-3 text-left">Record</th>
                  <th className="px-4 py-3 text-left">Context</th>
                  <th className="px-4 py-3 text-right">View</th>
                </tr>
              </thead>
              <tbody>
                {data.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No audit events match these filters.</td></tr>}
                {data.map(row => (
                  <tr key={row.id} className="border-t align-top hover:bg-muted/30">
                    <td className="whitespace-nowrap px-4 py-3">{formatDate(row.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{row.user_name || row.user_email || 'System'}</div>
                      <div className="text-xs text-muted-foreground">{row.user_role || row.metadata?.actor_role as string || 'system'}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${actionTone(row.action)}`}>{titleCase(row.action)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{titleCase(row.entity_type || 'system')}</div>
                      <div className="text-xs text-muted-foreground">{row.entity_id ? row.entity_id : 'No record ID'}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      <div>{row.metadata?.method as string || '-'} {row.metadata?.path as string || ''}</div>
                      <div>{row.ip_address || 'IP not captured'} | {userAgentLabel(row.user_agent)}</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" title="View audit details" onClick={() => setSelected(row)} className="rounded-lg border p-2 hover:bg-muted">
                        <Eye className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
        {auditPage && <Pagination meta={auditPage.pagination} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} />}
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-xl border bg-card shadow-xl">
            <div className="flex items-start justify-between border-b p-4">
              <div>
                <h2 className="text-lg font-semibold">{titleCase(selected.action)}</h2>
                <p className="text-sm text-muted-foreground">{formatDate(selected.created_at)} | {selected.user_name || selected.user_email || 'System'}</p>
              </div>
              <button type="button" onClick={() => setSelected(null)} className="rounded-lg p-2 hover:bg-muted" title="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[calc(90vh-76px)] space-y-4 overflow-y-auto p-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Entity</p><p className="font-semibold">{titleCase(selected.entity_type || 'system')}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Record ID</p><p className="break-all font-semibold">{selected.entity_id || '-'}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">IP Address</p><p className="font-semibold">{selected.ip_address || '-'}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Status</p><p className="font-semibold">{String(selectedMetadata.status_code || '-')}</p></div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <section className="rounded-lg border">
                  <h3 className="border-b px-3 py-2 font-semibold">Before</h3>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-3 text-xs">{formatJson(selected.old_values)}</pre>
                </section>
                <section className="rounded-lg border">
                  <h3 className="border-b px-3 py-2 font-semibold">After / Details</h3>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-3 text-xs">{formatJson(selected.new_values)}</pre>
                </section>
              </div>
              <section className="rounded-lg border">
                <h3 className="border-b px-3 py-2 font-semibold">Request Metadata</h3>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 text-xs">{formatJson({ ...selectedMetadata, user_agent: selected.user_agent })}</pre>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
