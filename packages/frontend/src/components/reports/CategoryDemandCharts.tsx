import { useMemo } from 'react'
import React from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
  CartesianGrid, Legend
} from 'recharts'
import { TrendingUp, Package, DollarSign, PiggyBank } from 'lucide-react'

const COLORS = ['#c0a16b', '#2563eb', '#16a34a', '#dc2626', '#9333ea', '#0891b2', '#d97706', '#4b5563']

interface CategoryRow {
  category: string
  products_sold: number
  units_sold: number
  orders: number
  revenue: number
  gross_profit: number
  average_margin_percent: number
  top_products: string
  stocking_signal: string
}

interface Props {
  data: CategoryRow[]
}

export function CategoryDemandCharts({ data }: Props) {
  const totalCategories = data.length
  const totalUnits = data.reduce((sum, row) => sum + row.units_sold, 0)
  const totalRevenue = data.reduce((sum, row) => sum + row.revenue, 0)
  const avgMargin = totalRevenue > 0 ? Math.round(data.reduce((sum, row) => sum + row.gross_profit, 0) / totalRevenue * 100) : 0

  const chartData = useMemo(() => data.slice(0, 12), [data])
  const pieData = useMemo(() => data.slice(0, 8), [data])

  const accentForSignal = (signal: string) => {
    if (signal.includes('Prioritise')) return 'text-emerald-600 bg-emerald-50 border-emerald-200'
    if (signal.includes('winners')) return 'text-blue-600 bg-blue-50 border-blue-200'
    if (signal.includes('Monitor')) return 'text-amber-600 bg-amber-50 border-amber-200'
    return 'text-slate-600 bg-slate-50 border-slate-200'
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric title="Categories" value={totalCategories} icon={<Package className="h-5 w-5" />} />
        <Metric title="Units Sold" value={totalUnits.toLocaleString()} icon={<TrendingUp className="h-5 w-5" />} />
        <Metric title="Revenue" value={formatMoney(totalRevenue)} icon={<DollarSign className="h-5 w-5" />} />
        <Metric title="Avg Margin" value={`${avgMargin}%`} icon={<PiggyBank className="h-5 w-5" />} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-lg border bg-card p-4">
          <h3 className="mb-4 font-semibold">Units Sold By Category</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="horizontal" margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis type="number" className="text-xs" tick={{ fontSize: 12 }} />
                <YAxis dataKey="category" type="category" width={120} className="text-xs" tick={{ fontSize: 12 }} />
                <Tooltip
                  formatter={(value: any) => [Number(value).toLocaleString(), 'Units']}
                  contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0' }}
                />
                <Bar dataKey="units_sold" fill="#c0a16b" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-4 font-semibold">Revenue Mix</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={2}
                  dataKey="revenue"
                  nameKey="category"
                >
                  {pieData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: any) => formatMoney(value)} contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0' }} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b">
          <h3 className="font-semibold">Category Detail</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-3">Category</th>
                <th className="text-right px-4 py-3">Units</th>
                <th className="text-right px-4 py-3">Orders</th>
                <th className="text-right px-4 py-3">Revenue</th>
                <th className="text-right px-4 py-3">Profit</th>
                <th className="text-right px-4 py-3">Margin</th>
                <th className="text-left px-4 py-3">Top Products</th>
                <th className="text-center px-4 py-3">Signal</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, idx) => (
                <tr key={idx} className="border-t align-top hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium">{row.category}</td>
                  <td className="px-4 py-3 text-right">{row.units_sold.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{row.orders.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{formatMoney(row.revenue)}</td>
                  <td className="px-4 py-3 text-right">{formatMoney(row.gross_profit)}</td>
                  <td className="px-4 py-3 text-right">{row.average_margin_percent}%</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground max-w-xs truncate" title={row.top_products}>{row.top_products}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block rounded-full border px-2 py-1 text-xs font-medium ${accentForSignal(row.stocking_signal)}`}>
                      {row.stocking_signal}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Metric({ title, value, icon }: { title: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase text-muted-foreground">{title}</div>
        <div className="rounded-lg bg-primary/10 p-2 text-primary">{icon}</div>
      </div>
      <div className="mt-2 text-xl font-bold">{value}</div>
    </div>
  )
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', minimumFractionDigits: 0 }).format(value || 0)
}
