import React from 'react'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useAuthStore } from '../../stores/authStore'
import { formatMoney } from '../../lib/format'
import {
  Wallet, TrendingUp, TrendingDown, CreditCard, Settings2, History,
  CheckCircle2, XCircle, Users, BarChart3, Target
} from 'lucide-react'

type Tab = 'overview' | 'transactions' | 'potential' | 'management' | 'settings'

export function Commissions() {
  const [tab, setTab] = useState<Tab>('overview')
  const { hasPermission } = useAuthStore()
  const queryClient = useQueryClient()

  const isAdmin = hasPermission('commission.manage')
  const canView = hasPermission('commission.own_view') || hasPermission('commission.view')
  const canManage = hasPermission('commission.manage')
  const canApprove = hasPermission('commission.approve')
  const canPay = hasPermission('commission.pay')

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['commission-own-summary'],
    queryFn: async () => (await axios.get('/api/commissions/own/summary')).data,
    enabled: hasPermission('commission.own_view')
  })

  const { data: daily } = useQuery({
    queryKey: ['commission-own-daily'],
    queryFn: async () => (await axios.get('/api/commissions/own/daily')).data,
    enabled: hasPermission('commission.own_daily')
  })

  const { data: potential } = useQuery({
    queryKey: ['commission-own-potential'],
    queryFn: async () => (await axios.get('/api/commissions/own/potential')).data,
    enabled: hasPermission('commission.own_potential')
  })

  const { data: transactions, isLoading: txLoading } = useQuery({
    queryKey: ['commission-own-transactions'],
    queryFn: async () => (await axios.get('/api/commissions/own/transactions')).data,
    enabled: hasPermission('commission.own_transactions')
  })

  const { data: programme } = useQuery({
    queryKey: ['commission-programme'],
    queryFn: async () => (await axios.get('/api/commissions/programme')).data,
    enabled: canManage
  })

  const { data: rates } = useQuery({
    queryKey: ['commission-rates'],
    queryFn: async () => (await axios.get('/api/commissions/rates')).data,
    enabled: canManage
  })

  const { data: eligibility } = useQuery({
    queryKey: ['commission-eligibility'],
    queryFn: async () => (await axios.get('/api/commissions/eligibility')).data,
    enabled: canManage
  })

  const { data: managementSummary } = useQuery({
    queryKey: ['management-commission'],
    queryFn: async () => (await axios.get('/api/commissions/summary')).data,
    enabled: hasPermission('commission.view')
  })

  const { data: managementBySalesperson } = useQuery({
    queryKey: ['commission-by-salesperson'],
    queryFn: async () => (await axios.get('/api/commissions/by-salesperson')).data,
    enabled: hasPermission('commission.view')
  })

  const approveMutation = useMutation({
    mutationFn: async (id: string) => (await axios.post(`/api/commissions/transactions/${id}/approve`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['commission-own-transactions'] })
  })

  const payMutation = useMutation({
    mutationFn: async (id: string) => (await axios.post(`/api/commissions/transactions/${id}/pay`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['commission-own-transactions'] })
  })

  if (!canView) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        You do not have permission to view commission information.
      </div>
    )
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode; show: boolean }[] = [
    { key: 'overview', label: 'Overview', icon: <BarChart3 className="h-4 w-4" />, show: hasPermission('commission.own_view') || hasPermission('commission.view') },
    { key: 'transactions', label: 'Transactions', icon: <History className="h-4 w-4" />, show: hasPermission('commission.own_transactions') },
    { key: 'potential', label: 'Potential', icon: <Target className="h-4 w-4" />, show: hasPermission('commission.own_potential') },
    { key: 'management', label: 'Management', icon: <Users className="h-4 w-4" />, show: hasPermission('commission.view') && isAdmin },
    { key: 'settings', label: 'Settings', icon: <Settings2 className="h-4 w-4" />, show: canManage }
  ]

  const visibleTabs = tabs.filter(t => t.show)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Commission</h1>
        <p className="text-muted-foreground">Sales commission programme and history</p>
      </div>

      {visibleTabs.length > 1 && (
        <div className="flex gap-1 border-b">
          {visibleTabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.key
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === 'overview' && (
        <div className="space-y-6">
          {hasPermission('commission.own_view') && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">My Commission</h2>
              {summaryLoading ? (
                <div className="text-muted-foreground">Loading...</div>
              ) : summary ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatCard title="Gross Earned" value={formatMoney(summary.grossEarned)} icon={<Wallet className="h-5 w-5" />} />
                  <StatCard title="Reversals" value={formatMoney(summary.reversals)} icon={<TrendingDown className="h-5 w-5" />} />
                  <StatCard title="Net Commission" value={formatMoney(summary.netCommission)} icon={<TrendingUp className="h-5 w-5" />} />
                  <StatCard title="Outstanding" value={formatMoney(summary.outstandingAmount)} icon={<CreditCard className="h-5 w-5" />} />
                </div>
              ) : null}

              {daily?.daily && daily.daily.length > 0 && (
                <div className="rounded-lg border bg-card overflow-hidden">
                  <div className="px-4 py-3 border-b">
                    <h3 className="font-semibold">Daily Breakdown</h3>
                    <p className="text-xs text-muted-foreground">Current month commission by day</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted">
                        <tr>
                          <th className="text-left px-4 py-3">Date</th>
                          <th className="text-right px-4 py-3">Eligible Items</th>
                          <th className="text-right px-4 py-3">Gross</th>
                          <th className="text-right px-4 py-3">Reversals</th>
                          <th className="text-right px-4 py-3">Net</th>
                        </tr>
                      </thead>
                      <tbody>
                        {daily.daily.map((row: any, idx: number) => (
                          <tr key={idx} className="border-t hover:bg-muted/40">
                            <td className="px-4 py-3">{row.date}</td>
                            <td className="px-4 py-3 text-right">{row.eligibleItems}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(row.grossCommission)}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(row.reversals)}</td>
                            <td className="px-4 py-3 text-right font-medium">{formatMoney(row.netCommission)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {hasPermission('commission.view') && isAdmin && managementSummary && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Programme Overview</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard title="Total Earned" value={formatMoney(managementSummary.totalEarned)} icon={<Wallet className="h-5 w-5" />} />
                <StatCard title="Reversals" value={formatMoney(managementSummary.totalReversals)} icon={<TrendingDown className="h-5 w-5" />} />
                <StatCard title="Net Commission" value={formatMoney(managementSummary.netCommission)} icon={<TrendingUp className="h-5 w-5" />} />
                <StatCard title="Salespeople" value={String(managementSummary.salespersonCount || 0)} icon={<Users className="h-5 w-5" />} />
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'transactions' && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h3 className="font-semibold">My Commission Transactions</h3>
          </div>
          {txLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading...</div>
          ) : transactions?.data?.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No transactions yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-left px-4 py-3">Order</th>
                    <th className="text-left px-4 py-3">Product</th>
                    <th className="text-right px-4 py-3">Qty</th>
                    <th className="text-right px-4 py-3">Rate</th>
                    <th className="text-right px-4 py-3">Amount</th>
                    <th className="text-left px-4 py-3">Type</th>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-left px-4 py-3">Date</th>
                    {(canApprove || canPay) && <th className="text-center px-4 py-3">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {transactions?.data?.map((tx: any) => (
                    <tr key={tx.id} className="border-t hover:bg-muted/40">
                      <td className="px-4 py-3">{tx.order_number}</td>
                      <td className="px-4 py-3">{tx.product_name}</td>
                      <td className="px-4 py-3 text-right">{tx.eligible_quantity}</td>
                      <td className="px-4 py-3 text-right">{formatMoney(tx.rate_per_item)}</td>
                      <td className="px-4 py-3 text-right font-medium">{formatMoney(tx.amount)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded-full border px-2 py-1 text-xs ${
                          tx.transaction_type === 'earned' ? 'border-emerald-200 text-emerald-700' :
                          tx.transaction_type === 'reversal' ? 'border-red-200 text-red-700' :
                          'border-amber-200 text-amber-700'
                        }`}>
                          {tx.transaction_type}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs ${
                          tx.transaction_status === 'paid' ? 'text-emerald-600' :
                          tx.transaction_status === 'approved' ? 'text-blue-600' :
                          tx.transaction_status === 'pending' ? 'text-amber-600' :
                          'text-red-600'
                        }`}>
                          {tx.transaction_status === 'paid' && <CheckCircle2 className="h-3 w-3" />}
                          {tx.transaction_status === 'approved' && <CheckCircle2 className="h-3 w-3" />}
                          {tx.transaction_status === 'pending' && <Clock className="h-3 w-3" />}
                          {tx.transaction_status === 'reversed' && <XCircle className="h-3 w-3" />}
                          {tx.transaction_status}
                        </span>
                      </td>
                      <td className="px-4 py-3">{new Date(tx.qualification_date).toLocaleDateString()}</td>
                      {(canApprove || canPay) && (
                        <td className="px-4 py-3 text-center">
                          <div className="flex items-center justify-center gap-2">
                            {canApprove && tx.transaction_status === 'pending' && (
                              <button onClick={() => approveMutation.mutate(tx.id)} className="text-xs text-blue-600 hover:underline">
                                Approve
                              </button>
                            )}
                            {canPay && tx.transaction_status === 'approved' && (
                              <button onClick={() => payMutation.mutate(tx.id)} className="text-xs text-emerald-600 hover:underline">
                                Pay
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {transactions?.pagination && transactions.pagination.totalPages > 1 && (
            <div className="px-4 py-3 border-t">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>Page {transactions.pagination.page} of {transactions.pagination.totalPages}</span>
                <div className="flex gap-2">
                  <button disabled={transactions.pagination.page <= 1} className="px-3 py-1 border rounded disabled:opacity-50">Previous</button>
                  <button disabled={transactions.pagination.page >= transactions.pagination.totalPages} className="px-3 py-1 border rounded disabled:opacity-50">Next</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'potential' && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h3 className="font-semibold">Potential Commission</h3>
            <p className="text-xs text-muted-foreground">Orders that may become commission-eligible once final conditions are met</p>
          </div>
          {potential?.potential?.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No potential commission at this time</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-left px-4 py-3">Order</th>
                    <th className="text-left px-4 py-3">Product</th>
                    <th className="text-right px-4 py-3">Qty</th>
                    <th className="text-left px-4 py-3">Category</th>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-left px-4 py-3">Delivery</th>
                  </tr>
                </thead>
                <tbody>
                  {potential?.potential?.map((row: any) => (
                    <tr key={row.orderItemId} className="border-t hover:bg-muted/40">
                      <td className="px-4 py-3">{row.orderNumber}</td>
                      <td className="px-4 py-3">{row.productName}</td>
                      <td className="px-4 py-3 text-right">{row.quantity}</td>
                      <td className="px-4 py-3">{row.categoryName || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded-full border px-2 py-1 text-xs ${
                          row.orderStatus === 'collected_paid' ? 'border-emerald-200 text-emerald-700' :
                          row.orderStatus === 'delivered' ? 'border-blue-200 text-blue-700' :
                          'border-amber-200 text-amber-700'
                        }`}>
                          {row.orderStatus}
                        </span>
                      </td>
                      <td className="px-4 py-3">{row.deliveryType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'management' && isAdmin && (
        <div className="space-y-6">
          {managementBySalesperson?.salespeople?.length === 0 ? (
            <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">No commission data for selected period</div>
          ) : (
            <div className="rounded-lg border bg-card overflow-hidden">
              <div className="px-4 py-3 border-b">
                <h3 className="font-semibold">Commission by Salesperson</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left px-4 py-3">Salesperson</th>
                      <th className="text-right px-4 py-3">Gross Earned</th>
                      <th className="text-right px-4 py-3">Reversals</th>
                      <th className="text-right px-4 py-3">Net</th>
                      <th className="text-right px-4 py-3">Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {managementBySalesperson?.salespeople?.map((sp: any) => (
                      <tr key={sp.salespersonId} className="border-t hover:bg-muted/40">
                        <td className="px-4 py-3 font-medium">{sp.fullName}</td>
                        <td className="px-4 py-3 text-right">{formatMoney(sp.grossEarned)}</td>
                        <td className="px-4 py-3 text-right">{formatMoney(sp.reversals)}</td>
                        <td className="px-4 py-3 text-right font-medium">{formatMoney(sp.netCommission)}</td>
                        <td className="px-4 py-3 text-right">{formatMoney(sp.paid)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'settings' && canManage && (
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6">
            <h3 className="font-semibold mb-4">Programme Status</h3>
            {programme?.active ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-3 w-3 rounded-full ${programme.active.status === 'active' ? 'bg-emerald-500' : programme.active.status === 'suspended' ? 'bg-amber-500' : 'bg-red-500'}`} />
                  <span className="font-medium capitalize">{programme.active.status}</span>
                </div>
                <p className="text-sm text-muted-foreground">Effective from: {new Date(programme.active.effective_from).toLocaleString()}</p>
                {programme.active.reason && <p className="text-sm text-muted-foreground">Reason: {programme.active.reason}</p>}
              </div>
            ) : (
              <p className="text-muted-foreground">No active commission programme</p>
            )}
          </div>

          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b">
              <h3 className="font-semibold">Rates</h3>
            </div>
            {rates?.rates?.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">No rates configured</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left px-4 py-3">Scope</th>
                      <th className="text-right px-4 py-3">Rate</th>
                      <th className="text-left px-4 py-3">Effective From</th>
                      <th className="text-left px-4 py-3">Effective To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rates?.rates?.map((rate: any) => (
                      <tr key={rate.id} className="border-t hover:bg-muted/40">
                        <td className="px-4 py-3 capitalize">{rate.scope_type}{rate.scope_name ? `: ${rate.scope_name}` : ''}</td>
                        <td className="px-4 py-3 text-right">{formatMoney(rate.rate_per_item)}</td>
                        <td className="px-4 py-3">{new Date(rate.effective_from).toLocaleDateString()}</td>
                        <td className="px-4 py-3">{rate.effective_to ? new Date(rate.effective_to).toLocaleDateString() : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b">
              <h3 className="font-semibold">Eligibility</h3>
            </div>
            {eligibility?.eligibility?.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">No eligibility rules configured</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left px-4 py-3">Scope</th>
                      <th className="text-left px-4 py-3">Name</th>
                      <th className="text-center px-4 py-3">Eligible</th>
                      <th className="text-left px-4 py-3">Effective From</th>
                      <th className="text-left px-4 py-3">Effective To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {eligibility?.eligibility?.map((item: any) => (
                      <tr key={item.id} className="border-t hover:bg-muted/40">
                        <td className="px-4 py-3 capitalize">{item.scope_type}</td>
                        <td className="px-4 py-3">{item.scope_name}</td>
                        <td className="px-4 py-3 text-center">
                          {item.is_eligible ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600 mx-auto" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-600 mx-auto" />
                          )}
                        </td>
                        <td className="px-4 py-3">{new Date(item.effective_from).toLocaleDateString()}</td>
                        <td className="px-4 py-3">{item.effective_to ? new Date(item.effective_to).toLocaleDateString() : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
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

function Clock({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m-4-8a9 9 0 110 18 9 9 0 010-18z" />
    </svg>
  )
}
