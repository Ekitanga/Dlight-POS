import React from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/authStore'
import { DateRangeFilter, presetDateRange, todayDate } from '../../components/DateRangeFilter'
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
  BarChart3
} from 'lucide-react'

interface Stats {
  todaySales: number
  weekSales: number
  monthSales: number
  periodSales: number
  periodOrders: number
  periodDeliveryProfit: number
  periodExpenses: number
  todayExpenses: number
  todayGrossAfterDelivery: number
  todayOperatingProfit: number
  monthToDateExpenses: number
  monthToDateNetProfit: number
  totalOrders: number
  outstandingCOD: number
  supplierPayables: number
  riderPayables: number
  lowStockCount: number
  grossProfit: number
  netProfit: number
}

interface StatsCardProps {
  title: string
  subtitle?: string
  value: string | number
  icon: React.ReactNode
  trend?: { value: string; positive: boolean }
  urgent?: boolean
  onClick?: () => void
}

function StatsCard({ title, subtitle, value, icon, trend, urgent, onClick }: StatsCardProps) {
  const content = (
    <>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-xs text-muted-foreground sm:text-sm">{title}</p>
          {subtitle && <p className="mt-1 hidden text-xs text-muted-foreground sm:block">{subtitle}</p>}
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

export function Dashboard() {
  const navigate = useNavigate()
  const { hasPermission } = useAuthStore()
  const today = todayDate()
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(today)

  const { data: stats, isLoading, error } = useQuery<Stats>({
    queryKey: ['dashboard-stats', dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      const response = await axios.get(`/api/dashboard/stats?${params.toString()}`)
      return response.data
    }
  })
  const financialMax = Math.max(stats?.periodSales || 0, stats?.periodExpenses || 0, 1)
  const orderMax = Math.max(stats?.totalOrders || 0, stats?.periodOrders || 0, 1)
  const datedQuery = (from = dateFrom, to = dateTo) => new URLSearchParams({ date_from: from, date_to: to }).toString()
  const reportUrl = (department: string, report: string, from = dateFrom, to = dateTo) =>
    `/reports?department=${department}&report=${report}&${datedQuery(from, to)}`
  const weekFrom = presetDateRange('7days').dateFrom

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-muted rounded w-48 animate-pulse" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
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
          <p className="text-muted-foreground mt-1">Overview of your business performance</p>
        </div>
        <DateRangeFilter
          dateFrom={dateFrom}
          dateTo={dateTo}
          includeClear={false}
          compact
          onChange={range => { setDateFrom(range.dateFrom); setDateTo(range.dateTo) }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatsCard
          title="Today's Operating Profit"
          subtitle="Today's sales profit after delivery costs and recognized expenses"
          value={formatMoney(stats?.todayOperatingProfit)}
          icon={<TrendingUp className="h-6 w-6" />}
          urgent={(stats?.todayOperatingProfit || 0) < 0}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'profit', today, today)) : undefined}
        />
        <StatsCard
          title="Month-to-Date Net Profit"
          subtitle="Profit accrued this month after recurring and one-off expenses"
          value={formatMoney(stats?.monthToDateNetProfit)}
          icon={<DollarSign className="h-6 w-6" />}
          urgent={(stats?.monthToDateNetProfit || 0) < 0}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'profit', `${today.slice(0, 8)}01`, today)) : undefined}
        />
        <StatsCard
          title="Period Sales"
          value={formatMoney(stats?.periodSales)}
          icon={<DollarSign className="h-6 w-6" />}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'sales')) : undefined}
        />
        <StatsCard
          title="Period Orders"
          value={stats?.periodOrders || 0}
          icon={<Package className="h-6 w-6" />}
          onClick={hasPermission('orders.view') ? () => navigate(`/orders?${datedQuery()}`) : undefined}
        />
        <StatsCard
          title="Recognized Expenses"
          subtitle="Daily, monthly prorated, and one-off expenses for selected period"
          value={formatMoney(stats?.periodExpenses)}
          icon={<CreditCard className="h-6 w-6" />}
          onClick={hasPermission('expenses.view') ? () => navigate(`/expenses?${datedQuery()}`) : undefined}
        />
        <StatsCard
          title="Delivery Margin"
          subtitle="Customer delivery fee - actual delivery cost"
          value={formatMoney(stats?.periodDeliveryProfit)}
          icon={<Truck className="h-6 w-6" />}
          urgent={(stats?.periodDeliveryProfit || 0) < 0}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'sales')) : undefined}
        />
        <StatsCard
          title="Today's Sales"
          value={formatMoney(stats?.todaySales)}
          icon={<DollarSign className="h-6 w-6" />}
          trend={{ value: "+12% from yesterday", positive: true }}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'sales', today, today)) : undefined}
        />
        <StatsCard
          title="Weekly Sales"
          value={formatMoney(stats?.weekSales)}
          icon={<BarChart3 className="h-6 w-6" />}
          trend={{ value: "+12% from last week", positive: true }}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'sales', weekFrom, today)) : undefined}
        />
        <StatsCard
          title="Total Orders"
          value={stats?.totalOrders || 0}
          icon={<Package className="h-6 w-6" />}
          trend={{ value: "+8% from last month", positive: true }}
          onClick={hasPermission('orders.view') ? () => navigate('/orders') : undefined}
        />
        <StatsCard
          title="Outstanding COD"
          value={formatMoney(stats?.outstandingCOD)}
          icon={<CreditCard className="h-6 w-6" />}
          onClick={hasPermission('deliveries.view') ? () => navigate('/deliveries?view=cod') : undefined}
        />
        <StatsCard
          title="Supplier Payables"
          value={formatMoney(stats?.supplierPayables)}
          icon={<ShoppingBag className="h-6 w-6" />}
          onClick={hasPermission('suppliers.view') ? () => navigate('/suppliers?filter=outstanding') : undefined}
        />
        <StatsCard
          title="Rider Payments Due"
          value={formatMoney(stats?.riderPayables)}
          icon={<Truck className="h-6 w-6" />}
          onClick={hasPermission('riders.view') ? () => navigate('/riders?filter=outstanding') : undefined}
        />
        <StatsCard
          title="Low Stock Alerts"
          value={stats?.lowStockCount || 0}
          icon={<AlertCircle className="h-6 w-6" />}
          urgent={(stats?.lowStockCount || 0) > 0}
          onClick={hasPermission('inventory.view') ? () => navigate('/inventory?filter=low_stock') : undefined}
        />
        <StatsCard
          title="Period Net Profit"
          subtitle="Selected date range after recognized expenses"
          value={formatMoney(stats?.netProfit)}
          icon={<DollarSign className="h-6 w-6" />}
          trend={{ value: "+15% from last month", positive: true }}
          onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'profit')) : undefined}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <button type="button" onClick={hasPermission('reports.view') ? () => navigate(reportUrl('sales', 'sales')) : undefined} disabled={!hasPermission('reports.view')} className="rounded-xl border bg-card p-6 text-left transition-all enabled:hover:border-primary/50 enabled:hover:shadow-sm disabled:cursor-default">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" />
            Sales Trend (7 Days)
          </h2>
          {(stats?.periodSales || 0) === 0 && (stats?.periodExpenses || 0) === 0 ? (
            <div className="h-64 flex items-center justify-center text-muted-foreground bg-muted/30 rounded-lg">No data available</div>
          ) : (
            <div className="flex h-64 flex-col justify-center gap-6 rounded-lg bg-muted/20 p-5" aria-label="Sales and expenses chart">
              {[['Sales', stats?.periodSales || 0, 'bg-primary'], ['Expenses', stats?.periodExpenses || 0, 'bg-destructive']].map(([label, value, color]) => (
                <div key={String(label)}>
                  <div className="mb-2 flex justify-between text-sm"><span>{label}</span><strong>{formatMoney(Number(value))}</strong></div>
                  <div className="h-5 overflow-hidden rounded bg-muted"><div className={`h-full ${color}`} style={{ width: `${Math.max(2, Number(value) / financialMax * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </button>
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
        </button>
      </div>
    </div>
  )
}
