import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { CreditCard, Edit, ExternalLink, ListChecks, PackageCheck, Plus, Search, Trash2, Truck } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { DateRangeFilter } from '../../components/DateRangeFilter'
import { Pagination, type PaginatedResponse } from '../../components/Pagination'
import { formatMoney } from '../../lib/format'
import { useAuthStore } from '../../stores/authStore'

const DEFAULT_TRACKING_TEMPLATE = 'https://parcelsapp.com/en/tracking/{tracking_number}'

interface Courier {
  id: string
  name: string
  tracking_prefix?: string
  tracking_url_template?: string
  is_active?: boolean
}

interface CourierFormData {
  name: string
  tracking_prefix: string
  tracking_url_template: string
}

interface SpeedafOrder {
  order_id: string
  order_number: string
  order_status: string
  payment_status: string
  total_amount: string | number
  business_date?: string
  delivery_address?: string
  courier_tracking_number?: string
  delivery_fee_payment_method?: string
  courier_customer_fee?: string | number
  courier_actual_fee?: string | number
  customer_name?: string
  customer_phone?: string
  courier_name?: string
  cod_status?: string
  cod_amount?: string | number
  remitted_amount?: string | number
  cod_outstanding?: string | number
  age_days?: string | number
  tracking_url?: string
}

interface CodLedgerRow extends SpeedafOrder {
  cod_id: string
  tracking_number?: string
  due_date?: string
  delivered_at?: string
  remitted_at?: string
}

type ActiveTab = 'couriers' | 'speedaf' | 'cod'

const orderStatusOptions = [
  ['', 'All statuses'],
  ['pending', 'Pending'],
  ['confirmed', 'Confirmed'],
  ['dispatched_in_transit', 'Dispatched / In Transit'],
  ['pending_payment', 'Pending Payment'],
  ['delivered', 'Delivered'],
  ['collected_paid', 'Collected & Paid'],
  ['returned', 'Returned'],
  ['cancelled', 'Cancelled']
] as const

const codStatusOptions = [
  ['', 'All COD statuses'],
  ['assigned_to_courier', 'Assigned to Courier'],
  ['in_transit', 'In Transit'],
  ['delivered_awaiting_remittance', 'Awaiting Remittance'],
  ['partially_remitted', 'Partially Remitted'],
  ['remitted', 'Remitted'],
  ['closed', 'Closed'],
  ['returned', 'Returned'],
  ['disputed', 'Disputed'],
  ['lost', 'Lost']
] as const

const tabs: Array<{ key: ActiveTab; title: string; icon: typeof Truck }> = [
  { key: 'couriers', title: 'Couriers', icon: Truck },
  { key: 'speedaf', title: 'Speedaf Orders', icon: PackageCheck },
  { key: 'cod', title: 'COD Ledger', icon: CreditCard }
]

function labelFromValue(value?: string) {
  if (!value) return '-'
  return value
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function orderStatusLabel(value?: string) {
  if (value === 'dispatched' || value === 'in_transit') return 'Dispatched / In Transit'
  if (value === 'delivered') return 'Pending Payment'
  if (value === 'collected_paid') return 'Completed'
  return labelFromValue(value)
}

function statusClass(value?: string) {
  if (['collected_paid', 'closed', 'remitted'].includes(value || '')) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
  if (['returned', 'cancelled', 'lost', 'disputed'].includes(value || '')) return 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
  if (['delivered', 'delivered_awaiting_remittance', 'partially_remitted'].includes(value || '')) return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
  return 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
}

function StatusBadge({ value, order }: { value?: string; order?: boolean }) {
  return (
    <span className={`inline-flex max-w-full rounded-full px-2 py-1 text-xs font-medium ${statusClass(value)}`}>
      <span className="truncate">{order ? orderStatusLabel(value) : labelFromValue(value)}</span>
    </span>
  )
}

function formatDate(value?: string) {
  if (!value) return '-'
  const date = new Date(value.includes('T') ? value : `${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleDateString('en-KE')
}

function buildParams(values: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined || value === '' || value === false) return
    params.set(key, String(value))
  })
  return params.toString()
}

function TrackingLink({ row }: { row: Pick<SpeedafOrder, 'tracking_url' | 'courier_tracking_number'> & { tracking_number?: string } }) {
  const trackingNumber = row.courier_tracking_number || row.tracking_number
  if (!trackingNumber) return <span className="text-muted-foreground">No tracking</span>
  if (!row.tracking_url) return <span className="break-all">{trackingNumber}</span>
  return (
    <a
      href={row.tracking_url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
      title={`Track ${trackingNumber}`}
    >
      <span className="truncate">{trackingNumber}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
    </a>
  )
}

function EmptyState({ icon: Icon, title, description }: { icon: typeof Truck; title: string; description: string }) {
  return (
    <div className="rounded-lg border py-14 text-center">
      <Icon className="mx-auto mb-4 h-14 w-14 text-muted-foreground" />
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="mx-auto mt-1 max-w-md px-4 text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

export function Couriers() {
  const { hasPermission } = useAuthStore()
  const [activeTab, setActiveTab] = useState<ActiveTab>('couriers')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingCourier, setEditingCourier] = useState<Courier | null>(null)

  const [speedafSearch, setSpeedafSearch] = useState('')
  const [speedafStatus, setSpeedafStatus] = useState('')
  const [speedafCodStatus, setSpeedafCodStatus] = useState('')
  const [speedafOutstanding, setSpeedafOutstanding] = useState(false)
  const [speedafDateFrom, setSpeedafDateFrom] = useState('')
  const [speedafDateTo, setSpeedafDateTo] = useState('')
  const [speedafPage, setSpeedafPage] = useState(1)
  const [speedafPageSize, setSpeedafPageSize] = useState(25)

  const [codSearch, setCodSearch] = useState('')
  const [codCourierId, setCodCourierId] = useState('')
  const [codStatus, setCodStatus] = useState('')
  const [codOutstanding, setCodOutstanding] = useState(false)
  const [codDateFrom, setCodDateFrom] = useState('')
  const [codDateTo, setCodDateTo] = useState('')
  const [codPage, setCodPage] = useState(1)
  const [codPageSize, setCodPageSize] = useState(25)

  const queryClient = useQueryClient()
  const { register, handleSubmit, reset, formState: { errors } } = useForm<CourierFormData>()

  const { data: couriers = [], isLoading, error } = useQuery<Courier[]>({
    queryKey: ['couriers', search],
    queryFn: async () => (await axios.get(`/api/couriers?search=${encodeURIComponent(search)}`)).data
  })

  const speedafQuery = useQuery<PaginatedResponse<SpeedafOrder>>({
    queryKey: ['speedaf-orders', speedafSearch, speedafStatus, speedafCodStatus, speedafOutstanding, speedafDateFrom, speedafDateTo, speedafPage, speedafPageSize],
    queryFn: async () => {
      const params = buildParams({
        search: speedafSearch,
        order_status: speedafStatus,
        cod_status: speedafCodStatus,
        outstanding: speedafOutstanding,
        date_from: speedafDateFrom,
        date_to: speedafDateTo,
        page: speedafPage,
        page_size: speedafPageSize
      })
      return (await axios.get(`/api/couriers/speedaf/orders?${params}`)).data
    },
    enabled: activeTab === 'speedaf'
  })

  const codLedgerQuery = useQuery<PaginatedResponse<CodLedgerRow>>({
    queryKey: ['courier-cod-ledger', codSearch, codCourierId, codStatus, codOutstanding, codDateFrom, codDateTo, codPage, codPageSize],
    queryFn: async () => {
      const params = buildParams({
        search: codSearch,
        courier_id: codCourierId,
        cod_status: codStatus,
        outstanding: codOutstanding,
        date_from: codDateFrom,
        date_to: codDateTo,
        page: codPage,
        page_size: codPageSize
      })
      return (await axios.get(`/api/couriers/cod/ledger?${params}`)).data
    },
    enabled: activeTab === 'cod'
  })

  const saveCourier = useMutation({
    mutationFn: async (data: CourierFormData) => {
      if (editingCourier) {
        return (await axios.put(`/api/couriers/${editingCourier.id}`, { ...data, is_active: true })).data
      }
      return (await axios.post('/api/couriers', data)).data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['couriers'] })
      setShowForm(false)
      setEditingCourier(null)
      reset()
    }
  })

  const deleteCourier = useMutation({
    mutationFn: async (id: string) => axios.delete(`/api/couriers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['couriers'] })
  })

  const editCourier = (courier: Courier) => {
    setEditingCourier(courier)
    reset({
      name: courier.name,
      tracking_prefix: courier.tracking_prefix || '',
      tracking_url_template: courier.tracking_url_template || ''
    })
    setShowForm(true)
    setActiveTab('couriers')
  }

  const resetCourierForm = () => {
    setShowForm(true)
    setEditingCourier(null)
    reset({ name: '', tracking_prefix: '', tracking_url_template: DEFAULT_TRACKING_TEMPLATE })
  }

  if (error) {
    return <div className="p-6 text-destructive">Failed to load couriers</div>
  }

  const speedafRows = speedafQuery.data?.data || []
  const codRows = codLedgerQuery.data?.data || []

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 overflow-hidden px-0 sm:px-1">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Couriers</h1>
          <p className="text-muted-foreground">Manage courier companies, Speedaf dispatches, and COD remittances</p>
        </div>
        {hasPermission('couriers.manage') && (
          <button
            onClick={resetCourierForm}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Add Courier
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-b">
        {tabs.map(tab => {
          const Icon = tab.icon
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium ${
                activeTab === tab.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.title}
            </button>
          )
        })}
      </div>

      {activeTab === 'couriers' && (
        <div className="space-y-5">
          {showForm && (
            <div className="rounded-lg border bg-card p-4 sm:p-6">
              <h2 className="mb-4 font-semibold">{editingCourier ? 'Edit Courier' : 'Add Courier'}</h2>
              <form onSubmit={handleSubmit(data => saveCourier.mutate(data))} className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium">Courier Name</label>
                  <input
                    {...register('name', { required: 'Courier name is required' })}
                    className="w-full rounded-lg border px-3 py-2 placeholder:text-slate-500"
                    placeholder="Example: Speedaf"
                  />
                  {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Tracking Prefix</label>
                  <input {...register('tracking_prefix')} className="w-full rounded-lg border px-3 py-2 placeholder:text-slate-500" placeholder="Example: KE" />
                </div>
                <div className="md:col-span-2">
                  <label className="mb-1 block text-sm font-medium">Tracking URL Template</label>
                  <input
                    {...register('tracking_url_template')}
                    className="w-full rounded-lg border px-3 py-2 placeholder:text-slate-500"
                    placeholder={DEFAULT_TRACKING_TEMPLATE}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">Use {'{tracking_number}'} where the tracking number should appear.</p>
                </div>
                <div className="flex flex-wrap gap-2 md:col-span-2">
                  <button type="submit" disabled={saveCourier.isPending} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
                    {editingCourier ? 'Update Courier' : 'Create Courier'}
                  </button>
                  <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border px-4 py-2">Cancel</button>
                </div>
              </form>
            </div>
          )}

          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={search} onChange={event => setSearch(event.target.value)} className="w-full rounded-lg border py-2 pl-10 pr-4 placeholder:text-slate-500" placeholder="Search couriers..." />
          </div>

          {isLoading ? (
            <div className="space-y-2">{[...Array(4)].map((_, index) => <div key={index} className="h-16 animate-pulse rounded-lg bg-muted" />)}</div>
          ) : couriers.length === 0 ? (
            <EmptyState icon={Truck} title="No couriers found" description="Add Speedaf or another courier to use courier delivery in orders." />
          ) : (
            <>
              <div className="grid gap-3 md:hidden">
                {couriers.map(courier => (
                  <div key={courier.id} className="rounded-lg border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-semibold">{courier.name}</h3>
                        <p className="text-sm text-muted-foreground">Prefix: {courier.tracking_prefix || '-'}</p>
                        <p className="mt-2 break-all text-xs text-muted-foreground">{courier.tracking_url_template || 'No tracking template set'}</p>
                      </div>
                      {hasPermission('couriers.manage') && (
                        <div className="flex shrink-0 gap-1">
                          <button title="Edit courier" onClick={() => editCourier(courier)} className="rounded p-2 text-muted-foreground hover:text-primary"><Edit className="h-4 w-4" /></button>
                          <button title="Delete courier" onClick={() => deleteCourier.mutate(courier.id)} className="rounded p-2 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden rounded-lg border md:block">
                <table className="w-full table-fixed">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Name</th>
                      <th className="w-36 px-4 py-3 text-left font-medium">Prefix</th>
                      <th className="px-4 py-3 text-left font-medium">Tracking Template</th>
                      <th className="w-28 px-4 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {couriers.map(courier => (
                      <tr key={courier.id} className="border-t hover:bg-muted/50">
                        <td className="px-4 py-3 font-medium">{courier.name}</td>
                        <td className="px-4 py-3 text-sm">{courier.tracking_prefix || '-'}</td>
                        <td className="break-all px-4 py-3 text-sm text-muted-foreground">{courier.tracking_url_template || '-'}</td>
                        <td className="px-4 py-3 text-right">
                          {hasPermission('couriers.manage') && (
                            <>
                              <button title="Edit courier" onClick={() => editCourier(courier)} className="rounded p-1.5 text-muted-foreground hover:text-primary"><Edit className="h-4 w-4" /></button>
                              <button title="Delete courier" onClick={() => deleteCourier.mutate(courier.id)} className="rounded p-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'speedaf' && (
        <div className="space-y-5">
          <div className="rounded-lg border bg-card p-4">
            <div className="mb-4 flex items-start gap-3">
              <PackageCheck className="mt-1 h-5 w-5 text-primary" />
              <div>
                <h2 className="font-semibold">Speedaf Orders</h2>
                <p className="text-sm text-muted-foreground">Track parcels in transit, client collections, and remittances from one place.</p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
              <div className="relative lg:col-span-2">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input value={speedafSearch} onChange={event => { setSpeedafSearch(event.target.value); setSpeedafPage(1) }} className="w-full rounded-lg border py-2 pl-10 pr-4 placeholder:text-slate-500" placeholder="Search order, customer, destination, tracking..." />
              </div>
              <select value={speedafStatus} onChange={event => { setSpeedafStatus(event.target.value); setSpeedafPage(1) }} className="rounded-lg border bg-background px-3 py-2">
                {orderStatusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select value={speedafCodStatus} onChange={event => { setSpeedafCodStatus(event.target.value); setSpeedafPage(1) }} className="rounded-lg border bg-background px-3 py-2">
                {codStatusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div className="mt-3 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <DateRangeFilter
                dateFrom={speedafDateFrom}
                dateTo={speedafDateTo}
                onChange={({ dateFrom, dateTo }) => { setSpeedafDateFrom(dateFrom); setSpeedafDateTo(dateTo); setSpeedafPage(1) }}
                onClear={() => { setSpeedafDateFrom(''); setSpeedafDateTo(''); setSpeedafPage(1) }}
                compact
              />
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={speedafOutstanding} onChange={event => { setSpeedafOutstanding(event.target.checked); setSpeedafPage(1) }} />
                Show outstanding COD only
              </label>
            </div>
          </div>

          {speedafQuery.isLoading ? (
            <div className="space-y-2">{[...Array(5)].map((_, index) => <div key={index} className="h-20 animate-pulse rounded-lg bg-muted" />)}</div>
          ) : speedafRows.length === 0 ? (
            <EmptyState icon={ListChecks} title="No Speedaf orders found" description="Speedaf courier orders will appear here once they are created from the Orders screen." />
          ) : (
            <div className="rounded-lg border">
              <div className="grid gap-3 p-3 xl:hidden">
                {speedafRows.map(row => (
                  <div key={row.order_id} className="rounded-lg border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-semibold">{row.order_number}</h3>
                        <p className="truncate text-sm text-muted-foreground">{row.customer_name || row.customer_phone || 'No customer name'}</p>
                        <p className="truncate text-sm text-muted-foreground">{row.courier_name || 'Speedaf'}</p>
                        <p className="truncate text-sm text-muted-foreground">{row.delivery_address || '-'}</p>
                      </div>
                      <StatusBadge value={row.order_status} order />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div><span className="text-muted-foreground">Tracking</span><div className="min-w-0"><TrackingLink row={row} /></div></div>
                      <div><span className="text-muted-foreground">COD</span><div>{row.cod_status ? <StatusBadge value={row.cod_status} /> : '-'}</div></div>
                      <div><span className="text-muted-foreground">Outstanding</span><div className="font-semibold">{formatMoney(row.cod_outstanding || 0)}</div></div>
                      <div><span className="text-muted-foreground">Date</span><div>{formatDate(row.business_date)}</div></div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden xl:block">
                <table className="w-full table-fixed">
                  <thead className="bg-muted">
                    <tr>
                      <th className="w-32 px-4 py-3 text-left font-medium">Order</th>
                      <th className="px-4 py-3 text-left font-medium">Customer</th>
                      <th className="w-36 px-4 py-3 text-left font-medium">Courier</th>
                      <th className="px-4 py-3 text-left font-medium">Destination</th>
                      <th className="px-4 py-3 text-left font-medium">Tracking</th>
                      <th className="w-36 px-4 py-3 text-left font-medium">Status</th>
                      <th className="w-36 px-4 py-3 text-left font-medium">COD</th>
                      <th className="w-32 px-4 py-3 text-right font-medium">Outstanding</th>
                      <th className="w-28 px-4 py-3 text-left font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {speedafRows.map(row => (
                      <tr key={row.order_id} className="border-t hover:bg-muted/50">
                        <td className="break-words px-4 py-3 font-medium">{row.order_number}</td>
                        <td className="break-words px-4 py-3">{row.customer_name || row.customer_phone || '-'}</td>
                        <td className="break-words px-4 py-3">{row.courier_name || '-'}</td>
                        <td className="break-words px-4 py-3">{row.delivery_address || '-'}</td>
                        <td className="min-w-0 px-4 py-3"><TrackingLink row={row} /></td>
                        <td className="px-4 py-3"><StatusBadge value={row.order_status} order /></td>
                        <td className="px-4 py-3">{row.cod_status ? <StatusBadge value={row.cod_status} /> : '-'}</td>
                        <td className="px-4 py-3 text-right font-semibold">{formatMoney(row.cod_outstanding || 0)}</td>
                        <td className="px-4 py-3">{formatDate(row.business_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {speedafQuery.data?.pagination && (
                <Pagination
                  meta={speedafQuery.data.pagination}
                  onPageChange={setSpeedafPage}
                  onPageSizeChange={size => { setSpeedafPageSize(size); setSpeedafPage(1) }}
                />
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'cod' && (
        <div className="space-y-5">
          <div className="rounded-lg border bg-card p-4">
            <div className="mb-4 flex items-start gap-3">
              <CreditCard className="mt-1 h-5 w-5 text-primary" />
              <div>
                <h2 className="font-semibold">Courier COD Ledger</h2>
                <p className="text-sm text-muted-foreground">See all courier COD orders, remitted amounts, balances, and ageing.</p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
              <div className="relative lg:col-span-2">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input value={codSearch} onChange={event => { setCodSearch(event.target.value); setCodPage(1) }} className="w-full rounded-lg border py-2 pl-10 pr-4 placeholder:text-slate-500" placeholder="Search order, customer, courier, tracking..." />
              </div>
              <select value={codCourierId} onChange={event => { setCodCourierId(event.target.value); setCodPage(1) }} className="rounded-lg border bg-background px-3 py-2">
                <option value="">All couriers</option>
                {couriers.map(courier => <option key={courier.id} value={courier.id}>{courier.name}</option>)}
              </select>
              <select value={codStatus} onChange={event => { setCodStatus(event.target.value); setCodPage(1) }} className="rounded-lg border bg-background px-3 py-2">
                {codStatusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div className="mt-3 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <DateRangeFilter
                dateFrom={codDateFrom}
                dateTo={codDateTo}
                onChange={({ dateFrom, dateTo }) => { setCodDateFrom(dateFrom); setCodDateTo(dateTo); setCodPage(1) }}
                onClear={() => { setCodDateFrom(''); setCodDateTo(''); setCodPage(1) }}
                compact
              />
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={codOutstanding} onChange={event => { setCodOutstanding(event.target.checked); setCodPage(1) }} />
                Show outstanding only
              </label>
            </div>
          </div>

          {codLedgerQuery.isLoading ? (
            <div className="space-y-2">{[...Array(5)].map((_, index) => <div key={index} className="h-20 animate-pulse rounded-lg bg-muted" />)}</div>
          ) : codRows.length === 0 ? (
            <EmptyState icon={CreditCard} title="No COD records found" description="Courier COD orders will appear here when orders are created as pay-on-delivery." />
          ) : (
            <div className="rounded-lg border">
              <div className="grid gap-3 p-3 xl:hidden">
                {codRows.map(row => (
                  <div key={row.cod_id} className="rounded-lg border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-semibold">{row.order_number}</h3>
                        <p className="truncate text-sm text-muted-foreground">{row.courier_name || '-'}</p>
                        <p className="truncate text-sm text-muted-foreground">{row.customer_name || row.customer_phone || '-'}</p>
                        <p className="truncate text-sm text-muted-foreground">{row.delivery_address || '-'}</p>
                      </div>
                      <StatusBadge value={row.cod_status} />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div><span className="text-muted-foreground">Tracking</span><div className="min-w-0"><TrackingLink row={row} /></div></div>
                      <div><span className="text-muted-foreground">Age</span><div>{row.age_days || 0} days</div></div>
                      <div><span className="text-muted-foreground">COD</span><div>{formatMoney(row.cod_amount || 0)}</div></div>
                      <div><span className="text-muted-foreground">Outstanding</span><div className="font-semibold">{formatMoney(row.cod_outstanding || 0)}</div></div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden xl:block">
                <table className="w-full table-fixed">
                  <thead className="bg-muted">
                    <tr>
                      <th className="w-32 px-4 py-3 text-left font-medium">Order</th>
                      <th className="w-32 px-4 py-3 text-left font-medium">Courier</th>
                      <th className="px-4 py-3 text-left font-medium">Customer</th>
                      <th className="px-4 py-3 text-left font-medium">Destination</th>
                      <th className="px-4 py-3 text-left font-medium">Tracking</th>
                      <th className="w-36 px-4 py-3 text-left font-medium">COD Status</th>
                      <th className="w-28 px-4 py-3 text-right font-medium">COD</th>
                      <th className="w-28 px-4 py-3 text-right font-medium">Remitted</th>
                      <th className="w-32 px-4 py-3 text-right font-medium">Outstanding</th>
                      <th className="w-24 px-4 py-3 text-right font-medium">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {codRows.map(row => (
                      <tr key={row.cod_id} className="border-t hover:bg-muted/50">
                        <td className="break-words px-4 py-3 font-medium">{row.order_number}</td>
                        <td className="break-words px-4 py-3">{row.courier_name || '-'}</td>
                        <td className="break-words px-4 py-3">{row.customer_name || row.customer_phone || '-'}</td>
                        <td className="break-words px-4 py-3">{row.delivery_address || '-'}</td>
                        <td className="min-w-0 px-4 py-3"><TrackingLink row={row} /></td>
                        <td className="px-4 py-3"><StatusBadge value={row.cod_status} /></td>
                        <td className="px-4 py-3 text-right">{formatMoney(row.cod_amount || 0)}</td>
                        <td className="px-4 py-3 text-right">{formatMoney(row.remitted_amount || 0)}</td>
                        <td className="px-4 py-3 text-right font-semibold">{formatMoney(row.cod_outstanding || 0)}</td>
                        <td className="px-4 py-3 text-right">{row.age_days || 0} days</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {codLedgerQuery.data?.pagination && (
                <Pagination
                  meta={codLedgerQuery.data.pagination}
                  onPageChange={setCodPage}
                  onPageSizeChange={size => { setCodPageSize(size); setCodPage(1) }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
