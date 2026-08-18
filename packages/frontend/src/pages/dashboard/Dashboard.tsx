import React from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/authStore'
import { DateRangeFilter, formatDisplayDate, presetDateRange, todayDate } from '../../components/DateRangeFilter'
import { formatMoney } from '../../lib/format'
import { 
  DollarSign, 
  ShoppingBag, 
  CreditCard, 
  Truck, 
  Package, 
  AlertCircle,
  TrendingUp,
  TrendingDown,
  BarChart3,
  Wallet,
  Users,
  CheckCircle2,
  FileText,
  History,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  X
} from 'lucide-react'

interface Stats {
  myTodaySales?: number
  myPeriodSales?: number
  myPeriodOrders?: number
  myOpenOrders?: number
  myCompletedOrders?: number
  myPendingSpeedafOrders?: number
  myPendingSpeedafValue?: number
  todaySales?: number
  weekSales?: number
  monthSales?: number
  periodSales?: number
  periodOrders?: number
  periodDeliveryProfit?: number
  periodExpenses?: number
  todayExpenses?: number
  todayGrossAfterDelivery?: number
  todayOperatingProfit?: number
  monthToDateExpenses?: number
  monthToDateNetProfit?: number
  totalOrders?: number
  outstandingCOD?: number
  supplierPayables?: number
  riderPayables?: number
  lowStockCount?: number
  grossProfit?: number
  netProfit?: number
  shopStockValue?: number
  availableStockValue?: number
  reservedStockValue?: number
  damagedStockValue?: number
  expectedSalesValue?: number
  potentialGrossMargin?: number
  missingCostCount?: number
}

interface ManagementCommissionSummary {
  totalEarned: number
  totalReversals: number
  totalPayments: number
  approvedUnpaid: number
  approvedPayable: number
  pendingAmount: number
  outstandingAmount: number
  netCommission: number
  recoveryDue: number
  salespersonCount: number
  orderCount: number
  itemCount: number
}

interface ManagementCommissionSalesperson {
  salespersonId: string
  fullName: string
  email: string
  orderCount: number
  eligibleQuantity: number
  grossEarned: number
  reversals: number
  netCommission: number
  paid: number
  outstandingAmount: number
  approvedPayable: number
  pendingAmount: number
  recoveryDue: number
}

interface StatsCardProps {
  title: string
  subtitle?: string
  description?: string
  value: string | number
  icon: React.ReactNode
  trend?: { value: string; positive: boolean }
  urgent?: boolean
  onClick?: () => void
}

interface DrilldownSelection {
  card: string
  title: string
}

interface DrilldownResponse {
  kind: 'orders' | 'commissions' | 'salespeople'
  card: string
  title: string
  dateFrom: string
  dateTo: string
  periodLabel?: string | null
  summary?: {
    completedOrders: number
    commissionEarningOrders: number
    totalCompletedSales: number
    recordedCommission: number
  }
  total: number
  truncated: boolean
  rows: any[]
}

function displayDate(value: string | null | undefined): string {
  if (!value) return '-'
  const raw = String(value)
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw.slice(0, 10)
  return parsed.toLocaleDateString(undefined, { timeZone: 'Africa/Nairobi', dateStyle: 'medium' })
}

function displayStatus(value: string | null | undefined): string {
  return String(value || '-').replaceAll('_', ' ')
}

function displayRateSummary(value: string | null | undefined): string {
  if (!value) return '-'
  return String(value).split(',').map(rate => formatMoney(Number(rate.trim()))).join(', ')
}

function commissionStatusClass(status: string | null | undefined): string {
  if (status === 'earned') return 'bg-green-100 text-green-800'
  if (status === 'expected') return 'bg-amber-100 text-amber-800'
  if (status === 'reversed') return 'bg-red-100 text-red-800'
  return 'bg-muted text-muted-foreground'
}

function StatsCard({ title, subtitle, description, value, icon, trend, urgent, onClick }: StatsCardProps) {
  const content = (
    <>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-xs text-muted-foreground sm:text-sm">{title}</p>
          {subtitle && <p className="mt-1 hidden text-xs text-muted-foreground sm:block">{subtitle}</p>}
          {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
          <p className={`mt-1 break-words text-lg font-bold sm:text-2xl ${urgent ? 'text-destructive' : ''}`}>{value}</p>
          {trend && (
            <div className="flex items-center gap-1 mt-2">
              {trend.positive ? (
                <TrendingUp className="h-3 w-3 text-green-500" />
              ) : (
                <TrendingDown className="h-3 w-3 text-red-500" />
              )}
              <span className={`text-xs ${trend.positive ? 'text-green-500' : 'text-red-500'}`}>
                {trend.value}
              </span>
            </div>
          )}
          {onClick && <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">View details <ChevronRight className="h-3 w-3" /></span>}
        </div>
        <div className={`hidden h-12 w-12 rounded-lg sm:flex items-center justify-center ${
          urgent ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'
        }`}>
          {icon}
        </div>
      </div>
    </>
  )
  return onClick
    ? <button type="button" onClick={onClick} title={`View ${title}`} className="h-full w-full rounded-lg border bg-card p-3 text-left transition-all hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:p-5">{content}</button>
    : <div className="h-full rounded-lg border bg-card p-3 sm:p-5">{content}</div>
}

function MobileDetail({ label, children, full = false }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  )
}

function MobileDrilldownRows({ data, canOpenOrders, onOpenOrder }: {
  data: DrilldownResponse
  canOpenOrders: boolean
  onOpenOrder: (orderId: string) => void
}) {
  return (
    <div className="space-y-3 md:hidden" data-testid="mobile-drilldown-cards">
      {data.rows.map((row, index) => {
        if (data.kind === 'salespeople') {
          return (
            <article key={row.salesperson_id} className="rounded-lg border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="font-semibold">{row.full_name}</p><p className="truncate text-xs text-muted-foreground">{row.email}</p></div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs">#{index + 1}</span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                <MobileDetail label="Orders">{row.orders}</MobileDetail>
                <MobileDetail label="Recorded">{formatMoney(row.recorded)}</MobileDetail>
                <MobileDetail label="Reversals">{formatMoney(row.reversals)}</MobileDetail>
                <MobileDetail label="Paid">{formatMoney(row.paid)}</MobileDetail>
                <MobileDetail label="Balance" full><strong>{formatMoney(row.balance)}</strong></MobileDetail>
              </dl>
            </article>
          )
        }

        if (data.kind === 'commissions') {
          return (
            <article key={row.transaction_id} className="rounded-lg border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {row.order_id && canOpenOrders
                    ? <button type="button" onClick={() => onOpenOrder(row.order_id)} className="font-semibold text-primary hover:underline">{row.order_number}</button>
                    : <p className="font-semibold">{row.order_number || 'Commission entry'}</p>}
                  <p className="text-xs text-muted-foreground">{row.salesperson_name}</p>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs capitalize">{displayStatus(row.transaction_status)}</span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                <MobileDetail label="Product" full>{row.product_name || '-'}{row.reason && <span className="mt-1 block text-xs text-muted-foreground">{row.reason}</span>}</MobileDetail>
                <MobileDetail label="Sale date">{displayDate(row.sale_date || row.policy_date)}</MobileDetail>
                <MobileDetail label="Earned">{displayDate(row.earned_date || row.qualification_date)}</MobileDetail>
                <MobileDetail label="Quantity">{Number(row.eligible_quantity || 0)}</MobileDetail>
                <MobileDetail label="Rate">{formatMoney(row.rate_per_item)}</MobileDetail>
                <MobileDetail label="Commission"><strong>{formatMoney(row.signed_amount)}</strong></MobileDetail>
                <MobileDetail label="Outstanding">{formatMoney(row.outstanding_amount)}</MobileDetail>
              </dl>
            </article>
          )
        }

        return (
          <article key={row.order_id} className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {canOpenOrders
                  ? <button type="button" onClick={() => onOpenOrder(row.order_id)} className="font-semibold text-primary hover:underline">{row.order_number}</button>
                  : <p className="font-semibold">{row.order_number}</p>}
                <p className="text-xs text-muted-foreground">Created by {row.creator_name || '-'}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium capitalize ${commissionStatusClass(row.commission_status)}`}>{displayStatus(row.commission_status)}</span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
              <MobileDetail label="Products" full>{row.product_summary}<span className="mt-1 block text-xs text-muted-foreground">{Number(row.total_quantity || 0)} item(s)</span></MobileDetail>
              <MobileDetail label="Sale date">{displayDate(row.sale_date)}</MobileDetail>
              <MobileDetail label="Completed">{displayDate(row.completion_date)}</MobileDetail>
              <MobileDetail label="Sale">{formatMoney(row.sale_amount)}</MobileDetail>
              <MobileDetail label="Commission"><strong>{formatMoney(row.commission_amount)}</strong></MobileDetail>
              <MobileDetail label="Order status"><span className="capitalize">{displayStatus(row.status)}</span></MobileDetail>
              <MobileDetail label="Payment"><span className="capitalize">{displayStatus(row.payment_status)}</span></MobileDetail>
            </dl>
          </article>
        )
      })}
    </div>
  )
}

function DesktopDrilldownTable({ children, label }: { children: React.ReactNode; label: string }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [canMoveLeft, setCanMoveLeft] = useState(false)
  const [canMoveRight, setCanMoveRight] = useState(false)

  const updatePosition = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    setCanMoveLeft(viewport.scrollLeft > 2)
    setCanMoveRight(viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 2)
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    updatePosition()
    const observer = new ResizeObserver(updatePosition)
    observer.observe(viewport)
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
    return () => observer.disconnect()
  }, [children, updatePosition])

  const move = (direction: -1 | 1) => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollBy({ left: direction * Math.max(320, viewport.clientWidth * 0.75), behavior: 'smooth' })
  }

  return (
    <div className="hidden min-h-0 flex-1 flex-col overflow-hidden rounded-lg border md:flex">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2">
        <span className="text-xs text-muted-foreground">Move across columns</span>
        <div className="flex gap-2">
          <button type="button" aria-label={`Show previous ${label} columns`} disabled={!canMoveLeft} onClick={() => move(-1)} className="inline-flex h-9 items-center gap-1 rounded-md border bg-background px-3 text-xs font-medium disabled:opacity-35"><ChevronLeft className="h-4 w-4" /> Left</button>
          <button type="button" aria-label={`Show more ${label} columns`} disabled={!canMoveRight} onClick={() => move(1)} className="inline-flex h-9 items-center gap-1 rounded-md border bg-background px-3 text-xs font-medium disabled:opacity-35">Right <ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>
      <div
        ref={viewportRef}
        data-desktop-table-scroll={label}
        role="region"
        aria-label={`${label} table`}
        tabIndex={0}
        onScroll={updatePosition}
        className="min-h-0 flex-1 overflow-auto"
      >
        {children}
      </div>
    </div>
  )
}

function DashboardDrilldown({
  selection,
  data,
  isLoading,
  error,
  canOpenOrders,
  canOpenCommission,
  filterDateFrom,
  filterDateTo,
  onFilterChange,
  onClose,
  onOpenOrder,
  onOpenOrders,
  onOpenCommission
}: {
  selection: DrilldownSelection
  data?: DrilldownResponse
  isLoading: boolean
  error: unknown
  canOpenOrders: boolean
  canOpenCommission: boolean
  filterDateFrom: string
  filterDateTo: string
  onFilterChange: (range: { dateFrom: string; dateTo: string }) => void
  onClose: () => void
  onOpenOrder: (orderId: string) => void
  onOpenOrders: () => void
  onOpenCommission: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={selection.title}>
      <button type="button" aria-label="Close details" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <aside className="relative flex h-full w-full max-w-5xl flex-col bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b p-4 sm:p-6">
          <div>
            <h2 className="text-lg font-semibold">{data?.title || selection.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {data ? `${data.periodLabel || `${displayDate(data.dateFrom)} to ${displayDate(data.dateTo)}`} · ${data.total} record${data.total === 1 ? '' : 's'}` : 'Loading contributing records…'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border p-2 hover:bg-muted" aria-label="Close details"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6 md:overflow-hidden">
          {selection.card === 'my_completed_orders' && (
            <div className="mb-4 rounded-lg border bg-muted/20 p-3">
              <DateRangeFilter
                dateFrom={filterDateFrom}
                dateTo={filterDateTo}
                includeClear={false}
                compact
                onChange={onFilterChange}
              />
              <p className="mt-2 text-xs text-muted-foreground">This filters by the date the order became completed. The sale date still determines the commission rate.</p>
            </div>
          )}
          {isLoading && <div className="rounded-lg border bg-muted/20 p-8 text-center text-muted-foreground">Loading details…</div>}
          {Boolean(error) && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{(error as any)?.response?.data?.error?.message || 'Unable to load dashboard details'}</div>}
          {data?.summary && (
            <div className="mb-4 grid grid-cols-1 gap-3 min-[430px]:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Completed orders</p><p className="mt-1 text-lg font-semibold">{data.summary.completedOrders.toLocaleString()}</p></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Orders with recorded commission</p><p className="mt-1 text-lg font-semibold">{data.summary.commissionEarningOrders.toLocaleString()}</p></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Completed sales</p><p className="mt-1 text-lg font-semibold">{formatMoney(data.summary.totalCompletedSales)}</p></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Recorded commission</p><p className="mt-1 text-lg font-semibold">{formatMoney(data.summary.recordedCommission)}</p></div>
            </div>
          )}
          {data && data.rows.length === 0 && <div className="rounded-lg border bg-muted/20 p-8 text-center text-muted-foreground">No records contribute to this card.</div>}
          {data && data.rows.length > 0 && (
            <>
            <MobileDrilldownRows data={data} canOpenOrders={canOpenOrders} onOpenOrder={onOpenOrder} />
            <DesktopDrilldownTable label={data.kind === 'salespeople' ? 'salesperson commission' : data.kind === 'commissions' ? 'commission sales' : 'completed orders'}>
              {data.kind === 'orders' && (
                <table className="w-full min-w-[1420px] text-sm">
                  <thead className="sticky top-0 z-10 bg-muted"><tr><th className="px-3 py-3 text-right">#</th><th className="px-3 py-3 text-left">Order</th><th className="px-3 py-3 text-left">Created by</th><th className="px-3 py-3 text-left">Sale date</th><th className="px-3 py-3 text-left">Delivered</th><th className="px-3 py-3 text-left">Final completion</th><th className="px-3 py-3 text-left">Products</th><th className="px-3 py-3 text-right">Sale</th><th className="px-3 py-3 text-right">Rate</th><th className="px-3 py-3 text-right">Commission</th><th className="px-3 py-3 text-left">Commission status</th><th className="px-3 py-3 text-left">Order</th><th className="px-3 py-3 text-left">Payment</th></tr></thead>
                  <tbody>{data.rows.map((row, index) => <tr key={row.order_id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-3 text-right text-muted-foreground">{index + 1}</td>
                    <td className="px-3 py-3 font-medium">{canOpenOrders ? <button type="button" onClick={() => onOpenOrder(row.order_id)} className="text-primary hover:underline">{row.order_number}</button> : row.order_number}</td>
                    <td className="px-3 py-3">{row.creator_name || '-'}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{displayDate(row.sale_date)}</td><td className="px-3 py-3 whitespace-nowrap">{displayDate(row.delivery_date || row.completion_date)}</td><td className="px-3 py-3 whitespace-nowrap">{displayDate(row.completion_date)}</td>
                    <td className="max-w-xs px-3 py-3">{row.product_summary}<div className="text-xs text-muted-foreground">{Number(row.total_quantity || 0)} item(s)</div></td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">{formatMoney(row.sale_amount)}</td><td className="px-3 py-3 text-right whitespace-nowrap">{displayRateSummary(row.rate_summary)}</td><td className="px-3 py-3 text-right whitespace-nowrap">{formatMoney(row.commission_amount)}</td>
                    <td className="max-w-xs px-3 py-3"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium capitalize ${commissionStatusClass(row.commission_status)}`}>{displayStatus(row.commission_status)}</span><div className="mt-1 text-xs text-muted-foreground">{row.commission_reason}</div></td>
                    <td className="px-3 py-3 capitalize">{displayStatus(row.status)}</td><td className="px-3 py-3 capitalize">{displayStatus(row.payment_status)}{Number(row.cod_outstanding || 0) > 0 && <div className="text-xs text-amber-700">COD due {formatMoney(row.cod_outstanding)}</div>}</td>
                  </tr>)}</tbody>
                </table>
              )}
              {data.kind === 'commissions' && (
                <table className="w-full min-w-[1320px] text-sm">
                  <thead className="sticky top-0 z-10 bg-muted"><tr><th className="px-3 py-3 text-right">#</th><th className="px-3 py-3 text-left">Order</th><th className="px-3 py-3 text-left">Sale date</th><th className="px-3 py-3 text-left">Delivered</th><th className="px-3 py-3 text-left">Final completion</th><th className="px-3 py-3 text-left">Earned</th><th className="px-3 py-3 text-left">Salesperson</th><th className="px-3 py-3 text-left">Product</th><th className="px-3 py-3 text-right">Qty</th><th className="px-3 py-3 text-right">Rate</th><th className="px-3 py-3 text-right">Commission</th><th className="px-3 py-3 text-right">Paid</th><th className="px-3 py-3 text-right">Outstanding</th><th className="px-3 py-3 text-left">Status</th></tr></thead>
                  <tbody>{data.rows.map((row, index) => <tr key={row.transaction_id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-3 text-right text-muted-foreground">{index + 1}</td>
                    <td className="px-3 py-3 font-medium">{row.order_id && canOpenOrders ? <button type="button" onClick={() => onOpenOrder(row.order_id)} className="text-primary hover:underline">{row.order_number}</button> : row.order_number}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{displayDate(row.sale_date || row.policy_date)}</td><td className="px-3 py-3 whitespace-nowrap">{displayDate(row.delivery_date || row.completion_date)}</td><td className="px-3 py-3 whitespace-nowrap">{displayDate(row.completion_date)}</td><td className="px-3 py-3 whitespace-nowrap">{displayDate(row.earned_date || row.qualification_date)}</td><td className="px-3 py-3">{row.salesperson_name}</td>
                    <td className="max-w-xs px-3 py-3">{row.product_name}{row.reason && <div className="text-xs text-muted-foreground">{row.reason}</div>}</td><td className="px-3 py-3 text-right">{Number(row.eligible_quantity || 0)}</td><td className="px-3 py-3 text-right whitespace-nowrap">{formatMoney(row.rate_per_item)}</td>
                    <td className={`px-3 py-3 text-right font-medium whitespace-nowrap ${Number(row.signed_amount) < 0 ? 'text-red-600' : ''}`}>{formatMoney(row.signed_amount)}</td><td className="px-3 py-3 text-right whitespace-nowrap">{formatMoney(row.paid_amount)}</td><td className="px-3 py-3 text-right whitespace-nowrap">{formatMoney(row.outstanding_amount)}</td>
                    <td className="px-3 py-3 capitalize">{displayStatus(row.transaction_status)}<div className="text-xs text-muted-foreground">{displayStatus(row.transaction_type)}</div></td>
                  </tr>)}</tbody>
                </table>
              )}
              {data.kind === 'salespeople' && (
                <table className="w-full min-w-[800px] text-sm"><thead className="sticky top-0 z-10 bg-muted"><tr><th className="px-3 py-3 text-right">#</th><th className="px-3 py-3 text-left">Salesperson</th><th className="px-3 py-3 text-right">Orders</th><th className="px-3 py-3 text-right">Recorded</th><th className="px-3 py-3 text-right">Reversals</th><th className="px-3 py-3 text-right">Balance</th><th className="px-3 py-3 text-right">Paid</th></tr></thead><tbody>{data.rows.map((row, index) => <tr key={row.salesperson_id} className="border-t"><td className="px-3 py-3 text-right text-muted-foreground">{index + 1}</td><td className="px-3 py-3 font-medium">{row.full_name}<div className="text-xs font-normal text-muted-foreground">{row.email}</div></td><td className="px-3 py-3 text-right">{row.orders}</td><td className="px-3 py-3 text-right">{formatMoney(row.recorded)}</td><td className="px-3 py-3 text-right">{formatMoney(row.reversals)}</td><td className="px-3 py-3 text-right font-medium">{formatMoney(row.balance)}</td><td className="px-3 py-3 text-right">{formatMoney(row.paid)}</td></tr>)}</tbody></table>
              )}
            </DesktopDrilldownTable>
            </>
          )}
          {data?.truncated && <p className="mt-3 text-xs text-amber-700">Showing the newest 100 of {data.total} records. Open the full module for the complete list.</p>}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t p-4">
          {data?.kind === 'orders' && canOpenOrders && <button type="button" onClick={onOpenOrders} className="inline-flex items-center gap-2 rounded border px-3 py-2 text-sm hover:bg-muted">Open Orders <ExternalLink className="h-4 w-4" /></button>}
          {(data?.kind === 'commissions' || data?.kind === 'salespeople') && canOpenCommission && <button type="button" onClick={onOpenCommission} className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm text-primary-foreground">Open Commission centre <ExternalLink className="h-4 w-4" /></button>}
          <button type="button" onClick={onClose} className="rounded border px-3 py-2 text-sm hover:bg-muted">Close</button>
        </div>
      </aside>
    </div>
  )
}

export function Dashboard() {
  const navigate = useNavigate()
  const { user, hasPermission } = useAuthStore()
  const today = todayDate()
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(today)
  const [commissionRange, setCommissionRange] = useState(() => presetDateRange('month'))
  const [drilldownSelection, setDrilldownSelection] = useState<DrilldownSelection | null>(null)
  const [drilldownDateFrom, setDrilldownDateFrom] = useState(today)
  const [drilldownDateTo, setDrilldownDateTo] = useState(today)
  const canPersonalSales = hasPermission('dashboard.personal_sales')
  const canPersonalOrders = hasPermission('dashboard.personal_orders')
  const canPersonalSpeedaf = hasPermission('dashboard.pending_speedaf')
  const canManagementSales = hasPermission('dashboard.management_sales')
  const canManagementProfit = hasPermission('dashboard.management_profit')
  const canManagementExpenses = hasPermission('dashboard.management_expenses')
  const canManagementSuppliers = hasPermission('dashboard.management_suppliers')
  const canManagementRiders = hasPermission('dashboard.management_riders')
  const canManagementInventory = hasPermission('dashboard.management_inventory')
  const canManagementReports = hasPermission('dashboard.management_reports')
  const canManagementAudit = hasPermission('dashboard.management_audit')
  const hasDashboardStats = canPersonalSales || canPersonalOrders || canPersonalSpeedaf || canManagementSales || canManagementProfit || canManagementExpenses || canManagementSuppliers || canManagementRiders || canManagementInventory
  const hasManagementTools = canManagementReports || canManagementAudit
  const canOwnCommissionSummary = hasPermission('commission.own_view') || hasPermission('commission.own_monthly')
  const hasOwnCommissionAccess = canOwnCommissionSummary || hasPermission('commission.own_daily') || hasPermission('commission.own_history') || hasPermission('commission.own_transactions') || hasPermission('commission.own_potential')
  const canManagementCommission = hasPermission('commission.view')
  const isAdministrativeRole = ['admin', 'owner'].includes(String(user?.role || '').toLowerCase())
  const showOwnCommission = hasOwnCommissionAccess && !isAdministrativeRole

  const { data: stats, isLoading, error } = useQuery<Stats>({
    queryKey: ['dashboard-stats', dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      const response = await axios.get(`/api/dashboard/stats?${params.toString()}`)
      return response.data
    },
    enabled: hasDashboardStats
  })

  const { data: commissionSummary } = useQuery({
    queryKey: ['commission-own-summary'],
    queryFn: async () => (await axios.get('/api/commissions/own/summary')).data,
    enabled: canOwnCommissionSummary && !isAdministrativeRole,
    staleTime: 0,
    refetchOnMount: 'always'
  })

  const { data: commissionStatus } = useQuery({
    queryKey: ['commission-status'],
    queryFn: async () => (await axios.get('/api/commissions/status')).data,
    enabled: hasOwnCommissionAccess || canManagementCommission
  })

  const { data: managementCommission } = useQuery<ManagementCommissionSummary>({
    queryKey: ['management-commission', commissionRange.dateFrom, commissionRange.dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({ date_from: commissionRange.dateFrom, date_to: commissionRange.dateTo })
      const response = await axios.get(`/api/commissions/summary?${params.toString()}`)
      return response.data
    },
    enabled: canManagementCommission,
    staleTime: 0,
    refetchOnMount: 'always'
  })

  const { data: managementSalespeopleResponse } = useQuery<{ salespeople: ManagementCommissionSalesperson[] }>({
    queryKey: ['commission-by-salesperson', commissionRange.dateFrom, commissionRange.dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({ date_from: commissionRange.dateFrom, date_to: commissionRange.dateTo })
      const response = await axios.get(`/api/commissions/by-salesperson?${params.toString()}`)
      return response.data
    },
    enabled: canManagementCommission,
    staleTime: 0,
    refetchOnMount: 'always'
  })
  const managementSalespeople = managementSalespeopleResponse?.salespeople || []

  const { data: drilldownData, isLoading: drilldownLoading, error: drilldownError } = useQuery<DrilldownResponse>({
    queryKey: ['dashboard-drilldown', drilldownSelection?.card, drilldownDateFrom, drilldownDateTo],
    queryFn: async () => {
      const params = new URLSearchParams({ card: drilldownSelection!.card, date_from: drilldownDateFrom, date_to: drilldownDateTo })
      return (await axios.get(`/api/dashboard/drilldown?${params.toString()}`)).data
    },
    enabled: Boolean(drilldownSelection),
    staleTime: 0
  })

  useEffect(() => {
    if (!drilldownSelection) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrilldownSelection(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [drilldownSelection])

  const openDrilldown = (card: string, title: string) => {
    setDrilldownDateFrom(dateFrom)
    setDrilldownDateTo(dateTo)
    setDrilldownSelection({ card, title })
  }
  const openManagementCommissionDrilldown = (card: string, title: string) => {
    setDrilldownDateFrom(commissionRange.dateFrom)
    setDrilldownDateTo(commissionRange.dateTo)
    setDrilldownSelection({ card, title })
  }
  const financialMax = Math.max(
    canManagementSales ? stats?.periodSales || 0 : 0,
    canManagementExpenses ? stats?.periodExpenses || 0 : 0,
    1
  )
  const orderMax = Math.max(stats?.totalOrders || 0, stats?.periodOrders || 0, 1)
  const datedQuery = (from = dateFrom, to = dateTo) => new URLSearchParams({ date_from: from, date_to: to }).toString()
  const reportUrl = (department: string, report: string, from = dateFrom, to = dateTo) =>
    `/reports?department=${department}&report=${report}&${datedQuery(from, to)}`
  const weekFrom = presetDateRange('7days').dateFrom

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-muted rounded w-48 animate-pulse" />
        <div className="grid grid-cols-1 min-[430px]:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-28 bg-muted rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-80 bg-muted rounded-xl animate-pulse" />
          <div className="h-80 bg-muted rounded-xl animate-pulse" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="h-16 w-16 mx-auto text-destructive mb-4" />
          <h3 className="text-lg font-medium">Failed to load dashboard data</h3>
          <p className="text-muted-foreground mt-1">Check your connection and try again</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Your permitted sales, order and commission information</p>
        </div>
        {hasDashboardStats && (
          <DateRangeFilter
            dateFrom={dateFrom}
            dateTo={dateTo}
            includeClear={false}
            compact
            onChange={range => { setDateFrom(range.dateFrom); setDateTo(range.dateTo) }}
          />
        )}
      </div>

      {!isAdministrativeRole && (canPersonalSales || canPersonalOrders || canPersonalSpeedaf) && (
        <section className="space-y-3">
          <div><h2 className="text-lg font-semibold">My activity</h2><p className="text-sm text-muted-foreground">Sales and orders attributed to your account</p></div>
          <div className="grid grid-cols-1 gap-3 min-[430px]:grid-cols-2 sm:gap-4 lg:grid-cols-4">
            {canPersonalSales && <StatsCard title="My sales today" value={formatMoney(stats?.myTodaySales)} icon={<DollarSign className="h-6 w-6" />} onClick={() => openDrilldown('my_sales_today', 'My completed sales today')} />}
            {canPersonalSales && <StatsCard title="My sales — selected period" value={formatMoney(stats?.myPeriodSales)} icon={<TrendingUp className="h-6 w-6" />} onClick={() => openDrilldown('my_sales_period', 'My completed sales for the selected period')} />}
            {canPersonalOrders && <StatsCard title="My orders — selected period" value={stats?.myPeriodOrders || 0} icon={<Package className="h-6 w-6" />} onClick={() => openDrilldown('my_orders_period', 'My orders for the selected period')} />}
            {canPersonalOrders && <StatsCard title="My open orders" subtitle="Current open queue · All dates" value={stats?.myOpenOrders || 0} icon={<ShoppingBag className="h-6 w-6" />} onClick={() => openDrilldown('my_open_orders', 'My open orders')} />}
            {canPersonalOrders && <StatsCard title="My completed sales — selected period" subtitle="Orders I created, filtered by completion date" value={stats?.myCompletedOrders || 0} icon={<CheckCircle2 className="h-6 w-6" />} onClick={() => openDrilldown('my_completed_orders', 'My completed sales for the selected period')} />}
            {canPersonalSpeedaf && <StatsCard title="My Speedaf orders awaiting completion" value={stats?.myPendingSpeedafOrders || 0} subtitle={`${formatMoney(stats?.myPendingSpeedafValue)} awaiting remittance · All dates`} icon={<Truck className="h-6 w-6" />} onClick={() => openDrilldown('my_speedaf_pending', 'My Speedaf orders awaiting completion')} />}
          </div>
        </section>
      )}

      {(canManagementSales || canManagementProfit || canManagementExpenses || canManagementSuppliers || canManagementRiders || canManagementInventory) && (
        <section className="space-y-3">
        <div><h2 className="text-lg font-semibold">Business overview</h2><p className="text-sm text-muted-foreground">Company-wide figures available to management</p></div>
      <div className="grid grid-cols-1 gap-3 min-[430px]:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        {canManagementInventory && (
        <StatsCard
          title="Shop Stock Value"
          subtitle="Total purchase cost of all shop-owned stock"
          value={formatMoney(stats?.shopStockValue)}
          icon={<Package className="h-6 w-6" />}
          onClick={hasPermission('inventory.view') ? () => navigate('/inventory') : undefined}
        />)}
        {canManagementProfit && (
        <StatsCard
          title="Today's Operating Profit"
          subtitle="Today's sales profit after delivery costs and recognized expenses"
          value={formatMoney(stats?.todayOperatingProfit)}
          icon={<TrendingUp className="h-6 w-6" />}
          urgent={(stats?.todayOperatingProfit || 0) < 0}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'profit', today, today)) : undefined}
        />)}
        {canManagementProfit && (
        <StatsCard
          title="Month-to-Date Net Profit"
          subtitle="Profit accrued this month after recurring and one-off expenses"
          value={formatMoney(stats?.monthToDateNetProfit)}
          icon={<DollarSign className="h-6 w-6" />}
          urgent={(stats?.monthToDateNetProfit || 0) < 0}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'profit', `${today.slice(0, 8)}01`, today)) : undefined}
        />)}
        {canManagementSales && (
        <StatsCard
          title="Period Sales"
          value={formatMoney(stats?.periodSales)}
          icon={<DollarSign className="h-6 w-6" />}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'sales')) : undefined}
        />)}
        {canManagementSales && (
        <StatsCard
          title="Period Orders"
          value={stats?.periodOrders || 0}
          icon={<Package className="h-6 w-6" />}
          onClick={hasPermission('orders.view') ? () => navigate(`/orders?${datedQuery()}`) : undefined}
        />)}
        {canManagementExpenses && (
        <StatsCard
          title="Recognized Expenses"
          subtitle="Daily, monthly prorated, and one-off expenses for selected period"
          value={formatMoney(stats?.periodExpenses)}
          icon={<CreditCard className="h-6 w-6" />}
          onClick={hasPermission('expenses.view') ? () => navigate(`/expenses?${datedQuery()}`) : undefined}
        />)}
        {canManagementProfit && (
        <StatsCard
          title="Delivery Margin"
          subtitle="Customer delivery fee - actual delivery cost"
          value={formatMoney(stats?.periodDeliveryProfit)}
          icon={<Truck className="h-6 w-6" />}
          urgent={(stats?.periodDeliveryProfit || 0) < 0}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'sales')) : undefined}
        />)}
        {canManagementSales && (
        <StatsCard
          title="Today's Sales"
          value={formatMoney(stats?.todaySales)}
          icon={<DollarSign className="h-6 w-6" />}
          trend={{ value: "+12% from yesterday", positive: true }}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'sales', today, today)) : undefined}
        />)}
        {canManagementSales && (
        <StatsCard
          title="Weekly Sales"
          value={formatMoney(stats?.weekSales)}
          icon={<BarChart3 className="h-6 w-6" />}
          trend={{ value: "+12% from last week", positive: true }}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'sales', weekFrom, today)) : undefined}
        />)}
        {canManagementSales && (
        <StatsCard
          title="Total Orders"
          value={stats?.totalOrders || 0}
          icon={<Package className="h-6 w-6" />}
          trend={{ value: "+8% from last month", positive: true }}
          onClick={hasPermission('orders.view') ? () => navigate('/orders') : undefined}
        />)}
        {canManagementSales && (
        <StatsCard
          title="Outstanding COD"
          value={formatMoney(stats?.outstandingCOD)}
          icon={<CreditCard className="h-6 w-6" />}
          onClick={hasPermission('deliveries.view') ? () => navigate('/deliveries?view=cod') : undefined}
        />)}
        {canManagementSuppliers && (
        <StatsCard
          title="Supplier Payables"
          value={formatMoney(stats?.supplierPayables)}
          icon={<ShoppingBag className="h-6 w-6" />}
          onClick={hasPermission('suppliers.view') ? () => navigate('/suppliers?filter=outstanding') : undefined}
        />)}
        {canManagementRiders && (
        <StatsCard
          title="Rider Payments Due"
          value={formatMoney(stats?.riderPayables)}
          icon={<Truck className="h-6 w-6" />}
          onClick={hasPermission('riders.view') ? () => navigate('/riders?filter=outstanding') : undefined}
        />)}
        {canManagementInventory && (
        <StatsCard
          title="Low Stock Alerts"
          value={stats?.lowStockCount || 0}
          icon={<AlertCircle className="h-6 w-6" />}
          urgent={(stats?.lowStockCount || 0) > 0}
          onClick={hasPermission('inventory.view') ? () => navigate('/inventory?filter=low_stock') : undefined}
        />)}
        {canManagementProfit && (
        <StatsCard
          title="Period Net Profit"
          subtitle="Selected date range after recognized expenses"
          value={formatMoney(stats?.netProfit)}
          icon={<DollarSign className="h-6 w-6" />}
          trend={{ value: "+15% from last month", positive: true }}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'profit')) : undefined}
        />)}
      </div>
      </section>
      )}

      {hasManagementTools && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Management tools</h2>
            <p className="text-sm text-muted-foreground">Open the operational tools assigned to your role. No company dashboard figures are loaded for this access level.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {canManagementReports && (
              <button
                type="button"
                disabled={!hasPermission('reports.view')}
                onClick={hasPermission('reports.view') ? () => navigate('/reports') : undefined}
                className="rounded-lg border bg-card p-4 text-left transition-all enabled:hover:border-primary/50 enabled:hover:shadow-sm disabled:cursor-default"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-md bg-primary/10 p-2 text-primary"><FileText className="h-5 w-5" /></div>
                  <div>
                    <h3 className="font-medium">Reports</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {hasPermission('reports.view')
                        ? 'Open the reports available to your account.'
                        : 'This dashboard shortcut is assigned, but reports.view is needed to open reports.'}
                    </p>
                  </div>
                </div>
              </button>
            )}
            {canManagementAudit && (
              <button
                type="button"
                disabled={!hasPermission('audit.view')}
                onClick={hasPermission('audit.view') ? () => navigate('/audit') : undefined}
                className="rounded-lg border bg-card p-4 text-left transition-all enabled:hover:border-primary/50 enabled:hover:shadow-sm disabled:cursor-default"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-md bg-primary/10 p-2 text-primary"><History className="h-5 w-5" /></div>
                  <div>
                    <h3 className="font-medium">Audit logs</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {hasPermission('audit.view')
                        ? 'Review the audit log available to your account.'
                        : 'This dashboard shortcut is assigned, but audit.view is needed to open audit logs.'}
                    </p>
                  </div>
                </div>
              </button>
            )}
          </div>
        </section>
      )}

      {(showOwnCommission || canManagementCommission) && (
        <section className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Commission overview</h2>
              {canManagementCommission && <p className="text-sm text-muted-foreground">Company commission approvals and payments</p>}
            </div>
            {canManagementCommission && (
              <DateRangeFilter
                dateFrom={commissionRange.dateFrom}
                dateTo={commissionRange.dateTo}
                includeClear={false}
                compact
                onChange={setCommissionRange}
              />
            )}
          </div>
          {commissionStatus && <div className={`rounded-lg border px-3 py-2 text-sm ${commissionStatus.status === 'active' ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'}`}><strong>Commission is {commissionStatus.status === 'active' ? 'active' : 'paused'}.</strong> {commissionStatus.status === 'active' ? 'Earnings are added after payment, completion and Speedaf remittance where applicable.' : 'New earnings are paused. History and payments remain available.'}</div>}
          {showOwnCommission && canOwnCommissionSummary && commissionSummary && (
            <>
              <h3 className="text-sm font-semibold">My commission — current month</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatsCard title="Recorded" value={formatMoney(commissionSummary.grossEarned)} icon={<Wallet className="h-5 w-5" />} onClick={() => openDrilldown('my_commission_recorded', 'My recorded commission sales')} />
                <StatsCard title="Reversals" value={formatMoney(commissionSummary.reversals)} icon={<TrendingDown className="h-5 w-5" />} onClick={() => openDrilldown('my_commission_reversals', 'My commission reversals')} />
                <StatsCard title="Balance" value={formatMoney(commissionSummary.netCommission)} icon={<TrendingUp className="h-5 w-5" />} onClick={() => openDrilldown('my_commission_balance', 'My commission balance breakdown')} />
                <StatsCard title="Approved" value={formatMoney(commissionSummary.approvedPayable ?? commissionSummary.payableAmount ?? 0)} icon={<CheckCircle2 className="h-5 w-5" />} onClick={() => openDrilldown('my_commission_approved', 'My approved commission')} />
                <StatsCard title="Paid" value={formatMoney(commissionSummary.paidAmount || 0)} icon={<CreditCard className="h-5 w-5" />} onClick={() => openDrilldown('my_commission_paid', 'My paid commission')} />
                <StatsCard title={commissionSummary.recoveryDue > 0 ? 'Recovery' : 'Outstanding'} value={formatMoney(commissionSummary.recoveryDue > 0 ? commissionSummary.recoveryDue : Math.max(0, Number(commissionSummary.outstandingAmount || 0)))} icon={<CreditCard className="h-5 w-5" />} onClick={() => openDrilldown(commissionSummary.recoveryDue > 0 ? 'my_commission_recovery' : 'my_commission_outstanding', commissionSummary.recoveryDue > 0 ? 'My commission recovery' : 'My outstanding commission')} />
              </div>
            </>
          )}
          {showOwnCommission && !canOwnCommissionSummary && <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">Open Commission centre for the detailed information available to your role.</div>}
          {canManagementCommission && managementCommission && (
            <>
              <div>
                <h3 className="text-sm font-semibold">Company commission</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDisplayDate(commissionRange.dateFrom)} to {formatDisplayDate(commissionRange.dateTo)} · {managementCommission.orderCount.toLocaleString()} order{managementCommission.orderCount === 1 ? '' : 's'} · {managementCommission.itemCount.toLocaleString()} eligible item{managementCommission.itemCount === 1 ? '' : 's'}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatsCard title="Recorded" subtitle="Commission earned in this period" value={formatMoney(managementCommission.totalEarned)} icon={<Wallet className="h-5 w-5" />} onClick={() => openManagementCommissionDrilldown('company_commission_recorded', 'Company recorded commission sales')} />
                <StatsCard title="Pending approval" subtitle="Recorded and awaiting approval" value={formatMoney(Math.max(0, managementCommission.pendingAmount || 0))} icon={<History className="h-5 w-5" />} onClick={() => openManagementCommissionDrilldown('company_commission_pending', 'Commission pending approval')} />
                <StatsCard title="Approved for payment" subtitle="Approved but not yet paid" value={formatMoney(managementCommission.approvedPayable ?? managementCommission.approvedUnpaid ?? 0)} icon={<CheckCircle2 className="h-5 w-5" />} onClick={() => openManagementCommissionDrilldown('company_commission_approved', 'Commission approved for payment')} />
                <StatsCard title="Paid" subtitle="Payments allocated to this period" value={formatMoney(managementCommission.totalPayments || 0)} icon={<CreditCard className="h-5 w-5" />} onClick={() => openManagementCommissionDrilldown('company_commission_paid', 'Company paid commission')} />
                <StatsCard title="Outstanding" subtitle="Pending and approved amounts still unpaid" value={formatMoney(Math.max(0, managementCommission.outstandingAmount || 0))} icon={<TrendingUp className="h-5 w-5" />} onClick={() => openManagementCommissionDrilldown('company_commission_outstanding', 'Company outstanding commission')} />
                <StatsCard title="Reversals" subtitle={managementCommission.recoveryDue > 0 ? `${formatMoney(managementCommission.recoveryDue)} recovery due` : 'Commission removed after a return or adjustment'} value={formatMoney(managementCommission.totalReversals)} icon={<TrendingDown className="h-5 w-5" />} onClick={() => openManagementCommissionDrilldown('company_commission_reversals', 'Company commission reversals')} />
                <StatsCard title="Sales agents" subtitle="Agents with commission activity" value={managementCommission.salespersonCount.toLocaleString()} icon={<Users className="h-5 w-5" />} onClick={() => openManagementCommissionDrilldown('company_commission_salespeople', 'Company commission by salesperson')} />
              </div>

              <div className="overflow-hidden rounded-lg border bg-card">
                <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                  <div>
                    <h3 className="font-semibold">Sales agent summary</h3>
                    <p className="text-xs text-muted-foreground">Commission activity for the selected commission period</p>
                  </div>
                  <button type="button" onClick={() => openManagementCommissionDrilldown('company_commission_salespeople', 'Company commission by salesperson')} className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline">View details <ChevronRight className="h-4 w-4" /></button>
                </div>
                {managementSalespeople.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No commission activity in this period.</div>
                ) : (
                  <>
                  <div className="space-y-3 p-3 md:hidden">
                    {managementSalespeople.map(salesperson => (
                      <article key={salesperson.salespersonId} className="rounded-lg border bg-card p-4">
                        <div className="min-w-0"><p className="font-semibold">{salesperson.fullName}</p><p className="truncate text-xs text-muted-foreground">{salesperson.email}</p></div>
                        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                          <MobileDetail label="Orders">{salesperson.orderCount.toLocaleString()}</MobileDetail>
                          <MobileDetail label="Eligible items">{salesperson.eligibleQuantity.toLocaleString()}</MobileDetail>
                          <MobileDetail label="Recorded">{formatMoney(salesperson.grossEarned)}</MobileDetail>
                          <MobileDetail label="Approved">{formatMoney(salesperson.approvedPayable)}</MobileDetail>
                          <MobileDetail label="Paid">{formatMoney(salesperson.paid)}</MobileDetail>
                          <MobileDetail label="Outstanding"><strong>{formatMoney(Math.max(0, salesperson.outstandingAmount))}</strong></MobileDetail>
                        </dl>
                      </article>
                    ))}
                  </div>
                  <div className="hidden overflow-x-auto md:block">
                    <table className="w-full min-w-[920px] text-sm">
                      <thead className="bg-muted/70">
                        <tr><th className="px-4 py-3 text-left">Sales agent</th><th className="px-4 py-3 text-right">Orders</th><th className="px-4 py-3 text-right">Eligible items</th><th className="px-4 py-3 text-right">Recorded</th><th className="px-4 py-3 text-right">Approved</th><th className="px-4 py-3 text-right">Paid</th><th className="px-4 py-3 text-right">Outstanding</th></tr>
                      </thead>
                      <tbody>{managementSalespeople.map(salesperson => (
                        <tr key={salesperson.salespersonId} className="border-t hover:bg-muted/30">
                          <td className="px-4 py-3 font-medium">{salesperson.fullName}<div className="text-xs font-normal text-muted-foreground">{salesperson.email}</div></td>
                          <td className="px-4 py-3 text-right">{salesperson.orderCount.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right">{salesperson.eligibleQuantity.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right">{formatMoney(salesperson.grossEarned)}</td>
                          <td className="px-4 py-3 text-right">{formatMoney(salesperson.approvedPayable)}</td>
                          <td className="px-4 py-3 text-right">{formatMoney(salesperson.paid)}</td>
                          <td className="px-4 py-3 text-right font-medium">{formatMoney(Math.max(0, salesperson.outstandingAmount))}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {!hasDashboardStats && !hasManagementTools && !hasOwnCommissionAccess && !canManagementCommission && (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
          No dashboard views have been assigned to your account.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {(canManagementSales || canManagementExpenses) && (
        <button type="button" onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'sales')) : undefined} disabled={!hasPermission('reports.view')} className="rounded-xl border bg-card p-6 text-left transition-all enabled:hover:border-primary/50 enabled:hover:shadow-sm disabled:cursor-default">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" />
            Selected-period performance
          </h2>
          {(stats?.periodSales || 0) === 0 && (stats?.periodExpenses || 0) === 0 ? (
            <div className="h-64 flex items-center justify-center text-muted-foreground bg-muted/30 rounded-lg">No data available</div>
          ) : (
            <div className="flex h-64 flex-col justify-center gap-6 rounded-lg bg-muted/20 p-5" aria-label="Sales and expenses chart">
              {[
                ...(canManagementSales ? [['Sales', stats?.periodSales || 0, 'bg-primary']] : []),
                ...(canManagementExpenses ? [['Expenses', stats?.periodExpenses || 0, 'bg-destructive']] : [])
              ].map(([label, value, color]) => (
                <div key={String(label)}>
                  <div className="mb-2 flex justify-between text-sm"><span>{label}</span><strong>{formatMoney(Number(value))}</strong></div>
                  <div className="h-5 overflow-hidden rounded bg-muted"><div className={`h-full ${color}`} style={{ width: `${Math.max(2, Number(value) / financialMax * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </button>)}
        {canManagementSales && (
        <button type="button" onClick={hasPermission('orders.view') ? () => navigate(`/orders?${datedQuery()}`) : undefined} disabled={!hasPermission('orders.view')} className="rounded-xl border bg-card p-6 text-left transition-all enabled:hover:border-primary/50 enabled:hover:shadow-sm disabled:cursor-default">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <Package className="h-5 w-5 text-primary" />
            Order Status Distribution
          </h2>
          {(stats?.periodOrders || 0) === 0 ? (
            <div className="h-64 flex items-center justify-center text-muted-foreground bg-muted/30 rounded-lg">No data available</div>
          ) : (
            <div className="flex h-64 flex-col justify-center gap-6 rounded-lg bg-muted/20 p-5" aria-label="Order activity chart">
              {[['Selected period', stats?.periodOrders || 0, 'bg-primary'], ['All active orders', stats?.totalOrders || 0, 'bg-green-600']].map(([label, value, color]) => (
                <div key={String(label)}>
                  <div className="mb-2 flex justify-between text-sm"><span>{label}</span><strong>{Number(value).toLocaleString()}</strong></div>
                  <div className="h-5 overflow-hidden rounded bg-muted"><div className={`h-full ${color}`} style={{ width: `${Math.max(2, Number(value) / orderMax * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </button>)}
      </div>
      {drilldownSelection && (
        <DashboardDrilldown
          selection={drilldownSelection}
          data={drilldownData}
          isLoading={drilldownLoading}
          error={drilldownError}
          canOpenOrders={hasPermission('orders.view')}
          canOpenCommission={hasOwnCommissionAccess || canManagementCommission}
          filterDateFrom={drilldownDateFrom}
          filterDateTo={drilldownDateTo}
          onFilterChange={range => { setDrilldownDateFrom(range.dateFrom); setDrilldownDateTo(range.dateTo) }}
          onClose={() => setDrilldownSelection(null)}
          onOpenOrder={orderId => { setDrilldownSelection(null); navigate(`/orders?order_id=${encodeURIComponent(orderId)}`) }}
          onOpenOrders={() => { setDrilldownSelection(null); navigate(`/orders?${datedQuery(drilldownDateFrom, drilldownDateTo)}`) }}
          onOpenCommission={() => { setDrilldownSelection(null); navigate('/commissions') }}
        />
      )}
    </div>
  )
}
