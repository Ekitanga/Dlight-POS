import { useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useSearchParams } from 'react-router-dom'
import {
  AlertCircle, Banknote, Bike, Boxes, Building2, CheckCircle2,
  ChevronRight, ClipboardList, Download, ExternalLink, FileSpreadsheet, Landmark, LockKeyhole,
  PackageCheck, Printer, ReceiptText, TrendingUp, Truck, Users, WalletCards
} from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { Pagination } from '../../components/Pagination'
import { DateRangeFilter, todayDate } from '../../components/DateRangeFilter'
import { formatMoney, formatNumber } from '../../lib/format'

type Row = Record<string, unknown>

interface Overview {
  period: { dateFrom: string; dateTo: string }
  kpis: Row
  trends: Row[]
  paymentMethods: Row[]
  deliveryTypes: Row[]
  topProducts: Row[]
  topCustomers: Row[]
  pendingActions: Row
}

const departments = [
  { id: 'overview', label: 'Business Overview', icon: TrendingUp },
  { id: 'sales', label: 'Sales & Profit', icon: Banknote },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'suppliers', label: 'Supplier Management', icon: Building2 },
  { id: 'riders', label: 'Rider Management', icon: Bike },
  { id: 'courier', label: 'Courier / COD', icon: Truck },
  { id: 'customers', label: 'Customer Accounts', icon: Users },
  { id: 'finance', label: 'Finance', icon: Landmark },
  { id: 'audit', label: 'Audit & Activity', icon: ClipboardList }
] as const

const departmentReports: Record<string, Array<[string, string]>> = {
  sales: [['sales', 'Sales Analysis'], ['profit', 'Profit Summary']],
  inventory: [['inventory', 'Current Stock'], ['category-demand', 'Demand By Category'], ['product-demand', 'Restock Advice']],
  suppliers: [['supplier-payables', 'Supplier Payables'], ['supplier-settlements', 'Settlement History']],
  riders: [['rider-earnings', 'Rider Earnings'], ['rider-settlements', 'Settlement History']],
  courier: [
    ['speedaf-orders', 'Speedaf Orders'],
    ['courier-cod-ledger', 'COD Ledger'],
    ['cod-outstanding', 'Outstanding COD'],
    ['cod-ageing', 'COD Ageing']
  ],
  customers: [['customer-credit', 'Customer Credit']],
  finance: [['expenses', 'Approved Expenses'], ['reconciliation', 'Daily Reconciliation'], ['refunds', 'Pending Refunds']],
  audit: [['audit', 'Activity Log']]
}

const number = (value: unknown, maximumFractionDigits = 0) => formatNumber(value, maximumFractionDigits)
const money = (value: unknown) => formatMoney(value)
const label = (key: string) => key.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase())
const reportLabelOverrides: Record<string, Record<string, string>> = {
  inventory: {
    sku: 'SKU',
    product: 'Product',
    category: 'Category',
    available_stock: 'Stock Now',
    reserved_stock: 'Reserved',
    damaged_stock: 'Damaged',
    returned_stock: 'Returned',
    reorder_level: 'Minimum Stock',
    stock_value: 'Stock Value'
  },
  'category-demand': {
    category: 'Category',
    units_sold: 'Sold',
    orders: 'Orders',
    revenue: 'Sales Value',
    gross_profit: 'Gross Profit'
  },
  'product-demand': {
    sku: 'SKU',
    product: 'Product',
    units_sold: 'Sold',
    orders: 'Orders',
    revenue: 'Sales Value',
    gross_profit: 'Gross Profit',
    available_stock: 'Stock Now',
    average_daily_units: 'Avg Sold/Day',
    suggested_stock_14_days: 'Needed For 14 Days',
    suggested_stock_30_days: 'Needed For 30 Days',
    reorder_gap: 'Add This Many',
    recommendation: 'Action'
  }
}
const reportLabel = (report: string, key: string) => reportLabelOverrides[report]?.[key] ?? label(key)
const reportHelp: Record<string, string> = {
  inventory: 'Current Stock shows what is physically available, reserved, damaged, returned, and the estimated stock value.',
  'category-demand': 'Demand By Category shows which product categories sold most in the selected period.',
  'product-demand': 'Restock Advice uses sales in the selected period to estimate stock needs. Needed For 14/30 Days is the stock level required to cover that many days. Add This Many is the extra quantity needed after comparing that estimate with Stock Now.'
}
const clientCourierReports = ['speedaf-orders', 'courier-cod-ledger']
const technicalKey = (key: string) => key === 'id' || key === 'tracking_url' || key.endsWith('_id') || ['created_by', 'approved_by', 'closed_by'].includes(key)
const dateKey = (key: string) => /(^date$|date$|_at$|last_purchase|last_delivery|last_transaction)/.test(key)
const moneyKey = (key: string) => [
  'amount', 'sales', 'cost', 'profit', 'expense', 'paid', 'payable', 'earnings',
  'cash', 'mpesa', 'variance', 'balance', 'revenue', 'value', 'price', 'fee',
  'credit', 'subtotal', 'total', 'refund'
].some(term => key.includes(term)) && !/(method|status|date|count|number|margin)/.test(key)
const countKey = (key: string) => /(^quantity$|quantity|orders|deliveries|units|days|level|count|available_stock|suggested_stock|reorder_gap)/.test(key)
const descriptiveKey = (key: string) => !countKey(key) && /(^name$|items|product$|products$|description|notes|details|reason|recommendation|signal)/.test(key)
const columnWidth = (key: string) => {
  if (/recommendation|signal/.test(key)) return 180
  if (descriptiveKey(key)) return 340
  if (/suggested_stock|average_daily_units|reorder_gap/.test(key)) return 150
  if (/^sku$/.test(key)) return 150
  if (dateKey(key)) return 145
  if (moneyKey(key)) return 145
  if (countKey(key)) return 110
  if (/tracking/.test(key)) return 190
  if (/destination|address/.test(key)) return 220
  if (/supplier|customer|courier|rider/.test(key)) return 170
  if (/status|method|reference/.test(key)) return 145
  return 135
}
const formatDate = (value: unknown) => {
  if (!value) return '-'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-KE', {
    day: '2-digit', month: 'short', year: 'numeric'
  })
}
const formatCell = (key: string, value: unknown) => {
  if (value === null || value === undefined || value === '') return '-'
  if (dateKey(key)) return formatDate(value)
  if (key.includes('margin') || key.includes('percentage')) return `${number(value, 0)}%`
  if (moneyKey(key)) return money(value)
  if (countKey(key)) return number(value, 0)
  if (typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value))) return number(value)
  return String(value).replaceAll('_', ' ')
}
function MetricCard({ title, value, icon, onClick, danger }: {
  title: string
  value: string | number
  icon: ReactNode
  onClick?: () => void
  danger?: boolean
}) {
  return <button type="button" onClick={onClick} className="rounded-lg border bg-card p-4 text-left hover:border-primary/50 hover:shadow-sm">
    <div className="flex items-start justify-between gap-3">
      <div><div className="text-xs font-medium uppercase text-muted-foreground">{title}</div><div className={`mt-2 text-xl font-bold ${danger ? 'text-destructive' : ''}`}>{value}</div></div>
      <div className={`rounded-lg p-2 ${danger ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>{icon}</div>
    </div>
  </button>
}

function BarList({ title, rows, nameKey, valueKey, format = money }: {
  title: string
  rows: Row[]
  nameKey: string
  valueKey: string
  format?: (value: unknown) => string
}) {
  const maximum = Math.max(...rows.map(row => Number(row[valueKey] || 0)), 1)
  return <section className="min-w-0 rounded-lg border bg-card p-4">
    <h3 className="mb-4 font-semibold">{title}</h3>
    {rows.length === 0 ? <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">No data available</div> :
      <div className="space-y-4">{rows.map((row, index) => {
        const rawName = row[nameKey]
        const displayName = dateKey(nameKey) ? formatDate(rawName) : String(rawName || '-').replaceAll('_', ' ')
        return <div key={`${String(rawName)}-${index}`}>
        <div className="mb-1.5 flex min-w-0 justify-between gap-3 text-sm">
          <span className="min-w-0 truncate capitalize" title={String(rawName || '-')}>{displayName}</span>
          <strong className="shrink-0 whitespace-nowrap">{format(row[valueKey])}</strong>
        </div>
        <div className="h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.max(3, Number(row[valueKey] || 0) / maximum * 100)}%` }} /></div>
      </div>})}</div>}
  </section>
}

export function Reports() {
  const { hasPermission } = useAuthStore()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const requestedDepartment = searchParams.get('department') || 'overview'
  const initialDepartment = departments.some(item => item.id === requestedDepartment) ? requestedDepartment : 'overview'
  const requestedReport = searchParams.get('report') || departmentReports[initialDepartment]?.[0]?.[0] || 'sales'
  const validReports = departmentReports[initialDepartment]?.map(([key]) => key) || []
  const [department, setDepartment] = useState(initialDepartment)
  const [report, setReport] = useState(validReports.includes(requestedReport) ? requestedReport : validReports[0] || 'sales')
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') || todayDate())
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') || todayDate())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [actualCash, setActualCash] = useState('')
  const [actualMpesa, setActualMpesa] = useState('')
  const [message, setMessage] = useState('')
  const [selectedRefund, setSelectedRefund] = useState<Row | null>(null)
  const [refundMethod, setRefundMethod] = useState('cash')
  const [refundReference, setRefundReference] = useState('')
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
  const reconciliationDate = dateFrom === dateTo ? dateFrom : dateTo

  const { data: overview, isLoading: overviewLoading } = useQuery<Overview>({
    queryKey: ['reports-overview', dateFrom, dateTo],
    queryFn: async () => (await axios.get(`/api/reports/overview?${params}`)).data,
    enabled: department === 'overview'
  })

  const { data: detailData, isLoading: detailLoading } = useQuery<Row[] | Row>({
    queryKey: ['report-detail', report, dateFrom, dateTo],
    queryFn: async () => {
      if (report === 'audit') return (await axios.get(`/api/audit?page=1&page_size=100&${params}`)).data.data
      if (report === 'refunds') return (await axios.get('/api/orders/refunds/pending')).data
      if (report === 'speedaf-orders') {
        const response = await axios.get(`/api/couriers/speedaf/orders?page=1&page_size=500&${params}`)
        return response.data.data
      }
      if (report === 'courier-cod-ledger') {
        const response = await axios.get(`/api/couriers/cod/ledger?page=1&page_size=500&${params}`)
        return response.data.data
      }
      return (await axios.get(`/api/reports/${report}?${params}`)).data
    },
    enabled: department !== 'overview' && report !== 'reconciliation'
  })
  const { data: reconciliations = [] } = useQuery<Row[]>({
    queryKey: ['reconciliations', dateFrom, dateTo],
    queryFn: async () => (await axios.get(`/api/reports/reconciliation/daily?${params}`)).data,
    enabled: report === 'reconciliation'
  })

  const reconcile = useMutation({
    mutationFn: async () => (await axios.post('/api/reports/reconciliation/daily', {
      business_date: reconciliationDate,
      actual_cash: Number(actualCash || 0),
      actual_mpesa: Number(actualMpesa || 0)
    })).data,
    onSuccess: () => {
      setMessage(`Daily totals calculated for ${formatDate(reconciliationDate)}. Review every variance before closing.`)
      queryClient.invalidateQueries({ queryKey: ['reconciliations'] })
    },
    onError: (error: any) => setMessage(error.response?.data?.error?.message || 'Unable to reconcile')
  })
  const close = useMutation({
    mutationFn: async (id: string) => axios.put(`/api/reports/reconciliation/daily/${id}/close`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reconciliations'] })
  })
  const payRefund = useMutation({
    mutationFn: async () => axios.post(`/api/orders/refunds/${selectedRefund?.id}/pay`, {
      payment_method: refundMethod, reference: refundReference || null
    }),
    onSuccess: () => {
      setSelectedRefund(null)
      queryClient.invalidateQueries({ queryKey: ['report-detail', 'refunds'] })
    }
  })

  const selectDepartment = (next: string) => {
    setDepartment(next)
    const firstReport = departmentReports[next]?.[0]?.[0]
    if (firstReport) setReport(firstReport)
    setPage(1)
  }
  const rawRows = report === 'reconciliation'
    ? reconciliations
    : Array.isArray(detailData) ? detailData : detailData ? [detailData] : []
  const visibleRows = rawRows.slice((page - 1) * pageSize, page * pageSize)
  const headers = rawRows.length ? Object.keys(rawRows[0]).filter(key => !technicalKey(key)) : []
  const tableWidth = headers.reduce((total, header) => total + columnWidth(header), ['reconciliation', 'refunds'].includes(report) ? 130 : 0)
  const pagination = { page, pageSize, total: rawRows.length, totalPages: Math.max(1, Math.ceil(rawRows.length / pageSize)) }

  const exportCsv = async () => {
    const response = await axios.get(`/api/reports/${report}?${params}&format=csv`, { responseType: 'blob' })
    const url = URL.createObjectURL(response.data)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${report}-${dateFrom}-${dateTo}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const exportExcel = () => {
    const businessRows = rawRows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !technicalKey(key))))
    const table = `<table><thead><tr>${headers.map(header => `<th>${reportLabel(report, header)}</th>`).join('')}</tr></thead><tbody>${businessRows.map(row => `<tr>${headers.map(header => `<td>${formatCell(header, row[header])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    const url = URL.createObjectURL(new Blob([table], { type: 'application/vnd.ms-excel' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${report}-${dateFrom}-${dateTo}.xls`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return <div className="space-y-6">
    <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div><h1 className="text-2xl font-bold">Business Intelligence</h1><p className="mt-1 text-muted-foreground">Executive control centre for sales, operations, cash, and obligations</p></div>
      <DateRangeFilter
        dateFrom={dateFrom}
        dateTo={dateTo}
        includeClear={false}
        onChange={range => { setDateFrom(range.dateFrom); setDateTo(range.dateTo); setPage(1) }}
      />
    </header>

    <div className="flex gap-2 overflow-x-auto border-b pb-3">
      {departments.map(item => <button key={item.id} type="button" onClick={() => selectDepartment(item.id)} className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm ${department === item.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}><item.icon className="h-4 w-4" />{item.label}</button>)}
    </div>

    {department === 'overview' ? (
      overviewLoading || !overview ? <div className="h-80 animate-pulse rounded-lg bg-muted" /> : <>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <MetricCard title="Sales" value={money(overview.kpis.revenue)} icon={<Banknote className="h-5 w-5" />} onClick={() => selectDepartment('sales')} />
          <MetricCard title="Gross Profit" value={money(overview.kpis.gross_profit)} icon={<TrendingUp className="h-5 w-5" />} onClick={() => selectDepartment('sales')} />
          <MetricCard title="Net Profit" value={money(overview.kpis.net_profit)} icon={<WalletCards className="h-5 w-5" />} onClick={() => selectDepartment('finance')} />
          <MetricCard title="Orders" value={Number(overview.kpis.orders).toLocaleString()} icon={<PackageCheck className="h-5 w-5" />} onClick={() => selectDepartment('sales')} />
          <MetricCard title="Pending Orders" value={Number(overview.kpis.pending_orders).toLocaleString()} icon={<AlertCircle className="h-5 w-5" />} danger={Number(overview.kpis.pending_orders) > 0} />
          <MetricCard title="Completed Orders" value={Number(overview.kpis.completed_orders).toLocaleString()} icon={<CheckCircle2 className="h-5 w-5" />} />
          <MetricCard title="Pending COD" value={money(overview.kpis.pending_cod)} icon={<Truck className="h-5 w-5" />} onClick={() => selectDepartment('courier')} danger={Number(overview.kpis.pending_cod) > 0} />
          <MetricCard title="Supplier Payables" value={money(overview.kpis.supplier_payables)} icon={<Building2 className="h-5 w-5" />} onClick={() => selectDepartment('suppliers')} />
          <MetricCard title="Rider Payables" value={money(overview.kpis.rider_payables)} icon={<Bike className="h-5 w-5" />} onClick={() => selectDepartment('riders')} />
          <MetricCard title="Customer Credit" value={money(overview.kpis.customer_credit)} icon={<Users className="h-5 w-5" />} onClick={() => selectDepartment('customers')} />
          <MetricCard title="Approved Expenses" value={money(overview.kpis.expenses)} icon={<ReceiptText className="h-5 w-5" />} onClick={() => selectDepartment('finance')} />
          <MetricCard title="Inventory Value" value={money(overview.kpis.inventory_value)} icon={<Boxes className="h-5 w-5" />} onClick={() => selectDepartment('inventory')} />
        </div>

        <section className="space-y-3">
          <div><h2 className="text-lg font-semibold">Performance Trends</h2><p className="text-sm text-muted-foreground">Sales, profit, payments, and delivery activity for the selected period</p></div>
          <div className="grid gap-4 lg:grid-cols-2">
          <BarList title="Sales Trend" rows={overview.trends} nameKey="date" valueKey="sales" />
          <BarList title="Profit Trend" rows={overview.trends} nameKey="date" valueKey="profit" />
          <BarList title="Payment Methods" rows={overview.paymentMethods} nameKey="method" valueKey="amount" />
          <BarList title="Delivery Performance" rows={overview.deliveryTypes} nameKey="type" valueKey="orders" format={value => `${Number(value).toLocaleString()} orders`} />
          </div>
        </section>

        <section className="space-y-3">
          <div><h2 className="text-lg font-semibold">Business Leaders</h2><p className="text-sm text-muted-foreground">Products and customers contributing most to revenue</p></div>
          <div className="grid gap-4 lg:grid-cols-2">
            <BarList title="Top Selling Products" rows={overview.topProducts} nameKey="product" valueKey="revenue" />
            <BarList title="Top Customers" rows={overview.topCustomers} nameKey="customer" valueKey="lifetime_value" />
          </div>
        </section>

        <section className="space-y-3">
          <div><h2 className="text-lg font-semibold">Pending Actions</h2><p className="text-sm text-muted-foreground">Items that need operational follow-up</p></div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Orders to process', overview.pendingActions.orders_to_process, PackageCheck],
              ['COD to collect', overview.pendingActions.cod_to_collect, Truck],
              ['Low-stock products', overview.pendingActions.low_stock, Boxes],
              ['Refunds due', overview.pendingActions.refunds_due, ReceiptText]
            ].map(([title, value, Icon]) => <div key={String(title)} className="flex items-center justify-between rounded-lg border p-4"><div><div className="text-sm text-muted-foreground">{String(title)}</div><strong className="mt-1 block text-xl">{Number(value).toLocaleString()}</strong></div><Icon className="h-5 w-5 text-primary" /></div>)}
          </div>
        </section>
      </>
    ) : <>
      <div className="flex flex-wrap items-center gap-2">
        {(departmentReports[department] || []).map(([key, title]) => <button key={key} type="button" onClick={() => { setReport(key); setPage(1) }} className={`rounded-lg px-3 py-2 text-sm ${report === key ? 'bg-foreground text-background' : 'border'}`}>{title}</button>)}
        <div className="ml-auto flex flex-wrap gap-2">
          {!['audit', 'profit', 'reconciliation', 'refunds'].includes(report) && !clientCourierReports.includes(report) && hasPermission('reports.export') && <button onClick={exportCsv} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><Download className="h-4 w-4" />CSV</button>}
          {rawRows.length > 0 && <button onClick={exportExcel} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><FileSpreadsheet className="h-4 w-4" />Excel</button>}
          <button onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><Printer className="h-4 w-4" />Print / PDF</button>
        </div>
      </div>

      {report === 'reconciliation' && hasPermission('reports.reconcile') && <section className="grid gap-3 border-y py-5 sm:grid-cols-3">
        <label className="text-sm">Actual cash counted<input type="number" value={actualCash} onChange={event => setActualCash(event.target.value)} placeholder="Enter cash counted" className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <label className="text-sm">Actual M-Pesa balance<input type="number" value={actualMpesa} onChange={event => setActualMpesa(event.target.value)} placeholder="Enter M-Pesa total" className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <button onClick={() => reconcile.mutate()} className="self-end rounded-lg bg-primary px-4 py-2 text-primary-foreground">Calculate {formatDate(reconciliationDate)}</button>
        {dateFrom !== dateTo && <p className="text-xs text-muted-foreground sm:col-span-3">Daily reconciliation is one day at a time. Because a range is selected, this will calculate the To date: {formatDate(reconciliationDate)}.</p>}
        {message && <p className="text-sm sm:col-span-3">{message}</p>}
      </section>}

      {reportHelp[report] && <p className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm leading-6 text-muted-foreground">{reportHelp[report]}</p>}

      <div className="overflow-x-auto rounded-lg border">
        {detailLoading ? <div className="p-10 text-center text-muted-foreground">Loading analysis...</div> :
          rawRows.length === 0 ? <div className="p-10 text-center text-muted-foreground">No records for this selection</div> :
          <table className="table-fixed text-sm" style={{ width: `${Math.max(tableWidth, 900)}px`, minWidth: '100%' }}>
            <colgroup>{headers.map(header => <col key={header} style={{ width: `${columnWidth(header)}px` }} />)}{['reconciliation', 'refunds'].includes(report) && <col style={{ width: '130px' }} />}</colgroup>
            <thead className="bg-muted"><tr>{headers.map(header => <th key={header} className="whitespace-normal px-3 py-3 text-left leading-5">{reportLabel(report, header)}</th>)}{['reconciliation', 'refunds'].includes(report) && <th className="px-3 py-3">Action</th>}</tr></thead>
            <tbody>{visibleRows.map((row, index) => <tr key={String(row.id || index)} className="border-t align-top hover:bg-muted/40">{headers.map(header => {
              const value = formatCell(header, row[header])
              const trackingUrl = typeof row.tracking_url === 'string' ? row.tracking_url : ''
              const isTrackingCell = header.includes('tracking') && trackingUrl && String(row[header] ?? '').trim()
              return <td key={header} className="overflow-hidden px-3 py-3">
                <div
                  title={descriptiveKey(header) ? String(row[header] ?? '') : undefined}
                  className={descriptiveKey(header)
                    ? 'overflow-hidden whitespace-normal break-words leading-5'
                    : 'truncate whitespace-nowrap'}
                  style={descriptiveKey(header) ? {
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 3
                  } : undefined}
                >{isTrackingCell ? (
                  <a href={trackingUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-primary hover:underline">
                    <span className="truncate">{value}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  </a>
                ) : value}</div>
              </td>
            })}
              {report === 'reconciliation' && <td className="px-3 py-2">{row.status === 'pending' && hasPermission('reports.reconcile') ? <button onClick={() => close.mutate(String(row.id))} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1"><LockKeyhole className="h-4 w-4" />Close</button> : String(row.status)}</td>}
              {report === 'refunds' && <td className="px-3 py-2"><button onClick={() => setSelectedRefund(row)} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1">Record Refund<ChevronRight className="h-4 w-4" /></button></td>}</tr>)}</tbody>
          </table>}
        {rawRows.length > 0 && <Pagination meta={pagination} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} />}
      </div>
    </>}

    {selectedRefund && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div className="w-full max-w-md space-y-4 rounded-lg bg-background p-6 shadow-xl">
      <div><h2 className="font-semibold">Record Customer Refund</h2><p className="text-sm text-muted-foreground">{String(selectedRefund.order_number)} - {money(selectedRefund.amount)}</p></div>
      <label className="block text-sm">Payment method<select value={refundMethod} onChange={event => setRefundMethod(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank_transfer">Bank</option></select></label>
      <label className="block text-sm">Reference<input value={refundReference} onChange={event => setRefundReference(event.target.value)} placeholder="Payment reference" className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
      <div className="flex gap-2"><button onClick={() => payRefund.mutate()} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground">Confirm Refund</button><button onClick={() => setSelectedRefund(null)} className="rounded-lg border px-4 py-2">Cancel</button></div>
    </div></div>}
  </div>
}
