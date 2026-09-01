import React from 'react'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useAuthStore } from '../../stores/authStore'
import { formatMoney } from '../../lib/format'
import { invalidateCommissionData } from '../../lib/commissionCache'
import { DateRangeFilter, todayDate } from '../../components/DateRangeFilter'
import { MobileTableScroll } from '../../components/MobileTableScroll'
import {
  Wallet, TrendingUp, TrendingDown, CreditCard, Settings2, History,
  CheckCircle2, XCircle, Users, BarChart3, Target,
  Plus, ChevronDown, ChevronUp
} from 'lucide-react'

type Tab = 'overview' | 'transactions' | 'potential' | 'management' | 'settings'

const SCOPE_TYPES = [
  { value: 'global', label: 'Global (all products)' },
  { value: 'category', label: 'Category' },
  { value: 'product', label: 'Product' },
  { value: 'salesperson', label: 'Salesperson' },
]

function previousNairobiMonth(today: string): string {
  const [year, month] = today.slice(0, 7).split('-').map(Number)
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7)
}

function formatCommissionMonth(value: string | null | undefined): string {
  const raw = String(value || '')
  const [year, month] = raw.slice(0, 7).split('-').map(Number)
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return raw || '-'
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' })
    .format(new Date(Date.UTC(year, month - 1, 1, 12)))
}

function formatCommissionTimestamp(value: string | null | undefined): string {
  if (!value) return '-'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' })
}

function nairobiBusinessDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date)
}

function paymentConfirmationKey(): string {
  return globalThis.crypto?.randomUUID?.() || `commission-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function Commissions() {
  const [tab, setTab] = useState<Tab>('overview')
  const [showRateForm, setShowRateForm] = useState(false)
  const [editingRate, setEditingRate] = useState<any>(null)
  const [showRetroForm, setShowRetroForm] = useState(false)
  const [retroResult, setRetroResult] = useState<any>(null)
  const today = todayDate()
  const [periodCloseForm, setPeriodCloseForm] = useState({ period: previousNairobiMonth(today), reason: '' })
  const [managementFrom, setManagementFrom] = useState(`${today.slice(0, 8)}01`)
  const [managementTo, setManagementTo] = useState(today)
  const [retroDates, setRetroDates] = useState({ date_from: '', date_to: '' })
  const [retroReason, setRetroReason] = useState('')
  const [programmeForm, setProgrammeForm] = useState({ status: 'disabled', effective_from: today, reason: 'Initial commission policy configuration' })
  const [eligibilityForm, setEligibilityForm] = useState({ scope_type: 'category', scope_id: '', scope_name: '', is_eligible: true, effective_from: today, effective_to: '' })
  const [editingEligibility, setEditingEligibility] = useState<any>(null)
  const [adjustmentForm, setAdjustmentForm] = useState({ salesperson_id: '', amount: '', adjustment_type: 'manual_add', reason: '', period: today.slice(0, 7), order_id: '' })
  const [transactionPage, setTransactionPage] = useState(1)
  const [managementTransactionPage, setManagementTransactionPage] = useState(1)
  const [managementTransactionStatus, setManagementTransactionStatus] = useState('')
  const [managementSalespersonId, setManagementSalespersonId] = useState('')
  const [paymentEntry, setPaymentEntry] = useState({ transactionId: '', amount: '', payment_method: 'payroll', reference: '', notes: '', settled_at: today, idempotency_key: paymentConfirmationKey() })
  const [bulkPaymentEntry, setBulkPaymentEntry] = useState({ amount: '', payment_method: 'payroll', reference: '', notes: '', settled_at: today, idempotency_key: paymentConfirmationKey() })
  const [selectedApprovalIds, setSelectedApprovalIds] = useState<Set<string>>(new Set())
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<Set<string>>(new Set())
  const [rateForm, setRateForm] = useState({
    scope_type: 'global',
    scope_id: '',
    scope_name: '',
    rate_per_item: '',
    effective_from: today,
    effective_to: '',
  })
  const { hasPermission, user } = useAuthStore()
  const queryClient = useQueryClient()

  const isManager = hasPermission('commission.manage')
  const canView = hasPermission('commission.own_view') || hasPermission('commission.own_daily') || hasPermission('commission.own_monthly') || hasPermission('commission.own_history') || hasPermission('commission.own_transactions') || hasPermission('commission.own_potential') || hasPermission('commission.view') || isManager || hasPermission('commission.approve') || hasPermission('commission.pay') || hasPermission('commission.adjust') || hasPermission('commission.reconcile') || hasPermission('commission.close')
  const canManage = hasPermission('commission.manage')
  const canApprove = hasPermission('commission.approve')
  const canPay = hasPermission('commission.pay')
  const canAdjust = hasPermission('commission.adjust')
  const canReconcile = hasPermission('commission.reconcile')
  const canClose = hasPermission('commission.close')
  const isAdministrativeRole = ['admin', 'owner'].includes(String(user?.role || '').toLowerCase())
  const canManagementLedger = hasPermission('commission.view') || canApprove || canPay || canAdjust

  const { data: programmeStatus } = useQuery({
    queryKey: ['commission-status'],
    queryFn: async () => (await axios.get('/api/commissions/status')).data,
    enabled: canView
  })

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['commission-own-summary'],
    queryFn: async () => (await axios.get('/api/commissions/own/summary')).data,
    enabled: hasPermission('commission.own_view') || hasPermission('commission.own_monthly')
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
    queryKey: ['commission-own-transactions', transactionPage],
    queryFn: async () => (await axios.get(`/api/commissions/own/transactions?page=${transactionPage}&page_size=25`)).data,
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
    queryKey: ['management-commission', managementFrom, managementTo],
    queryFn: async () => (await axios.get(`/api/commissions/summary?date_from=${managementFrom}&date_to=${managementTo}`)).data,
    enabled: hasPermission('commission.view')
  })

  const { data: managementBySalesperson } = useQuery({
    queryKey: ['commission-by-salesperson', managementFrom, managementTo],
    queryFn: async () => (await axios.get(`/api/commissions/by-salesperson?date_from=${managementFrom}&date_to=${managementTo}`)).data,
    enabled: hasPermission('commission.view')
  })

  const { data: monthlyHistory } = useQuery({
    queryKey: ['commission-own-history'],
    queryFn: async () => (await axios.get('/api/commissions/own/history')).data,
    enabled: hasPermission('commission.own_history')
  })

  const { data: periodClosures, isLoading: periodClosuresLoading } = useQuery({
    queryKey: ['commission-period-closures'],
    queryFn: async () => (await axios.get('/api/commissions/periods?limit=24')).data,
    enabled: canClose
  })

  const { data: periodReadiness, isLoading: periodReadinessLoading } = useQuery({
    queryKey: ['commission-period-readiness', periodCloseForm.period],
    queryFn: async () => (await axios.get(`/api/commissions/periods/readiness?period=${periodCloseForm.period}`)).data,
    enabled: canClose && Boolean(periodCloseForm.period)
  })

  const { data: managementTransactions } = useQuery({
    queryKey: ['commission-management-transactions', managementFrom, managementTo, managementTransactionPage, managementTransactionStatus, managementSalespersonId],
    queryFn: async () => {
      const params = new URLSearchParams({ date_from: managementFrom, date_to: managementTo, page: String(managementTransactionPage), page_size: '25' })
      if (managementTransactionStatus) params.set('status', managementTransactionStatus)
      if (managementSalespersonId) params.set('salesperson_id', managementSalespersonId)
      return (await axios.get(`/api/commissions/transactions?${params.toString()}`)).data
    },
    enabled: canManagementLedger
  })

  const approveMutation = useMutation({
    mutationFn: async (id: string) => (await axios.post(`/api/commissions/transactions/${id}/approve`)).data,
    onSuccess: () => {
      void invalidateCommissionData(queryClient)
    }
  })

  const bulkApproveMutation = useMutation({
    mutationFn: async (transactionIds: string[]) =>
      (await axios.post('/api/commissions/bulk-approve', { transaction_ids: transactionIds })).data,
    onSuccess: () => {
      setSelectedApprovalIds(new Set())
      void invalidateCommissionData(queryClient)
    }
  })

  const payMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => (await axios.post(`/api/commissions/transactions/${id}/pay`, data)).data,
    onSuccess: () => {
      void invalidateCommissionData(queryClient)
    }
  })

  const bulkPayMutation = useMutation({
    mutationFn: async (data: { transaction_ids: string[]; payment_method: string; reference: string; notes: string; settled_at: string; idempotency_key: string }) =>
      (await axios.post('/api/commissions/bulk-pay', data)).data,
    onSuccess: () => {
      setSelectedTransactionIds(new Set())
      setBulkPaymentEntry({ amount: '', payment_method: 'payroll', reference: '', notes: '', settled_at: today, idempotency_key: paymentConfirmationKey() })
      void invalidateCommissionData(queryClient)
    }
  })

  const { data: commissionLookups } = useQuery({
    queryKey: ['commission-lookups'],
    queryFn: async () => (await axios.get('/api/commissions/lookups')).data,
    enabled: canManage || canManagementLedger
  })
  const categories = commissionLookups?.categories || []
  const products = commissionLookups?.products || []
  const salespeople = commissionLookups?.salespeople || []

  const createRateMutation = useMutation({
    mutationFn: async (data: any) => (await axios.post('/api/commissions/rates', data)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commission-rates'] })
      void invalidateCommissionData(queryClient)
      setShowRateForm(false)
      setEditingRate(null)
      setRateForm({ scope_type: 'global', scope_id: '', scope_name: '', rate_per_item: '', effective_from: today, effective_to: '' })
    }
  })

  const programmeMutation = useMutation({
    mutationFn: async (data: any) => (await axios.post('/api/commissions/programme', data)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commission-status'] })
      queryClient.invalidateQueries({ queryKey: ['commission-programme'] })
      queryClient.invalidateQueries({ queryKey: ['commission-rates'] })
      void invalidateCommissionData(queryClient)
      setProgrammeForm({ status: 'active', effective_from: today, reason: '' })
    }
  })

  const eligibilityMutation = useMutation({
    mutationFn: async (data: any) => {
      const { id, ...payload } = data
      return id
        ? (await axios.put(`/api/commissions/eligibility/${id}`, payload)).data
        : (await axios.post('/api/commissions/eligibility', payload)).data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commission-eligibility'] })
      void invalidateCommissionData(queryClient)
      setEligibilityForm({ scope_type: 'category', scope_id: '', scope_name: '', is_eligible: true, effective_from: today, effective_to: '' })
      setEditingEligibility(null)
    }
  })

  const endEligibilityMutation = useMutation({
    mutationFn: async (id: string) => axios.delete(`/api/commissions/eligibility/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commission-eligibility'] })
      void invalidateCommissionData(queryClient)
    }
  })

  const adjustmentMutation = useMutation({
    mutationFn: async (data: any) => (await axios.post('/api/commissions/adjust', data)).data,
    onSuccess: () => {
      void invalidateCommissionData(queryClient)
      setAdjustmentForm({ salesperson_id: '', amount: '', adjustment_type: 'manual_add', reason: '', period: today.slice(0, 7), order_id: '' })
    }
  })

  const updateRateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => (await axios.put(`/api/commissions/rates/${id}`, data)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commission-rates'] })
      void invalidateCommissionData(queryClient)
      setShowRateForm(false)
      setEditingRate(null)
      setRateForm({ scope_type: 'global', scope_id: '', scope_name: '', rate_per_item: '', effective_from: today, effective_to: '' })
    }
  })

  const deleteRateMutation = useMutation({
    mutationFn: async (id: string) => (await axios.delete(`/api/commissions/rates/${id}`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commission-rates'] })
      void invalidateCommissionData(queryClient)
    }
  })

  const retroMutation = useMutation({
    mutationFn: async ({ date_from, date_to, apply, reason }: { date_from: string; date_to: string; apply: boolean; reason?: string }) =>
      (await axios.post('/api/commissions/retroactive', { date_from, date_to, apply, reason })).data,
    onSuccess: (data: any) => {
      setRetroResult(data)
      queryClient.invalidateQueries({ queryKey: ['commission-rates'] })
      void invalidateCommissionData(queryClient)
    }
  })

  const ownRetroMutation = useMutation({
    mutationFn: async ({ date_from, date_to, apply, reason }: { date_from: string; date_to: string; apply: boolean; reason?: string }) =>
      (await axios.post('/api/commissions/own/retroactive', { date_from, date_to, apply, reason })).data,
    onSuccess: (data: any) => {
      setRetroResult(data)
      queryClient.invalidateQueries({ queryKey: ['commission-rates'] })
      void invalidateCommissionData(queryClient)
    }
  })

  const closePeriodMutation = useMutation({
    mutationFn: async (data: { period: string; reason: string }) =>
      (await axios.post('/api/commissions/periods/close', data)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commission-period-closures'] })
      queryClient.invalidateQueries({ queryKey: ['commission-period-readiness'] })
      void invalidateCommissionData(queryClient)
      setPeriodCloseForm(current => ({ ...current, reason: '' }))
    }
  })

  const revokeApprovalMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      (await axios.post(`/api/commissions/transactions/${id}/revoke-approval`, { reason })).data,
    onSuccess: () => void invalidateCommissionData(queryClient)
  })

  const voidSettlementMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      (await axios.post(`/api/commissions/payments/${id}/void`, { reason })).data,
    onSuccess: () => void invalidateCommissionData(queryClient)
  })

  const reopenPeriodMutation = useMutation({
    mutationFn: async ({ period, reason }: { period: string; reason: string }) =>
      (await axios.post('/api/commissions/periods/reopen', { period, reason })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commission-period-closures'] })
      queryClient.invalidateQueries({ queryKey: ['commission-period-readiness'] })
      void invalidateCommissionData(queryClient)
    }
  })

  if (!canView) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        You do not have permission to view commission information.
      </div>
    )
  }

  const settingsTabLabel = canManage
    ? 'Programme settings'
    : canReconcile && canClose
      ? 'Commission controls'
      : canReconcile
        ? 'Reconciliation'
        : 'Period close'

  const tabs: { key: Tab; label: string; icon: React.ReactNode; show: boolean }[] = [
    { key: 'overview', label: 'My overview', icon: <BarChart3 className="h-4 w-4" />, show: hasPermission('commission.own_view') || hasPermission('commission.own_monthly') || hasPermission('commission.own_daily') || hasPermission('commission.own_history') || hasPermission('commission.view') },
    { key: 'transactions', label: 'My ledger', icon: <History className="h-4 w-4" />, show: hasPermission('commission.own_transactions') },
    { key: 'potential', label: 'Pending opportunities', icon: <Target className="h-4 w-4" />, show: hasPermission('commission.own_potential') },
    { key: 'management', label: 'Management review', icon: <Users className="h-4 w-4" />, show: hasPermission('commission.view') || canApprove || canPay || canAdjust },
    { key: 'settings', label: settingsTabLabel, icon: <Settings2 className="h-4 w-4" />, show: canManage || canReconcile || canClose }
  ]

  const visibleTabs = tabs.filter(t => t.show)
  const activeTab = visibleTabs.some(candidate => candidate.key === tab) ? tab : visibleTabs[0]?.key
  const todayCommission = daily?.daily?.find((row: any) => String(row.date).slice(0, 10) === today) || {
    eligibleItems: 0, grossCommission: 0, reversals: 0, netCommission: 0
  }
  const managementRows: any[] = managementTransactions?.data || []
  const selectedApprovalRows = managementRows.filter(tx => selectedApprovalIds.has(tx.id))
  const selectedSettlementRows = managementRows.filter(tx => selectedTransactionIds.has(tx.id))
  const bulkPendingIds: string[] = managementTransactions?.bulkSelection?.pendingIds || []
  const bulkSettleableIds: string[] = managementTransactions?.bulkSelection?.settleableIds || []
  const allFilteredPendingSelected = bulkPendingIds.length > 0 && bulkPendingIds.every(id => selectedApprovalIds.has(id))
  const allFilteredSettleableSelected = bulkSettleableIds.length > 0 && bulkSettleableIds.every(id => selectedTransactionIds.has(id))
  const selectedApprovalTotal = allFilteredPendingSelected
    ? Number(managementTransactions?.bulkSelection?.pendingAmount || 0)
    : selectedApprovalRows.reduce((sum, tx) => sum + Number(tx.amount || 0), 0)
  const selectedSettlementTotal = allFilteredSettleableSelected
    ? Number(managementTransactions?.bulkSelection?.settleableAmount || 0)
    : selectedSettlementRows.reduce(
    (sum, tx) => sum + Math.max(0, Number(tx.amount || 0) - Number(tx.paid_amount || 0) - Number(tx.reversed_amount || 0)),
    0
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Commission centre</h1>
        <p className="text-muted-foreground">Completed-sale earnings, pending opportunities, approvals and programme controls</p>
      </div>

      {programmeStatus && (
        <div className={`rounded-lg border p-4 ${programmeStatus.status === 'active' ? 'border-emerald-200 bg-emerald-50/50' : programmeStatus.status === 'disabled' ? 'border-red-200 bg-red-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold">Commission programme: <span className="capitalize">{String(programmeStatus.status).replace('_', ' ')}</span></div>
              <p className="text-sm text-muted-foreground">
                {programmeStatus.status === 'active'
                  ? 'Earnings require verified payment, completion and, where applicable, delivery or Speedaf remittance.'
                  : 'New earnings are paused. Historical records, reversals, approvals and settlements remain available.'}
              </p>
            </div>
            {programmeStatus.currentRate && <div className="text-sm"><span className="text-muted-foreground">Global base rate:</span> <strong>{formatMoney(programmeStatus.currentRate.rate_per_item)} per item</strong></div>}
          </div>
          {programmeStatus.reason && <p className="mt-2 text-xs text-muted-foreground">Reason: {programmeStatus.reason}</p>}
        </div>
      )}

      {canClose && periodReadiness && periodCloseForm.period === previousNairobiMonth(today) && periodReadiness.periodStatus !== 'closed' && (
        <button type="button" onClick={() => setTab('settings')} className={`w-full rounded-lg border p-4 text-left ${periodReadiness.isReadyToClose ? 'border-emerald-300 bg-emerald-50/60' : 'border-amber-300 bg-amber-50/60'}`}>
          <span className="font-semibold">{formatCommissionMonth(periodReadiness.periodStart)} commission is still {periodReadiness.periodStatus}.</span>
          <span className="mt-1 block text-sm text-muted-foreground">{formatMoney(periodReadiness.totalUnpaid || 0)} will move forward, {formatMoney(periodReadiness.totalRecovery || 0)} is recovery, and {periodReadiness.pendingCount || 0} item(s) are waiting for approval. Open period close review.</span>
        </button>
      )}

      {visibleTabs.length > 1 && (
        <div className="mobile-tab-strip flex max-w-full gap-1 overflow-x-auto border-b" role="tablist" aria-label="Commission sections">
          {visibleTabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === t.key
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

       {activeTab === 'overview' && (
         <div className="space-y-6">
           {(hasPermission('commission.own_view') || hasPermission('commission.own_monthly') || hasPermission('commission.own_daily') || hasPermission('commission.own_history')) && (
             <div className="space-y-4">
               <h2 className="text-lg font-semibold">My commission — {formatCommissionMonth(today)}</h2>
                {hasPermission('commission.own_daily') && (
                  <div className="space-y-2"><h3 className="text-sm font-semibold">Today</h3><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><StatCard title="Items qualifying today" description="Items meeting commission rules today." value={String(todayCommission.eligibleItems || 0)} icon={<Target className="h-5 w-5" />} /><StatCard title="Commission recorded today" description="Commission added today before corrections." value={formatMoney(todayCommission.grossCommission)} icon={<Wallet className="h-5 w-5" />} /><StatCard title="Commission removed today" description="Amounts removed due to returns or corrections." value={formatMoney(todayCommission.reversals)} icon={<TrendingDown className="h-5 w-5" />} /><StatCard title="Today's recorded balance" description="Today's net commission after reversals." value={formatMoney(todayCommission.netCommission)} icon={<TrendingUp className="h-5 w-5" />} /></div></div>
                )}
               {summaryLoading ? (
                 <div className="text-muted-foreground">Loading...</div>
               ) : summary ? (
                 <div className="space-y-4">
                   <h3 className="text-sm font-semibold">How this month&apos;s balance is built</h3>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <StatCard title="Recorded" description="Commission added before corrections." value={formatMoney(summary.grossEarned || 0)} icon={<Wallet className="h-5 w-5" />} />
                      <StatCard title="Reversals" description="Amounts removed due to returns or corrections." value={formatMoney(summary.reversals || 0)} icon={<TrendingDown className="h-5 w-5" />} />
                      <StatCard title="Management add" description="Extra commission added with a recorded reason." value={formatMoney(summary.manualAdditions || 0)} icon={<TrendingUp className="h-5 w-5" />} />
                      <StatCard title="Management deduct" description="Commission removed with a recorded reason." value={formatMoney(summary.manualDeductions || 0)} icon={<TrendingDown className="h-5 w-5" />} />
                      <StatCard title={`Brought forward from ${formatCommissionMonth(previousNairobiMonth(today))}`} description="Approved commission from the previous closed month." value={formatMoney(summary.carryForwardCredits || 0)} icon={<TrendingUp className="h-5 w-5" />} />
                      <StatCard title={`Recovery from ${formatCommissionMonth(previousNairobiMonth(today))}`} description="Previous-month recovery that reduces settlement." value={formatMoney(summary.carryForwardDeductions || 0)} icon={<TrendingDown className="h-5 w-5" />} />
                      <StatCard title="Balance" description="Net balance after reversals and carry-forward. Not automatically payable." value={formatMoney(summary.netCommission || 0)} icon={<BarChart3 className="h-5 w-5" />} />
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold">Settlement status</h3>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <StatCard title="Approved" description="Approved amount available for settlement." value={formatMoney(summary.approvedPayable ?? summary.payableAmount ?? 0)} icon={<CheckCircle2 className="h-5 w-5" />} />
                      <StatCard title="Settled" description="Commission settlements already recorded this month." value={formatMoney(summary.paidAmount || 0)} icon={<CreditCard className="h-5 w-5" />} />
                      <StatCard title="Waiting" description="Recorded amount not yet approved for settlement." value={formatMoney(Math.max(0, Number(summary.pendingAmount || 0)))} icon={<Clock className="h-5 w-5" />} />
                      <StatCard title="Outstanding" description="Amount not yet settled." value={formatMoney(Math.max(0, Number(summary.outstandingAmount || 0)))} icon={<Target className="h-5 w-5" />} />
                      <StatCard title="Recovery" description="Amount offset before a further payment can be made." value={formatMoney(summary.recoveryDue || 0)} icon={<TrendingDown className="h-5 w-5" />} />
                    </div>
                 </div>
               ) : null}

               {daily?.daily && daily.daily.length > 0 && (
                 <div className="rounded-lg border bg-card overflow-hidden">
                   <div className="px-4 py-3 border-b">
                     <h3 className="font-semibold">Daily breakdown</h3>
                     <p className="text-xs text-muted-foreground">Current month commission by day</p>
                   </div>
                   <MobileTableScroll label="daily commission">
                     <table className="w-full text-sm">
                       <thead className="bg-muted">
                         <tr>
                           <th className="text-left px-4 py-3">Date</th>
                           <th className="text-right px-4 py-3">Eligible items</th>
                           <th className="text-right px-4 py-3">Gross</th>
                           <th className="text-right px-4 py-3">Reversals</th>
                           <th className="text-right px-4 py-3">Manual +</th>
                           <th className="text-right px-4 py-3">Manual -</th>
                           <th className="text-right px-4 py-3">Carry-forward</th>
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
                             <td className="px-4 py-3 text-right">{formatMoney(row.manualAdditions || 0)}</td>
                             <td className="px-4 py-3 text-right">{formatMoney(row.manualDeductions || 0)}</td>
                             <td className="px-4 py-3 text-right">{formatMoney((row.carryForwardCredits || 0) - (row.carryForwardDeductions || 0))}</td>
                             <td className="px-4 py-3 text-right font-medium">{formatMoney(row.netCommission)}</td>
                           </tr>
                         ))}
                       </tbody>
                     </table>
                   </MobileTableScroll>
                 </div>
               )}

               {monthlyHistory?.history?.length > 0 && (
                 <div className="rounded-lg border bg-card overflow-hidden">
                   <div className="px-4 py-3 border-b">
                     <h3 className="font-semibold">Monthly history</h3>
                     <p className="text-xs text-muted-foreground">Closed-period amounts carry forward. Last settlement shows the latest date recorded in this system.</p>
                   </div>
                   <MobileTableScroll label="monthly commission">
                     <table className="w-full text-sm">
                       <thead className="bg-muted">
                         <tr>
                           <th className="text-left px-4 py-3">Month</th>
                           <th className="text-right px-4 py-3">Eligible qty</th>
                           <th className="text-right px-4 py-3">Verified earnings</th>
                           <th className="text-right px-4 py-3">Returns / reversals</th>
                           <th className="text-right px-4 py-3">Manual +</th>
                           <th className="text-right px-4 py-3">Manual -</th>
                           <th className="text-right px-4 py-3">Carry-forward credit</th>
                           <th className="text-right px-4 py-3">Carry-forward recovery</th>
                           <th className="text-right px-4 py-3">Net balance</th>
                           <th className="text-right px-4 py-3">Approved & payable</th>
                           <th className="text-right px-4 py-3">Settled</th>
                           <th className="text-right px-4 py-3">Awaiting approval</th>
                           <th className="text-right px-4 py-3">Outstanding / recovery</th>
                           <th className="text-left px-4 py-3">Last settlement</th>
                           <th className="text-left px-4 py-3">Settlement</th>
                         </tr>
                       </thead>
                      <tbody>
                        {monthlyHistory.history.map((month: any) => (
                          <tr key={month.month} className="border-t">
                            <td className="px-4 py-3 font-medium">{formatCommissionMonth(month.month)}</td>
                            <td className="px-4 py-3 text-right">{month.eligibleQuantity}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(month.grossEarned || 0)}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(month.reversals || 0)}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(month.manualAdditions || 0)}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(month.manualDeductions || 0)}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(month.carryForwardCredits || 0)}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(month.carryForwardDeductions || 0)}</td>
                            <td className="px-4 py-3 text-right font-medium">{formatMoney(month.netCommission || 0)}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(month.approvedPayable ?? month.payableAmount ?? 0)}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(month.paidAmount || 0)}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(Math.max(0, Number(month.pendingAmount || 0)))}</td>
                            <td className="px-4 py-3 text-right">{month.recoveryDue > 0 ? `Recovery ${formatMoney(month.recoveryDue)}` : formatMoney(Math.max(0, Number(month.outstandingAmount || 0)))}</td>
                            <td className="px-4 py-3 whitespace-nowrap">{formatCommissionTimestamp(month.lastPaidAt)}</td>
                            <td className="px-4 py-3 capitalize whitespace-nowrap">{String(month.paymentStatus || 'unpaid').replaceAll('_', ' ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                   </MobileTableScroll>
                </div>
              )}
            </div>
          )}

          {hasPermission('commission.view') && managementSummary && (
            <div className="space-y-4">
              <div><h2 className="text-lg font-semibold">Company commission overview</h2><p className="text-sm text-muted-foreground">A quick company-wide summary for the selected period.</p></div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard title="Commission recorded from sales" description="Commission recorded for qualifying company sales, before corrections." value={formatMoney(managementSummary.totalEarned)} icon={<Wallet className="h-5 w-5" />} />
                <StatCard title="Commission removed or reversed" description="Amounts removed because an order or item was returned, cancelled or corrected." value={formatMoney(managementSummary.totalReversals)} icon={<TrendingDown className="h-5 w-5" />} />
                <StatCard title="Company recorded commission balance" description="All commission entries after corrections and earlier-month balances. It is not automatically payable." value={formatMoney(managementSummary.netCommission)} icon={<TrendingUp className="h-5 w-5" />} />
                <StatCard title="Salespeople with activity" description="Salespeople with at least one commission record in the selected period." value={String(managementSummary.salespersonCount || 0)} icon={<Users className="h-5 w-5" />} />
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'transactions' && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h3 className="font-semibold">My Commission Transactions</h3>
          </div>
          {txLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading...</div>
          ) : transactions?.data?.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No transactions yet</div>
          ) : (
            <MobileTableScroll label="commission transactions">
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
                    <th className="text-left px-4 py-3">Settlement record</th>
                    <th className="text-left px-4 py-3">Date</th>
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
                      <td className="px-4 py-3 text-xs">
                        {tx.last_paid_at ? <><div>{formatCommissionTimestamp(tx.last_paid_at)}</div><div className="mt-1 max-w-56 break-words text-muted-foreground">{tx.payment_references || 'Settlement recorded'}</div></> : '-'}
                      </td>
                      <td className="px-4 py-3">{new Date(tx.qualification_date).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </MobileTableScroll>
          )}
          {transactions?.pagination && transactions.pagination.totalPages > 1 && (
            <div className="px-4 py-3 border-t">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>Page {transactions.pagination.page} of {transactions.pagination.totalPages}</span>
                <div className="flex gap-2">
                  <button onClick={() => setTransactionPage((page: number) => Math.max(1, page - 1))} disabled={transactions.pagination.page <= 1} className="px-3 py-1 border rounded disabled:opacity-50">Previous</button>
                  <button onClick={() => setTransactionPage((page: number) => page + 1)} disabled={transactions.pagination.page >= transactions.pagination.totalPages} className="px-3 py-1 border rounded disabled:opacity-50">Next</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'potential' && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h3 className="font-semibold">Potential Commission</h3>
            <p className="text-xs text-muted-foreground">Estimated, non-payable commission waiting for a verified delivery, payment or Speedaf remittance condition</p>
          </div>
          {potential?.potential?.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No potential commission at this time</div>
          ) : (
            <MobileTableScroll label="pending commission">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-left px-4 py-3">Order</th>
                    <th className="text-left px-4 py-3">Product</th>
                    <th className="text-right px-4 py-3">Qty</th>
                    <th className="text-left px-4 py-3">Category</th>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-right px-4 py-3">Estimated</th>
                    <th className="text-left px-4 py-3">Why it is pending</th>
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
                      <td className="px-4 py-3 text-right">{formatMoney(row.estimatedCommission)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </MobileTableScroll>
          )}
        </div>
      )}

       {activeTab === 'management' && (hasPermission('commission.view') || canApprove || canPay || canAdjust) && (
         <div className="space-y-6">
           <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 lg:flex-row lg:items-end lg:justify-between">
             <div><h3 className="font-semibold">Management review period</h3><p className="text-xs text-muted-foreground">Figures use the date the completed sale qualified for commission.</p></div>
             <DateRangeFilter dateFrom={managementFrom} dateTo={managementTo} includeClear={false} compact onChange={range => { setManagementFrom(range.dateFrom); setManagementTo(range.dateTo); setManagementTransactionPage(1) }} />
           </div>

           {managementSummary && (
             <div className="space-y-3">
               <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                 <StatCard title="Recorded" description="Qualifying company sales before corrections." value={formatMoney(managementSummary.totalEarned || 0)} icon={<Wallet className="h-5 w-5" />} />
                 <StatCard title="Reversals" description="Amounts removed due to returns or corrections." value={formatMoney(managementSummary.totalReversals || 0)} icon={<TrendingDown className="h-5 w-5" />} />
                 <StatCard title="Balance" description="Net balance after reversals, management changes and carry-forward. Not automatically payable." value={formatMoney(managementSummary.netCommission || 0)} icon={<BarChart3 className="h-5 w-5" />} />
                 <StatCard title="Management add" description="Extra commission added with a recorded reason." value={formatMoney(managementSummary.totalManualAdditions || 0)} icon={<TrendingUp className="h-5 w-5" />} />
                 <StatCard title="Management deduct" description="Commission removed with a recorded reason." value={formatMoney(managementSummary.totalManualDeductions || 0)} icon={<TrendingDown className="h-5 w-5" />} />
                 <StatCard title="Carry-forward credit" description="Positive balances brought forward from closed months." value={formatMoney(managementSummary.totalCarryForwardCredits || 0)} icon={<TrendingUp className="h-5 w-5" />} />
                 <StatCard title="Carry-forward recovery" description="Balances carried forward that reduce payment." value={formatMoney(managementSummary.totalCarryForwardDeductions || 0)} icon={<TrendingDown className="h-5 w-5" />} />
                 <StatCard title="Approved" description="Approved amount available for settlement." value={formatMoney(managementSummary.approvedPayable ?? managementSummary.approvedUnpaid ?? 0)} icon={<CreditCard className="h-5 w-5" />} />
                 <StatCard title="Settled" description="Commission settlements recorded for the selected period." value={formatMoney(managementSummary.totalPayments || 0)} icon={<CheckCircle2 className="h-5 w-5" />} />
                 <StatCard title="Recovery" description="Amount offset before a further payment can be made." value={formatMoney(managementSummary.recoveryDue || 0)} icon={<TrendingDown className="h-5 w-5" />} />
                 <StatCard title="Salespeople" description="Salespeople with commission activity in the selected period." value={String(managementSummary.salespersonCount || 0)} icon={<Users className="h-5 w-5" />} />
               </div>
             </div>
           )}
          {managementBySalesperson?.salespeople?.length === 0 ? (
            <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">No commission data for selected period</div>
          ) : (
            <div className="rounded-lg border bg-card overflow-hidden">
              <div className="px-4 py-3 border-b">
                <h3 className="font-semibold">Commission by Salesperson</h3>
              </div>
              <MobileTableScroll label="salesperson commission">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left px-4 py-3">Salesperson</th>
                      <th className="text-right px-4 py-3">Gross Earned</th>
                      <th className="text-right px-4 py-3">Reversals</th>
                      <th className="text-right px-4 py-3">Net</th>
                      <th className="text-right px-4 py-3">Settled</th>
                      <th className="text-right px-4 py-3">Payable / recovery</th>
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
                        <td className="px-4 py-3 text-right">{sp.recoveryDue > 0 ? `Recovery ${formatMoney(sp.recoveryDue)}` : formatMoney(sp.payableAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </MobileTableScroll>
            </div>
          )}

          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b"><h3 className="font-semibold">Commission approval and settlement ledger</h3><p className="text-xs text-muted-foreground">Approve verified earnings, then record the external salary, cash, M-PESA or bank settlement. A settlement cannot exceed the balance after deductions and reversals.</p></div>
            <div className="flex flex-wrap gap-3 border-b bg-muted/20 p-3">
              <select className="rounded border bg-background px-2 py-1 text-sm" value={managementTransactionStatus} onChange={event => { setManagementTransactionStatus(event.target.value); setManagementTransactionPage(1); setSelectedApprovalIds(new Set()); setSelectedTransactionIds(new Set()) }}><option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="paid">Settled</option><option value="reversed">Reversed</option></select>
              <select className="rounded border bg-background px-2 py-1 text-sm" value={managementSalespersonId} onChange={event => { setManagementSalespersonId(event.target.value); setManagementTransactionPage(1); setSelectedApprovalIds(new Set()); setSelectedTransactionIds(new Set()) }}><option value="">All salespeople</option>{salespeople.map((person: any) => <option key={person.id} value={person.id}>{person.full_name || person.name}</option>)}</select>
            </div>
            {paymentEntry.transactionId && canPay && selectedTransactionIds.size === 0 && (
              <form className="grid gap-3 border-b bg-muted/30 p-4 md:grid-cols-6" onSubmit={async event => {
                event.preventDefault()
                await payMutation.mutateAsync({
                  id: paymentEntry.transactionId,
                  data: {
                    amount: paymentEntry.amount ? Number(paymentEntry.amount) : undefined,
                    payment_method: paymentEntry.payment_method,
                    reference: paymentEntry.reference || null,
                    notes: paymentEntry.notes || null,
                    settled_at: paymentEntry.settled_at,
                    idempotency_key: paymentEntry.idempotency_key
                  }
                })
                setPaymentEntry({ transactionId: '', amount: '', payment_method: 'payroll', reference: '', notes: '', settled_at: today, idempotency_key: paymentConfirmationKey() })
              }}>
                <input type="number" min="0.01" step="0.01" placeholder="Amount (leave blank for maximum)" className="rounded border px-2 py-2 text-sm" value={paymentEntry.amount} onChange={event => setPaymentEntry({ ...paymentEntry, amount: event.target.value })} />
                <select className="rounded border px-2 py-2 text-sm" value={paymentEntry.payment_method} onChange={event => setPaymentEntry({ ...paymentEntry, payment_method: event.target.value })}><option value="payroll">Salary / Payroll</option><option value="mpesa">M-PESA</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option></select>
                <input required={paymentEntry.payment_method !== 'cash'} className="rounded border px-2 py-2 text-sm" placeholder={paymentEntry.payment_method === 'payroll' ? 'Salary / payroll reference' : paymentEntry.payment_method === 'cash' ? 'Cash receipt reference (optional)' : 'Required settlement reference'} value={paymentEntry.reference} onChange={event => setPaymentEntry({ ...paymentEntry, reference: event.target.value })} />
                <input required type="date" max={today} title="Settlement date" className="rounded border px-2 py-2 text-sm" value={paymentEntry.settled_at} onChange={event => setPaymentEntry({ ...paymentEntry, settled_at: event.target.value })} />
                <input className="rounded border px-2 py-2 text-sm" placeholder="Notes" value={paymentEntry.notes} onChange={event => setPaymentEntry({ ...paymentEntry, notes: event.target.value })} />
                <div className="flex gap-2"><button disabled={payMutation.isPending} className="rounded bg-emerald-700 px-3 py-2 text-xs text-white disabled:opacity-50">Record settlement</button><button type="button" className="rounded border px-3 py-2 text-xs" onClick={() => setPaymentEntry({ transactionId: '', amount: '', payment_method: 'payroll', reference: '', notes: '', settled_at: today, idempotency_key: paymentConfirmationKey() })}>Cancel</button></div>
                {payMutation.isError && <p className="text-sm text-red-600 md:col-span-6">{(payMutation.error as any)?.response?.data?.error?.message || 'Unable to record settlement'}</p>}
              </form>
            )}
            {managementTransactions?.data?.length ? (
              <MobileTableScroll label="management commission">
                <table className="w-full text-sm">
                  <thead className="bg-muted"><tr><th className="text-center px-4 py-3">Select</th><th className="text-left px-4 py-3">Salesperson</th><th className="text-left px-4 py-3">Reference</th><th className="text-left px-4 py-3">Type</th><th className="text-right px-4 py-3">Amount</th><th className="text-right px-4 py-3">Settled / offset</th><th className="text-left px-4 py-3">Settlement record</th><th className="text-left px-4 py-3">Status</th><th className="text-right px-4 py-3">Action</th></tr></thead>
                  <tbody>{managementTransactions.data.map((tx: any) => {
                    const payable = canPay && ['approved', 'paid'].includes(tx.transaction_status) && (['earned', 'manual_add'].includes(tx.transaction_type) || (tx.transaction_type === 'carry_forward' && tx.carry_forward_direction === 'credit')) && Number(tx.amount) - Number(tx.paid_amount || 0) - Number(tx.reversed_amount || 0) > 0.004
                    const approvable = canApprove && tx.transaction_status === 'pending'
                    const checked = selectedTransactionIds.has(tx.id) || selectedApprovalIds.has(tx.id)
                    return (<tr key={tx.id} className={`border-t ${payable || approvable ? '' : 'opacity-70'}`}>
                      <td className="px-4 py-3 text-center">{(approvable || payable) && <input aria-label={`Select ${approvable ? 'for approval' : 'for settlement'}`} type="checkbox" checked={checked} onChange={event => { if (approvable) { const next = new Set(selectedApprovalIds); if (event.target.checked) next.add(tx.id); else next.delete(tx.id); setSelectedApprovalIds(next); setSelectedTransactionIds(new Set()) } else { const next = new Set(selectedTransactionIds); if (event.target.checked) next.add(tx.id); else next.delete(tx.id); setSelectedTransactionIds(next); setSelectedApprovalIds(new Set()) } }} />}</td>
                      <td className="px-4 py-3">{tx.salesperson_name}</td>
                      <td className="px-4 py-3"><div>{tx.order_number}</div><div className="text-xs text-muted-foreground">{tx.product_name}</div></td>
                      <td className="px-4 py-3 capitalize">{String(tx.transaction_type).replace('_', ' ')}</td>
                      <td className="px-4 py-3 text-right font-medium">{formatMoney(tx.amount)}</td>
                      <td className="px-4 py-3 text-right">{formatMoney(tx.paid_amount)}{Number(tx.reversed_amount || 0) > 0 && <div className="text-xs text-red-600">Offset {formatMoney(tx.reversed_amount)}</div>}</td>
                      <td className="px-4 py-3 text-xs">{tx.last_paid_at ? <div className="space-y-2"><div>{formatCommissionTimestamp(tx.last_paid_at)}</div><div className="max-w-56 break-words text-muted-foreground">{tx.payment_references || 'Settlement recorded'}</div>{isAdministrativeRole && Array.isArray(tx.settlement_records) && tx.settlement_records.map((settlement: any) => <button key={settlement.id} type="button" className="block text-red-600 hover:underline" onClick={() => { const reason = prompt(`Reason for voiding ${formatMoney(settlement.amount)} ${String(settlement.method).replace('_', ' ')} settlement?`); if (reason?.trim()) voidSettlementMutation.mutate({ id: settlement.id, reason: reason.trim() }) }}>Void {formatMoney(settlement.amount)} settlement</button>)}</div> : '-'}</td>
                      <td className="px-4 py-3 capitalize">{tx.transaction_status}</td>
                      <td className="px-4 py-3 text-right">
                        {canApprove && tx.transaction_status === 'pending' && <button className="text-xs text-blue-600 hover:underline" onClick={() => approveMutation.mutate(tx.id)}>Approve</button>}
                        {isAdministrativeRole && tx.transaction_status === 'approved' && Number(tx.paid_amount || 0) <= 0 && tx.transaction_type !== 'carry_forward' && <button className="ml-2 text-xs text-amber-700 hover:underline" onClick={() => { const reason = prompt('Reason for revoking this approval?'); if (reason?.trim()) revokeApprovalMutation.mutate({ id: tx.id, reason: reason.trim() }) }}>Revoke approval</button>}
                        {canPay && payable && <button className="text-xs text-emerald-600 hover:underline ml-2" onClick={() => setPaymentEntry({ transactionId: tx.id, amount: '', payment_method: 'payroll', reference: '', notes: '', settled_at: today, idempotency_key: paymentConfirmationKey() })}>Settle</button>}
                      </td>
                    </tr>)
                  })}</tbody>
                </table>
              </MobileTableScroll>
            ) : <div className="p-6 text-center text-muted-foreground">No commission transactions in this period</div>}
            {(bulkPendingIds.length > 0 || bulkSettleableIds.length > 0) && (
              <div className="border-t bg-muted/20 p-4">
                <div className="mb-3"><strong className="text-sm">Finished reviewing?</strong><p className="text-xs text-muted-foreground">Select every matching entry in the filtered period, including entries on other pages.</p></div>
                <div className="grid gap-3 md:grid-cols-2">
                  {canApprove && bulkPendingIds.length > 0 && <button type="button" className={`rounded border p-3 text-left text-sm ${allFilteredPendingSelected ? 'border-blue-500 bg-blue-100' : 'border-blue-200 bg-blue-50'}`} onClick={() => { setSelectedApprovalIds(allFilteredPendingSelected ? new Set() : new Set(bulkPendingIds)); setSelectedTransactionIds(new Set()) }}><span className="flex items-center gap-2"><span aria-hidden="true" className={`inline-flex h-4 w-4 items-center justify-center rounded border ${allFilteredPendingSelected ? 'border-blue-700 bg-blue-700 text-white' : 'border-blue-400 bg-white'}`}>{allFilteredPendingSelected ? '✓' : ''}</span><strong>{allFilteredPendingSelected ? 'All pending selected' : `Select all ${bulkPendingIds.length} pending`}</strong></span><span className="mt-1 block pl-6 text-xs text-muted-foreground">Entire ledger amount: {formatMoney(managementTransactions.bulkSelection.pendingAmount || 0)}</span></button>}
                  {canPay && bulkSettleableIds.length > 0 && <button type="button" className={`rounded border p-3 text-left text-sm ${allFilteredSettleableSelected ? 'border-emerald-500 bg-emerald-100' : 'border-emerald-200 bg-emerald-50'}`} onClick={() => { setSelectedTransactionIds(allFilteredSettleableSelected ? new Set() : new Set(bulkSettleableIds)); setSelectedApprovalIds(new Set()) }}><span className="flex items-center gap-2"><span aria-hidden="true" className={`inline-flex h-4 w-4 items-center justify-center rounded border ${allFilteredSettleableSelected ? 'border-emerald-700 bg-emerald-700 text-white' : 'border-emerald-400 bg-white'}`}>{allFilteredSettleableSelected ? '✓' : ''}</span><strong>{allFilteredSettleableSelected ? 'All ready to settle selected' : `Select all ${bulkSettleableIds.length} ready to settle`}</strong></span><span className="mt-1 block pl-6 text-xs text-muted-foreground">Entire net settlement after recovery/deductions: {formatMoney(managementTransactions.bulkSelection.settleableAmount || 0)}</span></button>}
                </div>
              </div>
            )}
            {selectedApprovalIds.size > 0 && canApprove && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-blue-50/60 p-4">
                <div><strong>Approve {selectedApprovalIds.size} selected transaction{selectedApprovalIds.size > 1 ? 's' : ''}</strong><p className="text-sm text-muted-foreground">Selected ledger amount: {formatMoney(selectedApprovalTotal)}</p></div>
                <div className="flex gap-2"><button type="button" disabled={bulkApproveMutation.isPending} className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" onClick={() => { if (confirm(`Approve ${selectedApprovalIds.size} commission transactions with a total ledger amount of ${formatMoney(selectedApprovalTotal)}?`)) bulkApproveMutation.mutate(Array.from(selectedApprovalIds)) }}>{bulkApproveMutation.isPending ? 'Approving...' : 'Approve selected'}</button><button type="button" className="rounded border bg-background px-3 py-2 text-sm" onClick={() => setSelectedApprovalIds(new Set())}>Clear</button></div>
                {bulkApproveMutation.isError && <p className="w-full text-sm text-red-600">{(bulkApproveMutation.error as any)?.response?.data?.error?.message || 'Unable to approve the selected transactions'}</p>}
              </div>
            )}
            {selectedTransactionIds.size > 0 && canPay && (
              <form className="grid gap-3 border-t bg-muted/30 p-4 md:grid-cols-6" onSubmit={async event => {
                event.preventDefault()
                await bulkPayMutation.mutateAsync({ transaction_ids: Array.from(selectedTransactionIds), payment_method: bulkPaymentEntry.payment_method, reference: bulkPaymentEntry.reference || '', notes: bulkPaymentEntry.notes || '', settled_at: bulkPaymentEntry.settled_at, idempotency_key: bulkPaymentEntry.idempotency_key })
              }}>
                <div className="md:col-span-2 text-sm font-medium">Settle {selectedTransactionIds.size} selected transaction{selectedTransactionIds.size > 1 ? 's' : ''} together<span className="mt-1 block text-xs font-normal text-muted-foreground">Selected balance: {formatMoney(selectedSettlementTotal)}. Final total is validated against recovery and deductions.</span></div>
                <select className="rounded border px-2 py-2 text-sm" value={bulkPaymentEntry.payment_method} onChange={event => setBulkPaymentEntry({ ...bulkPaymentEntry, payment_method: event.target.value })}><option value="payroll">Salary / Payroll</option><option value="mpesa">M-PESA</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option></select>
                <input required={bulkPaymentEntry.payment_method !== 'cash'} className="rounded border px-2 py-2 text-sm" placeholder={bulkPaymentEntry.payment_method === 'payroll' ? 'Salary / payroll reference' : bulkPaymentEntry.payment_method === 'cash' ? 'Cash receipt reference (optional)' : 'Required settlement reference'} value={bulkPaymentEntry.reference} onChange={event => setBulkPaymentEntry({ ...bulkPaymentEntry, reference: event.target.value })} />
                <input required type="date" max={today} title="Settlement date" className="rounded border px-2 py-2 text-sm" value={bulkPaymentEntry.settled_at} onChange={event => setBulkPaymentEntry({ ...bulkPaymentEntry, settled_at: event.target.value })} />
                <input className="rounded border px-2 py-2 text-sm" placeholder="Notes" value={bulkPaymentEntry.notes} onChange={event => setBulkPaymentEntry({ ...bulkPaymentEntry, notes: event.target.value })} />
                <div className="flex gap-2"><button disabled={bulkPayMutation.isPending} className="rounded bg-emerald-700 px-3 py-2 text-xs text-white disabled:opacity-50">Record settlements</button><button type="button" className="rounded border px-3 py-2 text-xs" onClick={() => setSelectedTransactionIds(new Set())}>Cancel</button></div>
                {bulkPayMutation.isError && <p className="text-sm text-red-600 md:col-span-6">{(bulkPayMutation.error as any)?.response?.data?.error?.message || 'Unable to record selected settlements'}</p>}
              </form>
            )}
            {managementTransactions?.pagination?.totalPages > 1 && <div className="flex items-center justify-between border-t px-4 py-3 text-sm"><span>Page {managementTransactions.pagination.page} of {managementTransactions.pagination.totalPages}</span><div className="flex gap-2"><button disabled={managementTransactions.pagination.page <= 1} className="rounded border px-3 py-1 disabled:opacity-50" onClick={() => { setManagementTransactionPage(page => Math.max(1, page - 1)); setSelectedApprovalIds(new Set()); setSelectedTransactionIds(new Set()) }}>Previous</button><button disabled={managementTransactions.pagination.page >= managementTransactions.pagination.totalPages} className="rounded border px-3 py-1 disabled:opacity-50" onClick={() => { setManagementTransactionPage(page => page + 1); setSelectedApprovalIds(new Set()); setSelectedTransactionIds(new Set()) }}>Next</button></div></div>}
          </div>

          {canAdjust && (
            <form className="rounded-lg border bg-card p-4 space-y-3" onSubmit={async e => { e.preventDefault(); await adjustmentMutation.mutateAsync({ ...adjustmentForm, amount: Number(adjustmentForm.amount) }) }}>
              <div><h3 className="font-semibold">Manual correction</h3><p className="text-xs text-muted-foreground">Use only for an auditable addition or deduction that cannot be produced from an order event. Select the relevant period; a closed period is recorded as a clearly linked current-period correction.</p></div>
              <div className="grid gap-3 md:grid-cols-6">
                <select required className="border rounded px-2 py-2 text-sm" value={adjustmentForm.salesperson_id} onChange={e => setAdjustmentForm({ ...adjustmentForm, salesperson_id: e.target.value })}><option value="">Select salesperson</option>{salespeople?.map((sp: any) => <option key={sp.id} value={sp.id}>{sp.full_name || sp.name}</option>)}</select>
                <select className="border rounded px-2 py-2 text-sm" value={adjustmentForm.adjustment_type} onChange={e => setAdjustmentForm({ ...adjustmentForm, adjustment_type: e.target.value })}><option value="manual_add">Addition</option><option value="manual_deduct">Deduction</option></select>
                <input required type="month" className="border rounded px-2 py-2 text-sm" title="Relevant commission period" value={adjustmentForm.period} onChange={e => setAdjustmentForm({ ...adjustmentForm, period: e.target.value })} />
                <input required min="0.01" step="0.01" type="number" placeholder="Amount" className="border rounded px-2 py-2 text-sm" value={adjustmentForm.amount} onChange={e => setAdjustmentForm({ ...adjustmentForm, amount: e.target.value })} />
                <input placeholder="Related order ID (if applicable)" className="border rounded px-2 py-2 text-sm" value={adjustmentForm.order_id} onChange={e => setAdjustmentForm({ ...adjustmentForm, order_id: e.target.value })} />
                <input required placeholder="Mandatory reason" className="border rounded px-2 py-2 text-sm" value={adjustmentForm.reason} onChange={e => setAdjustmentForm({ ...adjustmentForm, reason: e.target.value })} />
              </div>
              <button disabled={adjustmentMutation.isPending} className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground">Create auditable adjustment</button>
            </form>
          )}
        </div>
      )}

      {activeTab === 'settings' && !canManage && canReconcile && (
        <div className="space-y-4 rounded-lg border bg-card p-5">
          <div>
            <h2 className="text-lg font-semibold">Commission reconciliation</h2>
            <p className="text-sm text-muted-foreground">Preview missing earnings and ledger exceptions first. Applying creates only earnings supported by completed-sale evidence and required return/refund reversals in one audited run.</p>
          </div>
          <form className="grid gap-3 md:grid-cols-3" onSubmit={async event => {
            event.preventDefault()
            setRetroResult(null)
            await retroMutation.mutateAsync({ ...retroDates, apply: false })
          }}>
            <label className="text-sm">Order date from<input required type="date" className="mt-1 block w-full rounded border px-2 py-2" value={retroDates.date_from} onChange={event => setRetroDates({ ...retroDates, date_from: event.target.value })} /></label>
            <label className="text-sm">Order date to<input required type="date" className="mt-1 block w-full rounded border px-2 py-2" value={retroDates.date_to} onChange={event => setRetroDates({ ...retroDates, date_to: event.target.value })} /></label>
            <div className="flex items-end"><button disabled={retroMutation.isPending} className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">Preview reconciliation</button></div>
          </form>
          {retroMutation.isError && <p className="text-sm text-red-600">{(retroMutation.error as any)?.response?.data?.error?.message || 'Unable to run reconciliation'}</p>}
          {retroResult && (
            <div className="space-y-3 border-t pt-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard title="Missing earnings ready" description="Eligible items with no commission record yet." value={String(retroResult.eligibleItems || 0)} icon={<Target className="h-5 w-5" />} />
                <StatCard title="Already recorded" description="Eligible items that already have a commission record." value={String(retroResult.alreadyEarnedItems || 0)} icon={<CheckCircle2 className="h-5 w-5" />} />
                <StatCard title="Reversals to create" description="Missing reversal entries for returned or refunded items." value={String(retroResult.issues?.filter((issue: any) => issue.type === 'missing_reversal').length || 0)} icon={<TrendingDown className="h-5 w-5" />} />
                <StatCard title="Review exceptions" description="Records the system will not change automatically." value={String(retroResult.issuesFound || 0)} icon={<XCircle className="h-5 w-5" />} />
              </div>
              {retroResult.issues?.length > 0 && <div className="max-h-64 overflow-auto rounded border text-sm">{retroResult.issues.map((issue: any, index: number) => <div key={`${issue.type}-${issue.transactionId || issue.orderItemId || index}`} className="border-b p-3 last:border-0"><span className="font-medium capitalize">{String(issue.type).replaceAll('_', ' ')}</span><p className="text-muted-foreground">{issue.message}</p></div>)}</div>}
              {retroResult.mode === 'preview' && (retroResult.eligibleItems > 0 || retroResult.issues?.some((issue: any) => issue.type === 'missing_reversal')) && (
                <div className="rounded border border-amber-200 bg-amber-50 p-3 space-y-2">
                  <label className="text-sm font-medium">Reason for this applied reconciliation<input required className="mt-1 block w-full rounded border px-2 py-2" value={retroReason} onChange={event => setRetroReason(event.target.value)} /></label>
                  <button disabled={!retroReason.trim() || retroMutation.isPending} onClick={() => retroMutation.mutate({ ...retroDates, apply: true, reason: retroReason })} className="rounded bg-amber-700 px-3 py-2 text-sm text-white disabled:opacity-50">Apply reviewed changes</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'settings' && !canManage && (hasPermission('commission.own_view') || hasPermission('commission.own_potential')) && (
        <div className="space-y-4 rounded-lg border bg-card p-5">
          <div>
            <h2 className="text-lg font-semibold">My retroactive commission</h2>
            <p className="text-sm text-muted-foreground">Backfill your own earlier sales. Only your orders are evaluated.</p>
          </div>
          <form className="grid gap-3 md:grid-cols-3" onSubmit={async event => {
            event.preventDefault()
            setRetroResult(null)
            await ownRetroMutation.mutateAsync({ ...retroDates, apply: false })
          }}>
            <label className="text-sm">Order date from<input required type="date" className="mt-1 block w-full rounded border px-2 py-2" value={retroDates.date_from} onChange={event => setRetroDates({ ...retroDates, date_from: event.target.value })} /></label>
            <label className="text-sm">Order date to<input required type="date" className="mt-1 block w-full rounded border px-2 py-2" value={retroDates.date_to} onChange={event => setRetroDates({ ...retroDates, date_to: event.target.value })} /></label>
            <div className="flex items-end"><button disabled={ownRetroMutation.isPending} className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">Preview my missing commission</button></div>
          </form>
          {ownRetroMutation.isError && <p className="text-sm text-red-600">{(ownRetroMutation.error as any)?.response?.data?.error?.message || 'Unable to run retroactive evaluation'}</p>}
          {retroResult && (
            <div className="space-y-3 border-t pt-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard title="Missing earnings ready" description="Your eligible items with no commission record yet." value={String(retroResult.eligibleItems || 0)} icon={<Target className="h-5 w-5" />} />
                <StatCard title="Already recorded" description="Your eligible items that already have a commission record." value={String(retroResult.alreadyEarnedItems || 0)} icon={<CheckCircle2 className="h-5 w-5" />} />
                <StatCard title="Reversals to create" description="Missing reversal entries for your returned or refunded items." value={String(retroResult.issues?.filter((issue: any) => issue.type === 'missing_reversal').length || 0)} icon={<TrendingDown className="h-5 w-5" />} />
                <StatCard title="Review exceptions" description="Records the system will not change automatically." value={String(retroResult.issuesFound || 0)} icon={<XCircle className="h-5 w-5" />} />
              </div>
              {retroResult.issues?.length > 0 && <div className="max-h-64 overflow-auto rounded border text-sm">{retroResult.issues.map((issue: any, index: number) => <div key={`${issue.type}-${issue.transactionId || issue.orderItemId || index}`} className="border-b p-3 last:border-0"><span className="font-medium capitalize">{String(issue.type).replaceAll('_', ' ')}</span><p className="text-muted-foreground">{issue.message}</p></div>)}</div>}
              {retroResult.mode === 'preview' && (retroResult.eligibleItems > 0 || retroResult.issues?.some((issue: any) => issue.type === 'missing_reversal')) && (
                <div className="rounded border border-amber-200 bg-amber-50 p-3 space-y-2">
                  <label className="text-sm font-medium">Reason for this applied reconciliation<input required className="mt-1 block w-full rounded border px-2 py-2" value={retroReason} onChange={event => setRetroReason(event.target.value)} /></label>
                  <button disabled={!retroReason.trim() || ownRetroMutation.isPending} onClick={() => ownRetroMutation.mutate({ ...retroDates, apply: true, reason: retroReason })} className="rounded bg-amber-700 px-3 py-2 text-sm text-white disabled:opacity-50">Apply reviewed changes</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'settings' && canClose && (
        <section className="space-y-5">
          <div className="rounded-lg border border-amber-300 bg-amber-50/60 p-5">
            <div>
              <h2 className="text-lg font-semibold">Close a commission period</h2>
              <p className="mt-1 text-sm text-muted-foreground">Close only a fully completed Nairobi calendar month after every pending item has been approved or resolved.</p>
            </div>
            <div className="mt-4 rounded border border-amber-300 bg-amber-100/70 p-3 text-sm text-amber-950">
              Closing freezes the source month. Unpaid credit and recovery balances move to the following month. An administrator can undo the close only before a later period is closed or the carried balance is settled.
            </div>
            {periodReadinessLoading ? <p className="mt-4 text-sm text-muted-foreground">Preparing close preview...</p> : periodReadiness && (
              <div className={`mt-4 rounded border p-4 ${periodReadiness.isReadyToClose ? 'border-emerald-200 bg-emerald-50/60' : 'border-red-200 bg-red-50/60'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{formatCommissionMonth(periodReadiness.periodStart)} close preview</h3><span className={`rounded-full px-2 py-1 text-xs font-medium ${periodReadiness.isReadyToClose ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>{periodReadiness.isReadyToClose ? 'Ready to close' : 'Review required'}</span></div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5 text-sm"><div><span className="block text-xs text-muted-foreground">Approved credit</span>{formatMoney(periodReadiness.totalApprovedCredits || 0)}</div><div><span className="block text-xs text-muted-foreground">Deductions</span>{formatMoney(periodReadiness.totalApprovedDeductions || 0)}</div><div><span className="block text-xs text-muted-foreground">Settled</span>{formatMoney(periodReadiness.totalSettled || 0)}</div><div><span className="block text-xs text-muted-foreground">Moving forward</span>{formatMoney(periodReadiness.totalUnpaid || 0)}</div><div><span className="block text-xs text-muted-foreground">Recovery moving forward</span>{formatMoney(periodReadiness.totalRecovery || 0)}</div></div>
                {periodReadiness.blockers?.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-red-800">{periodReadiness.blockers.map((blocker: string) => <li key={blocker}>{blocker}</li>)}</ul>}
                {periodReadiness.balances?.length > 0 && <MobileTableScroll label="commission close preview" className="mt-4 rounded border bg-card"><table className="w-full text-xs"><thead className="bg-muted"><tr><th className="px-3 py-2 text-left">Attendant</th><th className="px-3 py-2 text-right">Approved</th><th className="px-3 py-2 text-right">Settled</th><th className="px-3 py-2 text-right">Result</th></tr></thead><tbody>{periodReadiness.balances.map((balance: any) => <tr key={balance.salespersonId} className="border-t"><td className="px-3 py-2">{balance.salespersonName}</td><td className="px-3 py-2 text-right">{formatMoney((balance.approvedCredits || 0) - (balance.approvedDeductions || 0))}</td><td className="px-3 py-2 text-right">{formatMoney(balance.paidAmount || 0)}</td><td className="px-3 py-2 text-right font-medium">{balance.closingBalance < 0 ? `Recovery ${formatMoney(Math.abs(balance.closingBalance))}` : `${formatMoney(balance.closingBalance || 0)} forward`}</td></tr>)}</tbody></table></MobileTableScroll>}
              </div>
            )}
            <form className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]" onSubmit={async event => {
              event.preventDefault()
              const periodLabel = formatCommissionMonth(periodCloseForm.period)
              if (!confirm(`Close ${periodLabel} with ${formatMoney(periodReadiness?.totalUnpaid || 0)} moving forward and ${formatMoney(periodReadiness?.totalRecovery || 0)} recovery?`)) return
              await closePeriodMutation.mutateAsync(periodCloseForm)
            }}>
              <label className="text-sm font-medium">
                Completed month (Nairobi)
                <input required type="month" max={previousNairobiMonth(today)} className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm" value={periodCloseForm.period} onChange={event => setPeriodCloseForm({ ...periodCloseForm, period: event.target.value })} />
              </label>
              <label className="text-sm font-medium">
                Close reason
                <input required className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm" placeholder="Why this period is ready to close" value={periodCloseForm.reason} onChange={event => setPeriodCloseForm({ ...periodCloseForm, reason: event.target.value })} />
              </label>
              <div className="flex items-end"><button disabled={closePeriodMutation.isPending || !periodReadiness?.isReadyToClose} className="w-full rounded bg-amber-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{closePeriodMutation.isPending ? 'Closing period...' : 'Close period'}</button></div>
            </form>
            {closePeriodMutation.isError && (
              <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <p>{(closePeriodMutation.error as any)?.response?.data?.error?.message || 'Unable to close this period'}</p>
                {Array.isArray((closePeriodMutation.error as any)?.response?.data?.error?.pending_transactions) && (
                  <p className="mt-2 text-xs">Pending items: {(closePeriodMutation.error as any).response.data.error.pending_transactions.map((item: any) => `${item.transaction_type} ${formatMoney(item.amount || 0)}`).join(', ')}</p>
                )}
              </div>
            )}
            {closePeriodMutation.isSuccess && <p className="mt-3 text-sm text-emerald-700">Period closed and carry-forward balances recorded. Select another completed month only after reviewing the closure history below.</p>}
          </div>

          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b">
              <h3 className="font-semibold">Commission period closure history</h3>
              <p className="text-xs text-muted-foreground">Each close records the amount moved forward. A safe administrative undo remains visible here and in the audit log.</p>
            </div>
            {periodClosuresLoading ? (
              <div className="p-5 text-sm text-muted-foreground">Loading closure history...</div>
            ) : periodClosures?.closures?.length ? (
              <div className="divide-y">
                {periodClosures.closures.map((closure: any) => (
                  <details key={closure.id} className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-muted/40">
                      <div><span className="font-medium">{formatCommissionMonth(closure.periodStart || closure.period_start)}</span><span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${closure.status === 'closed' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{closure.status}</span></div>
                      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>Moved forward: {formatMoney(closure.totalUnpaid || 0)}</span><span>Recovery: {formatMoney(closure.totalRecovery || 0)}</span><span>{closure.status === 'reopened' ? `Reopened ${formatCommissionTimestamp(closure.reopenedAt)}` : `Closed ${formatCommissionTimestamp(closure.closedAt || closure.closed_at)}`}</span></div>
                    </summary>
                    <div className="border-t bg-muted/20 px-4 py-4 text-sm">
                      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <div><dt className="text-xs text-muted-foreground">Period</dt><dd className="font-medium">{formatCommissionMonth(closure.periodStart || closure.period_start)}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Closed by</dt><dd className="font-medium">{closure.closedByName || closure.closed_by_name || 'System record'}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Carried credit</dt><dd className="font-medium">{formatMoney(closure.totalUnpaid || 0)}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Recovery carried</dt><dd className="font-medium">{formatMoney(closure.totalRecovery || 0)}</dd></div>
                      </dl>
                      <div className="mt-3"><span className="text-xs text-muted-foreground">Reason</span><p className="mt-1">{closure.reason}</p></div>
                      {closure.status === 'reopened' && <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3"><span className="text-xs text-muted-foreground">Undo reason</span><p>{closure.reopenReason}</p></div>}
                      {closure.balances?.length > 0 && (
                        <MobileTableScroll label="period closure balances" className="mt-4 rounded border bg-card">
                          <table className="w-full text-xs">
                            <thead className="bg-muted"><tr><th className="px-3 py-2 text-left">Salesperson</th><th className="px-3 py-2 text-right">Approved credit</th><th className="px-3 py-2 text-right">Approved deductions</th><th className="px-3 py-2 text-right">Settled</th><th className="px-3 py-2 text-right">Closing balance</th></tr></thead>
                            <tbody>{closure.balances.map((balance: any) => <tr key={balance.id || balance.salespersonId} className="border-t"><td className="px-3 py-2">{balance.salespersonName || balance.salespersonId}</td><td className="px-3 py-2 text-right">{formatMoney(balance.approvedCredits || 0)}</td><td className="px-3 py-2 text-right">{formatMoney(balance.approvedDeductions || 0)}</td><td className="px-3 py-2 text-right">{formatMoney(balance.paidAmount || 0)}</td><td className="px-3 py-2 text-right font-medium">{balance.closingBalance < 0 ? `Recovery ${formatMoney(Math.abs(balance.closingBalance))}` : formatMoney(balance.closingBalance || 0)}</td></tr>)}</tbody>
                          </table>
                        </MobileTableScroll>
                      )}
                      {isAdministrativeRole && closure.status === 'closed' && <button type="button" disabled={reopenPeriodMutation.isPending} className="mt-4 rounded border border-red-300 px-3 py-2 text-xs font-medium text-red-700 disabled:opacity-50" onClick={() => { const reason = prompt(`Reason for undoing the ${formatCommissionMonth(closure.periodStart || closure.period_start)} close?`); if (reason?.trim() && confirm('Undo this close and remove its unsettled carry-forward entries?')) reopenPeriodMutation.mutate({ period: String(closure.periodStart || closure.period_start).slice(0, 7), reason: reason.trim() }) }}>Undo close</button>}
                    </div>
                  </details>
                ))}
              </div>
            ) : (
              <div className="p-5 text-sm text-muted-foreground">No commission periods have been closed yet.</div>
            )}
          </div>
        </section>
      )}

      {activeTab === 'settings' && canManage && (
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6">
            <h3 className="font-semibold mb-1">Programme status and module availability</h3>
            <p className="text-xs text-muted-foreground mb-4">Suspending or disabling stops new earnings from the effective time. Existing history, reversals, approvals and settlements remain available.</p>
            {programme?.current ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-3 w-3 rounded-full ${programme.current.status === 'active' ? 'bg-emerald-500' : programme.current.status === 'suspended' ? 'bg-amber-500' : 'bg-red-500'}`} />
                  <span className="font-medium capitalize">{programme.current.status}</span>
                </div>
                <p className="text-sm text-muted-foreground">Effective from (Nairobi): {formatCommissionTimestamp(programme.current.effective_from)}</p>
                {programme.current.reason && <p className="text-sm text-muted-foreground">Reason: {programme.current.reason}</p>}
              </div>
            ) : (
              <p className="text-muted-foreground">No programme configuration is available. A fresh installation includes a disabled KSh 50 global rate; if it was removed, add an explicit rate before activation.</p>
            )}
            <form className="mt-5 grid gap-3 border-t pt-4 md:grid-cols-4" onSubmit={async e => { e.preventDefault(); await programmeMutation.mutateAsync({ ...programmeForm, effective_to: null }) }}>
              <div><label className="block text-xs font-medium mb-1">New status</label><select className="w-full border rounded px-2 py-2 text-sm" value={programmeForm.status} onChange={e => setProgrammeForm({ ...programmeForm, status: e.target.value })}><option value="active">Active / Reactivate</option><option value="suspended">Suspended temporarily</option><option value="disabled">Disabled until reactivated</option></select></div>
              <div><label className="block text-xs font-medium mb-1">Effective date</label><input required type="date" className="w-full border rounded px-2 py-2 text-sm" value={programmeForm.effective_from} onChange={e => setProgrammeForm({ ...programmeForm, effective_from: e.target.value })} /></div>
              <div><label className="block text-xs font-medium mb-1">Reason {programmeForm.status !== 'active' || programmeForm.effective_from < today ? '(required)' : ''}</label><input required={programmeForm.status !== 'active' || programmeForm.effective_from < today} className="w-full border rounded px-2 py-2 text-sm" placeholder="For example: commission introduced on 1 August" value={programmeForm.reason} onChange={e => setProgrammeForm({ ...programmeForm, reason: e.target.value })} /></div>
              <div className="flex items-end"><button disabled={programmeMutation.isPending} className={`w-full rounded px-3 py-2 text-sm text-white ${programmeForm.status === 'disabled' ? 'bg-red-600' : programmeForm.status === 'suspended' ? 'bg-amber-600' : 'bg-emerald-600'}`}>{programmeMutation.isPending ? 'Saving…' : programmeForm.status === 'active' ? 'Activate programme' : programmeForm.status === 'suspended' ? 'Suspend programme' : 'Disable programme'}</button></div>
            </form>
            {programmeMutation.isError && <p className="mt-2 text-sm text-red-600">{(programmeMutation.error as any)?.response?.data?.error?.message || 'Unable to update programme status'}</p>}
            {programme?.history?.length > 0 && <details className="mt-4"><summary className="cursor-pointer text-sm font-medium">View status history ({programme.history.length})</summary><div className="mt-2 space-y-2">{programme.history.map((event: any) => <div key={event.id} className="flex flex-wrap justify-between gap-2 rounded border p-2 text-xs"><span className="font-medium capitalize">{event.status}</span><span>{formatCommissionTimestamp(event.effective_from)}</span><span className="text-muted-foreground">{event.reason || 'No reason entered'}</span></div>)}</div></details>}
          </div>

          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Rates</h3>
                <button
                  onClick={() => { setShowRateForm(!showRateForm); setEditingRate(null); setRateForm({ scope_type: 'global', scope_id: '', scope_name: '', rate_per_item: '', effective_from: today, effective_to: '' }) }}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Plus className="h-3 w-3" />
                  Add Rate
                </button>
              </div>
            </div>

            {showRateForm && (
              <div className="border-b bg-muted/30">
                <form
                  onSubmit={async (e) => {
                    e.preventDefault()
                    const payload = {
                      rate_per_item: Number(rateForm.rate_per_item),
                      scope_type: rateForm.scope_type,
                      scope_id: rateForm.scope_id || null,
                      scope_name: rateForm.scope_name || null,
                      effective_from: rateForm.effective_from,
                      effective_to: rateForm.effective_to || null,
                    }
                    try {
                      if (editingRate) {
                        await updateRateMutation.mutateAsync({ id: editingRate.id, data: payload })
                      } else {
                        await createRateMutation.mutateAsync(payload)
                      }
                    } catch {
                      // error is surfaced via toast in real app
                    }
                  }}
                  className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 p-4"
                >
                  <div>
                    <label className="block text-xs font-medium mb-1">Scope</label>
                    <select
                      value={rateForm.scope_type}
                      onChange={(e) => setRateForm({ ...rateForm, scope_type: e.target.value, scope_id: '', scope_name: '' })}
                      className="w-full border rounded px-2 py-1 text-sm"
                    >
                      {SCOPE_TYPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>

                  {rateForm.scope_type === 'category' && (
                    <div>
                      <label className="block text-xs font-medium mb-1">Category</label>
                      <select
                        value={rateForm.scope_id}
                        onChange={(e) => {
                          const cat = categories?.find((c: any) => c.id === e.target.value)
                          setRateForm({ ...rateForm, scope_id: e.target.value, scope_name: cat?.name || '' })
                        }}
                        className="w-full border rounded px-2 py-1 text-sm"
                      >
                        <option value="">All categories</option>
                        {categories?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  )}

                  {rateForm.scope_type === 'product' && (
                    <div>
                      <label className="block text-xs font-medium mb-1">Product</label>
                      <select
                        value={rateForm.scope_id}
                        onChange={(e) => {
                          const prod = products?.find((p: any) => p.id === e.target.value)
                          setRateForm({ ...rateForm, scope_id: e.target.value, scope_name: prod?.name || '' })
                        }}
                        className="w-full border rounded px-2 py-1 text-sm"
                      >
                        <option value="">Select product</option>
                        {products?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                  )}

                  {rateForm.scope_type === 'salesperson' && (
                    <div>
                      <label className="block text-xs font-medium mb-1">Salesperson</label>
                      <select
                        value={rateForm.scope_id}
                        onChange={(e) => {
                          const sp = salespeople?.find((s: any) => s.id === e.target.value)
                          setRateForm({ ...rateForm, scope_id: e.target.value, scope_name: sp?.full_name || sp?.name || '' })
                        }}
                        className="w-full border rounded px-2 py-1 text-sm"
                      >
                        <option value="">Select salesperson</option>
                        {salespeople?.map((s: any) => <option key={s.id} value={s.id}>{s.full_name || s.name}</option>)}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium mb-1">Rate per item (KSh)</label>
                    <input
                      type="number" step="0.01" min="0"
                      value={rateForm.rate_per_item}
                      onChange={(e) => setRateForm({ ...rateForm, rate_per_item: e.target.value })}
                      className="w-full border rounded px-2 py-1 text-sm"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium mb-1">Effective from order date</label>
                    <input
                      type="date"
                      value={rateForm.effective_from}
                      onChange={(e) => setRateForm({ ...rateForm, effective_from: e.target.value })}
                      className="w-full border rounded px-2 py-1 text-sm"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium mb-1">Effective to order date</label>
                    <input
                      type="date"
                      value={rateForm.effective_to}
                      onChange={(e) => setRateForm({ ...rateForm, effective_to: e.target.value })}
                      className="w-full border rounded px-2 py-1 text-sm"
                    />
                  </div>

                  <div className="flex items-end gap-2">
                    <button
                      type="submit"
                      disabled={createRateMutation.isPending || updateRateMutation.isPending}
                      className="px-3 py-1 bg-primary text-primary-foreground rounded text-xs hover:bg-primary/90 disabled:opacity-50"
                    >
                      {editingRate ? 'Update' : 'Create'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowRateForm(false); setEditingRate(null) }}
                      className="px-3 py-1 border rounded text-xs hover:bg-muted"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}

            {rates?.rates?.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">No rates configured</div>
            ) : (
              <MobileTableScroll label="commission rates">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left px-4 py-3">Scope</th>
                      <th className="text-right px-4 py-3">Rate</th>
                      <th className="text-left px-4 py-3">Effective From</th>
                      <th className="text-left px-4 py-3">Effective To</th>
                      {canManage && <th className="center px-4 py-3">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rates?.rates?.map((rate: any) => (
                      <tr key={rate.id} className="border-t hover:bg-muted/40">
                        <td className="px-4 py-3 capitalize">{rate.scope_type}{rate.scope_name ? `: ${rate.scope_name}` : ''}</td>
                        <td className="px-4 py-3 text-right">{formatMoney(rate.rate_per_item)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">{formatCommissionTimestamp(rate.effective_from)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">{rate.effective_to ? formatCommissionTimestamp(rate.effective_to) : '-'}</td>
                        {canManage && (
                          <td className="px-4 py-3 text-center">
                            <div className="flex items-center justify-center gap-2">
                              <button
                                onClick={() => {
                                  setEditingRate(rate)
                                  setRateForm({
                                    scope_type: rate.scope_type || 'global',
                                    scope_id: rate.scope_id || '',
                                    scope_name: rate.scope_name || '',
                                    rate_per_item: String(rate.rate_per_item),
                                    effective_from: rate.effective_from ? nairobiBusinessDate(rate.effective_from) : today,
                                    effective_to: rate.effective_to ? nairobiBusinessDate(rate.effective_to) : '',
                                  })
                                  setShowRateForm(true)
                                }}
                                className="text-xs text-blue-600 hover:underline"
                              >
                                Edit
                              </button>
                              <button
                                onClick={async () => {
                                  if (confirm('End this rate now? Historical transactions and rate history will remain unchanged.')) {
                                    await deleteRateMutation.mutateAsync(rate.id)
                                  }
                                }}
                                className="text-xs text-red-600 hover:underline"
                              >
                                End rate
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </MobileTableScroll>
            )}
          </div>

          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Retroactive reconciliation</h3>
                <button
                  onClick={() => setShowRetroForm(!showRetroForm)}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {showRetroForm ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {showRetroForm ? 'Hide' : 'Run'}
                </button>
              </div>
            </div>
            {showRetroForm && (
              <div className="border-t p-4 space-y-4">
                <form
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (!retroDates.date_from || !retroDates.date_to) return
                    setRetroResult(null)
                    await retroMutation.mutateAsync({ ...retroDates, apply: false })
                  }}
                  className="grid grid-cols-1 md:grid-cols-3 gap-4"
                >
                  <div>
                    <label className="block text-xs font-medium mb-1">Order date from</label>
                    <input type="date" name="date_from" value={retroDates.date_from} onChange={e => setRetroDates({ ...retroDates, date_from: e.target.value })} className="w-full border rounded px-2 py-1 text-sm" required />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Order date to</label>
                    <input type="date" name="date_to" value={retroDates.date_to} onChange={e => setRetroDates({ ...retroDates, date_to: e.target.value })} className="w-full border rounded px-2 py-1 text-sm" required />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="submit"
                      disabled={retroMutation.isPending}
                      className="w-full px-3 py-1 bg-primary text-primary-foreground rounded text-xs hover:bg-primary/90 disabled:opacity-50"
                    >
                      {retroMutation.isPending ? 'Checking completed sales…' : 'Preview calculation'}
                    </button>
                  </div>
                </form>
                {retroMutation.isError && (
                  <div className="text-sm text-red-600">Error: {(retroMutation.error as any)?.response?.data?.error?.message || retroMutation.error?.message || 'Failed to evaluate commissions'}</div>
                )}
                {retroResult && (
                  <div className="space-y-3 pt-2 border-t">
                    <div className="grid gap-3 sm:grid-cols-4">
                      <StatCard title="Orders scanned" description="All orders checked in the selected date range." value={String(retroResult.totalOrdersScanned || 0)} icon={<Users className="h-5 w-5" />} />
                      <StatCard title="Items evaluated" description="Order items checked against commission rules and completion evidence." value={String(retroResult.totalItemsEvaluated || 0)} icon={<BarChart3 className="h-5 w-5" />} />
                      <StatCard title="Eligible missing items" description="Items that meet the rules but do not yet have a commission record." value={String(retroResult.eligibleItems || 0)} icon={<Target className="h-5 w-5" />} />
                      <StatCard title="Calculated amount" description="Commission that would be added for missing eligible items only. Preview does not change records." value={formatMoney(retroResult.totalCommissionAmount || 0)} icon={<Wallet className="h-5 w-5" />} />
                    </div>
                    <div className="rounded border bg-muted/20 p-3 text-sm">The order sale date selects the commission programme and rate. Completed status unlocks the earning, and the completion date determines the commission month. Speedaf COD becomes completed only after full remittance.</div>
                    {retroResult.issues?.length > 0 && <div className="rounded border border-red-200 bg-red-50/40 p-3 text-sm"><h4 className="font-medium">Ledger exceptions requiring attention ({retroResult.issuesFound || retroResult.issues.length})</h4><div className="mt-2 max-h-56 space-y-2 overflow-auto">{retroResult.issues.map((issue: any, index: number) => <div key={`${issue.type}-${issue.transactionId || issue.orderItemId || index}`}><span className="font-medium capitalize">{String(issue.type).replaceAll('_', ' ')}</span><span className="text-muted-foreground"> — {issue.message}</span></div>)}</div></div>}
                    {retroResult.details?.length > 0 && (
                      <div>
                        <h4 className="font-medium text-sm mb-2">Evaluation details</h4>
                        <MobileTableScroll label="retroactive evaluation">
                          <table className="w-full text-xs">
                            <thead className="bg-muted">
                              <tr>
                                <th className="text-left px-3 py-2">Order</th>
                                <th className="text-left px-3 py-2">Sale date</th>
                                <th className="text-left px-3 py-2">Completion date</th>
                                <th className="text-left px-3 py-2">Salesperson</th>
                                <th className="text-left px-3 py-2">Product</th>
                                <th className="text-right px-3 py-2">Qty</th>
                                <th className="text-right px-3 py-2">Rate</th>
                                <th className="text-right px-3 py-2">Amount</th>
                                <th className="text-left px-3 py-2">Qualification source</th>
                                <th className="text-left px-3 py-2">Result</th>
                              </tr>
                            </thead>
                            <tbody>
                              {retroResult.details.map((d: any) => (
                                <tr key={d.orderItemId} className="border-t">
                                  <td className="px-3 py-2">{d.orderNumber}</td>
                                  <td className="px-3 py-2">{d.saleDate || '-'}</td>
                                  <td className="px-3 py-2">{d.qualificationDate || '-'}</td>
                                  <td className="px-3 py-2">{d.salespersonName}</td>
                                  <td className="px-3 py-2">{d.productName}</td>
                                  <td className="px-3 py-2 text-right">{d.quantity}</td>
                                  <td className="px-3 py-2 text-right">{formatMoney(d.rate)}</td>
                                  <td className="px-3 py-2 text-right font-medium">{formatMoney(d.amount)}</td>
                                  <td className="px-3 py-2">{String(d.qualificationSource || '-').replaceAll('_', ' ')}</td>
                                  <td className="px-3 py-2">{d.created ? 'Created' : d.alreadyEarned ? 'Already recorded' : d.eligible ? 'Ready to apply' : d.reason}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </MobileTableScroll>
                      </div>
                    )}
                    {retroResult.mode === 'preview' && canReconcile && (retroResult.eligibleItems > 0 || retroResult.issues?.some((issue: any) => issue.type === 'missing_reversal')) && (
                      <div className="rounded border border-amber-200 bg-amber-50/50 p-4 space-y-3">
                        <div><h4 className="font-medium">Apply reviewed reconciliation</h4><p className="text-xs text-muted-foreground">This creates supported missing earnings and required return/refund reversals as one audited, all-or-nothing run. Rate/date/period mismatches remain review-only.</p></div>
                        <input className="w-full border rounded px-2 py-2 text-sm" placeholder="Mandatory reason for the retroactive run" value={retroReason} onChange={e => setRetroReason(e.target.value)} />
                        <button disabled={!retroReason.trim() || retroMutation.isPending} onClick={() => retroMutation.mutate({ ...retroDates, apply: true, reason: retroReason })} className="rounded bg-amber-700 px-3 py-2 text-xs text-white disabled:opacity-50">Apply reviewed reconciliation</button>
                      </div>
                    )}
                    {retroResult.mode === 'preview' && !canReconcile && <p className="text-xs text-muted-foreground">You can preview this result. A user with commission.reconcile must apply changes.</p>}
                    {retroResult.details?.length === 0 && retroResult.commissionsEarned === 0 && (
                      <p className="text-sm text-muted-foreground">No commission eligible items found for the selected date range.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b">
              <h3 className="font-semibold">Product and category eligibility</h3>
              <p className="text-xs text-muted-foreground">With no rules, products with a valid rate are eligible. Once an active rule exists, only explicitly included products/categories qualify; product exclusions override category inclusions.</p>
            </div>
            <form className="grid gap-3 border-b bg-muted/20 p-4 md:grid-cols-6" onSubmit={async e => { e.preventDefault(); await eligibilityMutation.mutateAsync(editingEligibility ? { ...eligibilityForm, id: editingEligibility.id } : eligibilityForm) }}>
              <select className="border rounded px-2 py-2 text-sm" value={eligibilityForm.scope_type} onChange={e => setEligibilityForm({ ...eligibilityForm, scope_type: e.target.value, scope_id: '', scope_name: '' })}><option value="category">Category</option><option value="product">Product</option></select>
              <select required className="border rounded px-2 py-2 text-sm" value={eligibilityForm.scope_id} onChange={e => {
                const source = eligibilityForm.scope_type === 'category' ? categories : products
                const selected = source?.find((item: any) => item.id === e.target.value)
                setEligibilityForm({ ...eligibilityForm, scope_id: e.target.value, scope_name: selected?.name || '' })
              }}><option value="">Select {eligibilityForm.scope_type}</option>{(eligibilityForm.scope_type === 'category' ? categories : products)?.map((item: any) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
              <select className="border rounded px-2 py-2 text-sm" value={String(eligibilityForm.is_eligible)} onChange={e => setEligibilityForm({ ...eligibilityForm, is_eligible: e.target.value === 'true' })}><option value="true">Include — eligible</option><option value="false">Exclude — not eligible</option></select>
              <input required type="date" title="First eligible order date" className="border rounded px-2 py-2 text-sm" value={eligibilityForm.effective_from} onChange={e => setEligibilityForm({ ...eligibilityForm, effective_from: e.target.value })} />
              <input type="date" title="Last eligible order date" className="border rounded px-2 py-2 text-sm" value={eligibilityForm.effective_to} onChange={e => setEligibilityForm({ ...eligibilityForm, effective_to: e.target.value })} />
              <div className="flex gap-2"><button disabled={eligibilityMutation.isPending} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">{editingEligibility ? 'Save replacement' : 'Add eligibility rule'}</button>{editingEligibility && <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => { setEditingEligibility(null); setEligibilityForm({ scope_type: 'category', scope_id: '', scope_name: '', is_eligible: true, effective_from: today, effective_to: '' }) }}>Cancel</button>}</div>
            </form>
            {eligibility?.eligibility?.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">No eligibility rules configured</div>
            ) : (
              <MobileTableScroll label="eligibility rules">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left px-4 py-3">Scope</th>
                      <th className="text-left px-4 py-3">Name</th>
                      <th className="text-center px-4 py-3">Eligible</th>
                      <th className="text-left px-4 py-3">Effective From</th>
                      <th className="text-left px-4 py-3">Effective To</th>
                      <th className="text-center px-4 py-3">Actions</th>
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
                        <td className="px-4 py-3 whitespace-nowrap">{formatCommissionTimestamp(item.effective_from)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">{item.effective_to ? formatCommissionTimestamp(item.effective_to) : '-'}</td>
                        <td className="px-4 py-3 text-center"><div className="flex justify-center gap-2"><button className="text-xs text-blue-600 hover:underline" onClick={() => { setEditingEligibility(item); setEligibilityForm({ scope_type: item.scope_type, scope_id: item.scope_id, scope_name: item.scope_name, is_eligible: item.is_eligible, effective_from: item.effective_from ? nairobiBusinessDate(item.effective_from) : today, effective_to: item.effective_to ? nairobiBusinessDate(item.effective_to) : '' }) }}>Replace</button><button className="text-xs text-red-600 hover:underline" onClick={() => { if (confirm('End this eligibility rule now? Historical commission stays unchanged.')) endEligibilityMutation.mutate(item.id) }}>End</button></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </MobileTableScroll>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ title, description, value, icon }: { title: string; description?: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">{title}</div>
        <div className="rounded-lg bg-primary/10 p-2 text-primary">{icon}</div>
      </div>
      <div className="mt-2 text-xl font-bold">{value}</div>
      {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
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
