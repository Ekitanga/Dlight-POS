import { useMemo } from 'react'
import React from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from 'recharts'
import { TrendingUp, Package, AlertTriangle, ClipboardList } from 'lucide-react'

interface ProductRow {
  category: string
  product: string
  sku: string
  units_sold: number
  orders: number
  revenue: number
  gross_profit: number
  available_stock: number
  average_daily_units: number
  suggested_stock_14_days: number
  suggested_stock_30_days: number
  reorder_gap: number
  days_of_stock_remaining: number | null
  recommendation: string
}

interface Props {
  data: ProductRow[]
}

export function ProductDemandCharts({ data }: Props) {
  const productsWithDemand = data.filter(row => row.units_sold > 0).length
  const stockNow = data.filter(row => row.recommendation === 'Stock now').length
  const increaseStock = data.filter(row => row.recommendation === 'Increase stock').length
  const totalReorderGap = data.reduce((sum, row) => sum + row.reorder_gap, 0)

  const topProducts = useMemo(() => data.slice(0, 15), [data])
  const restockCandidates = useMemo(() => data.filter(row => row.reorder_gap > 0 || row.recommendation === 'Stock now').slice(0, 15), [data])

  const accentForRecommendation = (rec: string) => {
    if (rec === 'Stock now') return 'text-red-600 bg-red-50 border-red-200'
    if (rec === 'Increase stock') return 'text-amber-600 bg-amber-50 border-amber-200'
    if (rec === 'Monitor demand') return 'text-blue-600 bg-blue-50 border-blue-200'
    return 'text-slate-600 bg-slate-50 border-slate-200'
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric title="Products With Demand" value={productsWithDemand.toLocaleString()} icon={<TrendingUp className="h-5 w-5" />} />
        <Metric title="Stock Now Urgent" value={stockNow.toLocaleString()} icon={<AlertTriangle className="h-5 w-5" />} />
        <Metric title="Increase Stock" value={increaseStock.toLocaleString()} icon={<Package className="h-5 w-5" />} />
        <Metric title="Total Reorder Gap" value={totalReorderGap.toLocaleString()} icon={<ClipboardList className="h-5 w-5" />} />
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-4 font-semibold">Top Sellers By Units Sold</h3>
        <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topProducts} layout="horizontal" margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis type="number" className="text-xs" tick={{ fontSize: 12 }} />
              <YAxis dataKey="product" type="category" width={140} className="text-xs" tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value: any, name: any) => {
                  if (name === 'units_sold') return [Number(value).toLocaleString(), 'Units Sold']
                  if (name === 'revenue') return [formatMoney(value), 'Revenue']
                  return [value, name]
                }}
                labelFormatter={(label) => {
                  const row = topProducts.find(r => r.product === label)
                  return row ? `${row.product} (${row.sku})` : label
                }}
                contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0' }}
              />
              <Legend />
              <Bar dataKey="units_sold" fill="#c0a16b" radius={[0, 4, 4, 0]} name="Units Sold" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {restockCandidates.length > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-2 font-semibold">Shop Stock Gap: Have vs Need (14-Day)</h3>
          <p className="text-xs text-muted-foreground mb-4">Products with demand that are under-stocked for the shop floor. Use this to guide purchase orders.</p>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={restockCandidates} margin={{ top: 5, right: 20, left: 0, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="product" className="text-xs" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={60} interval={0} />
                <YAxis className="text-xs" tick={{ fontSize: 12 }} />
                <Tooltip
                  formatter={(value: any) => [Number(value).toLocaleString(), '']}
                  labelFormatter={(label) => {
                    const row = restockCandidates.find(r => r.product === label)
                    return row ? `${row.product} (${row.sku})` : label
                  }}
                  contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0' }}
                />
                <Legend />
                <Bar dataKey="available_stock" fill="#94a3b8" radius={[3, 3, 0, 0]} name="Have Now" />
                <Bar dataKey="suggested_stock_14_days" fill="#c0a16b" radius={[3, 3, 0, 0]} name="Need (14d)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b">
          <h3 className="font-semibold">Product Detail</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-3">Product</th>
                <th className="text-left px-4 py-3">SKU</th>
                <th className="text-right px-4 py-3">Sold</th>
                <th className="text-right px-4 py-3">Revenue</th>
                <th className="text-right px-4 py-3">Stock Now</th>
                <th className="text-right px-4 py-3">Avg/Day</th>
                <th className="text-right px-4 py-3">Need (14d)</th>
                <th className="text-right px-4 py-3">Gap</th>
                <th className="text-center px-4 py-3">Days Left</th>
                <th className="text-center px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, idx) => (
                <tr key={idx} className="border-t align-top hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium">{row.product}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.sku}</td>
                  <td className="px-4 py-3 text-right">{row.units_sold.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{formatMoney(row.revenue)}</td>
                  <td className="px-4 py-3 text-right">{row.available_stock.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{row.average_daily_units.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{row.suggested_stock_14_days.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={row.reorder_gap > 0 ? 'text-red-600 font-semibold' : 'text-emerald-600'}>
                      {row.reorder_gap.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.days_of_stock_remaining === null ? (
                      <span className="text-muted-foreground">No sales</span>
                    ) : (
                      <span className={row.days_of_stock_remaining <= 7 ? 'text-red-600 font-semibold' : row.days_of_stock_remaining <= 14 ? 'text-amber-600' : ''}>
                        {row.days_of_stock_remaining}d
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block rounded-full border px-2 py-1 text-xs font-medium ${accentForRecommendation(row.recommendation)}`}>
                      {row.recommendation}
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

function Metric({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
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
