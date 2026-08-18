import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, Truck, CheckCircle, Clock, AlertCircle, X, Eye, Banknote, ExternalLink, RefreshCw, type LucideIcon } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useAuthStore } from '../../stores/authStore'
import { formatMoney } from '../../lib/format'
import { PaginatedResponse, Pagination } from '../../components/Pagination'
import { DateRangeFilter } from '../../components/DateRangeFilter'
import { invalidateCommissionData } from '../../lib/commissionCache'

interface Delivery {
  id: string
  order_id: string
  order_number?: string
  customer_name?: string
  rider_id?: string
  rider_name?: string
  courier_id?: string
  courier_name?: string
  courier_tracking_number?: string
  tracking_url?: string
  delivery_destination?: string
  delivery_status: string
  delivery_fee: number
  earned_amount: number
  delivery_income?: number
  delivery_cost?: number
  courier_customer_fee?: number
  courier_actual_fee?: number
  delivered_at?: string
  tracking_provider?: string
  tracking_provider_status?: string
  tracking_message?: string
  tracking_event_at?: string
  tracking_checked_at?: string
  tracking_sync_error?: string
  tracking_auto_updated_at?: string
  notes: string
  created_at: string
  order_status?: string
  workflow_status?: string
  delivery_type?: string
  courier_payment_type?: string
  delivery_fee_payment_method?: string
  payment_status?: string
  cod_status?: string
  cod_amount?: number
  remitted_amount?: number
  cod_outstanding?: number
}

interface StatusFormData {
  delivery_status: string
  earned_amount: number
  notes: string
}

interface TrackingConfig {
  configured: boolean
  automatic: boolean
  interval_minutes: number
}

interface SpeedafPaymentBatch {
  id: string
  batch_number: string
  payment_date: string
  payment_method: string
  net_amount: number
  gross_amount: number
  fee_amount: number
  status: 'pending_approval' | 'approved' | 'rejected'
  created_by_name?: string
  approved_by_name?: string
  rejection_reason?: string
  allocations: Array<{ order_id: string; order_number: string; tracking_number?: string; gross_amount: number }>
}

function nairobiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date())
}

const workflowStatuses = [
  'pending',
  'confirmed',
  'in_transit',
  'pending_payment',
  'completed',
  'returned',
  'cancelled'
] as const

type WorkflowStatus = typeof workflowStatuses[number]

const workflowOptions: Array<{ value: WorkflowStatus; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'in_transit', label: 'Dispatched / In Transit' },
  { value: 'pending_payment', label: 'Pending Payment' },
  { value: 'completed', label: 'Completed' },
  { value: 'returned', label: 'Returned' },
  { value: 'cancelled', label: 'Cancelled' }
]

const workflowPresentation: Record<WorkflowStatus, { label: string; className: string; Icon: LucideIcon }> = {
  pending: {
    label: 'Pending',
    className: 'bg-amber-100 text-amber-950 ring-1 ring-inset ring-amber-300 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-700',
    Icon: Clock
  },
  confirmed: {
    label: 'Confirmed',
    className: 'bg-sky-100 text-sky-950 ring-1 ring-inset ring-sky-300 dark:bg-sky-950/60 dark:text-sky-200 dark:ring-sky-700',
    Icon: CheckCircle
  },
  in_transit: {
    label: 'Dispatched / In Transit',
    className: 'bg-indigo-100 text-indigo-950 ring-1 ring-inset ring-indigo-300 dark:bg-indigo-950/60 dark:text-indigo-200 dark:ring-indigo-700',
    Icon: Truck
  },
  pending_payment: {
    label: 'Pending Payment',
    className: 'bg-orange-100 text-orange-950 ring-1 ring-inset ring-orange-300 dark:bg-orange-950/60 dark:text-orange-200 dark:ring-orange-700',
    Icon: Banknote
  },
  completed: {
    label: 'Completed',
    className: 'bg-emerald-100 text-emerald-950 ring-1 ring-inset ring-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-200 dark:ring-emerald-700',
    Icon: CheckCircle
  },
  returned: {
    label: 'Returned',
    className: 'bg-rose-100 text-rose-950 ring-1 ring-inset ring-rose-300 dark:bg-rose-950/60 dark:text-rose-200 dark:ring-rose-700',
    Icon: AlertCircle
  },
  cancelled: {
    label: 'Cancelled',
    className: 'bg-slate-200 text-slate-950 ring-1 ring-inset ring-slate-400 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600',
    Icon: X
  }
}

const deliveryStateLabels: Record<string, string> = {
  assigned: 'Assigned',
  in_transit: 'In transit',
  delivered: 'Delivered to client',
  collected_paid: 'Collected & paid',
  returned: 'Returned',
  cancelled: 'Cancelled'
}

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === 'string' && workflowStatuses.includes(value as WorkflowStatus)
}

function workflowStatusForDelivery(delivery: Delivery): WorkflowStatus {
  if (isWorkflowStatus(delivery.workflow_status)) return delivery.workflow_status

  const orderStatus = delivery.order_status
  if (orderStatus === 'pending') return 'pending'
  if (orderStatus === 'confirmed' || orderStatus === 'packed') return 'confirmed'
  if (orderStatus === 'in_transit' || orderStatus === 'dispatched') return 'in_transit'
  if (orderStatus === 'returned') return 'returned'
  if (orderStatus === 'cancelled') return 'cancelled'
  if (orderStatus === 'collected_paid') return 'completed'
  if (orderStatus === 'delivered') {
    return delivery.courier_payment_type === 'cod' ? 'pending_payment' : 'completed'
  }

  // The API normally supplies workflow_status. This fallback keeps a legacy
  // response readable without falsely marking an unpaid COD delivery complete.
  if (delivery.delivery_status === 'collected_paid') return 'completed'
  if (delivery.delivery_status === 'in_transit') return 'in_transit'
  if (delivery.delivery_status === 'returned') return 'returned'
  if (delivery.delivery_status === 'cancelled') return 'cancelled'
  if (delivery.delivery_status === 'delivered') {
    return delivery.courier_payment_type === 'cod' ? 'pending_payment' : 'completed'
  }
  return 'pending'
}

function deliveryStateLabel(delivery: Delivery) {
  return deliveryStateLabels[delivery.delivery_status] || delivery.delivery_status.replace(/_/g, ' ')
}

function TrackingLink({ trackingNumber, trackingUrl }: { trackingNumber?: string; trackingUrl?: string }) {
  const cleanedTrackingNumber = trackingNumber?.trim()
  if (!cleanedTrackingNumber) return null

  if (!trackingUrl) {
    return <span className="break-all text-muted-foreground">{cleanedTrackingNumber}</span>
  }

  return (
    <a
      href={trackingUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
      title={`Track ${cleanedTrackingNumber}`}
    >
      <span className="truncate">{cleanedTrackingNumber}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
    </a>
  )
}

export function Deliveries() {
  const { hasPermission, user } = useAuthStore()
  const [searchParams] = useSearchParams()
  const codOnly = searchParams.get('view') === 'cod'
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selectedWorkflowStatus, setSelectedWorkflowStatus] = useState('')
  const [selectedStatus, setSelectedStatus] = useState('')
  const [selectedDelivery, setSelectedDelivery] = useState<Delivery | null>(null)
  const [showStatusForm, setShowStatusForm] = useState(false)
  const [remittanceAmount, setRemittanceAmount] = useState('')
  const [remittanceReference, setRemittanceReference] = useState('')
  const [remittanceError, setRemittanceError] = useState('')
  const [completionPaymentMethod, setCompletionPaymentMethod] = useState('cash')
  const [speedafDeliveryConfirmed, setSpeedafDeliveryConfirmed] = useState(false)
  const [trackingFeedback, setTrackingFeedback] = useState<{ orderId?: string; message: string; error: boolean } | null>(null)
  const [showBulkPayment, setShowBulkPayment] = useState(false)
  const [selectedBulkOrderIds, setSelectedBulkOrderIds] = useState<Set<string>>(new Set())
  const [bulkNetAmount, setBulkNetAmount] = useState('')
  const [bulkPaymentDate, setBulkPaymentDate] = useState(nairobiToday())
  const [bulkPaymentMethod, setBulkPaymentMethod] = useState('bank_transfer')
  const [bulkReference, setBulkReference] = useState('')
  const [bulkNotes, setBulkNotes] = useState('')
  const [bulkMessage, setBulkMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const queryClient = useQueryClient()

  const { data: deliveryPage, isLoading, error } = useQuery<PaginatedResponse<Delivery>>({
    queryKey: ['deliveries', search, dateFrom, dateTo, selectedWorkflowStatus, selectedStatus, codOnly, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      if (selectedWorkflowStatus) params.set('workflow_stage', selectedWorkflowStatus)
      if (selectedStatus) params.set('status', selectedStatus)
      if (codOnly) params.set('cod_outstanding', 'true')
      params.set('page', String(page))
      params.set('page_size', String(pageSize))
      const response = await axios.get(`/api/deliveries?${params.toString()}`)
      return response.data
    },
    refetchInterval: 60_000
  })
  const deliveries = deliveryPage?.data || []

  const { data: trackingConfig } = useQuery<TrackingConfig>({
    queryKey: ['speedaf-tracking-config'],
    queryFn: async () => (await axios.get('/api/deliveries/tracking/config')).data,
    staleTime: 5 * 60_000,
    retry: false
  })

  const { data: speedafBatches = [] } = useQuery<SpeedafPaymentBatch[]>({
    queryKey: ['speedaf-payment-batches'],
    queryFn: async () => (await axios.get('/api/deliveries/cod/batches')).data,
    enabled: showBulkPayment && hasPermission('cod.view')
  })

  const { register: registerStatus, handleSubmit: handleSubmitStatus, reset: resetStatus } = useForm<StatusFormData>({
    defaultValues: {
      delivery_status: 'assigned',
      earned_amount: 0,
      notes: ''
    }
  })

  const updateStatus = useMutation({
    mutationFn: async (data: StatusFormData & { order_id: string }) => {
      const response = await axios.put(`/api/orders/${data.order_id}/status`, {
        status: data.delivery_status,
        notes: data.notes,
        completion_payment_method: completionPaymentMethod
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      void invalidateCommissionData(queryClient)
      setShowStatusForm(false)
      setSelectedDelivery(null)
      setSpeedafDeliveryConfirmed(false)
      resetStatus()
    }
  })

  const recordRemittance = useMutation({
    mutationFn: async () => {
      if (!selectedDelivery) return
      const amount = Number(remittanceAmount)
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Enter the amount received from Speedaf')
      }
      await axios.post(`/api/deliveries/orders/${selectedDelivery.order_id}/cod`, {
        amount,
        reference: remittanceReference
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      void invalidateCommissionData(queryClient)
      setRemittanceAmount('')
      setRemittanceReference('')
      setRemittanceError('')
      setShowStatusForm(false)
      setSelectedDelivery(null)
    },
    onError: (error: any) => {
      setRemittanceError(error.response?.data?.error?.message || error.message || 'Failed to record Speedaf payment')
    }
  })

  const refreshTracking = useMutation({
    mutationFn: async (orderId?: string) => {
      const endpoint = orderId
        ? `/api/deliveries/orders/${orderId}/tracking/sync`
        : '/api/deliveries/tracking/sync'
      const response = await axios.post(endpoint)
      return { ...response.data, orderId }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setTrackingFeedback({
        orderId: result.orderId,
        error: false,
        message: result.movedToPendingPayment
          ? `${result.movedToPendingPayment} order${result.movedToPendingPayment === 1 ? '' : 's'} moved to Pending Payment.`
          : `Checked ${result.checked} tracking number${result.checked === 1 ? '' : 's'}. No new delivery collections found.`
      })
    },
    onError: (error: any, orderId) => {
      setTrackingFeedback({
        orderId,
        error: true,
        message: error.response?.data?.error?.message || error.message || 'Unable to refresh Speedaf tracking'
      })
    }
  })

  const bulkGrossAmount = deliveries
    .filter(delivery => selectedBulkOrderIds.has(delivery.order_id))
    .reduce((sum, delivery) => sum + Number(delivery.cod_outstanding || 0), 0)
  const parsedBulkNetAmount = Number(bulkNetAmount || 0)
  const calculatedBulkFee = Math.max(0, Math.round((bulkGrossAmount - parsedBulkNetAmount) * 100) / 100)
  const bulkDifference = Math.round((bulkGrossAmount - parsedBulkNetAmount - calculatedBulkFee) * 100) / 100
  const bulkSelectionCovered = parsedBulkNetAmount > 0 && bulkGrossAmount >= parsedBulkNetAmount
  const bulkFeeRate = bulkGrossAmount > 0 ? calculatedBulkFee / bulkGrossAmount : 0

  const createSpeedafBatch = useMutation({
    mutationFn: async () => (await axios.post('/api/deliveries/cod/batches', {
      order_ids: Array.from(selectedBulkOrderIds),
      net_amount: parsedBulkNetAmount,
      payment_date: bulkPaymentDate,
      payment_method: bulkPaymentMethod,
      external_reference: bulkReference.trim(),
      notes: bulkNotes.trim(),
      approve_now: ['admin', 'owner'].includes(user?.role || '')
    })).data,
    onSuccess: (batch) => {
      const approved = batch.status === 'approved'
      setBulkMessage({
        error: false,
        text: approved
          ? `${batch.batch_number} approved. ${batch.completed_orders} orders completed and the Speedaf fee was recorded.`
          : `${batch.batch_number} submitted for manager approval.`
      })
      setSelectedBulkOrderIds(new Set())
      setBulkNetAmount('')
      setBulkReference('')
      setBulkNotes('')
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['speedaf-payment-batches'] })
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      void invalidateCommissionData(queryClient)
    },
    onError: (error: any) => setBulkMessage({
      error: true,
      text: error.response?.data?.error?.message || error.message || 'Unable to record Speedaf payment'
    })
  })

  const approveSpeedafBatch = useMutation({
    mutationFn: async (batchId: string) => (await axios.post(`/api/deliveries/cod/batches/${batchId}/approve`)).data,
    onSuccess: () => {
      setBulkMessage({ error: false, text: 'Speedaf payment batch approved.' })
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['speedaf-payment-batches'] })
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      void invalidateCommissionData(queryClient)
    },
    onError: (error: any) => setBulkMessage({ error: true, text: error.response?.data?.error?.message || 'Unable to approve batch' })
  })

  const rejectSpeedafBatch = useMutation({
    mutationFn: async ({ batchId, reason }: { batchId: string; reason: string }) =>
      (await axios.post(`/api/deliveries/cod/batches/${batchId}/reject`, { reason })).data,
    onSuccess: () => {
      setBulkMessage({ error: false, text: 'Speedaf payment batch rejected.' })
      queryClient.invalidateQueries({ queryKey: ['speedaf-payment-batches'] })
    },
    onError: (error: any) => setBulkMessage({ error: true, text: error.response?.data?.error?.message || 'Unable to reject batch' })
  })

  const onStatusUpdate = (data: StatusFormData) => {
    if (selectedDelivery) {
      const needsSpeedafConfirmation =
        nextOrderStatus(selectedDelivery) === 'delivered' &&
        selectedDelivery.courier_payment_type === 'cod' &&
        selectedDelivery.courier_name?.toLowerCase().includes('speedaf')
      if (needsSpeedafConfirmation && !speedafDeliveryConfirmed) return
      updateStatus.mutate({ ...data, order_id: selectedDelivery.order_id })
    }
  }

  const deliveryHandler = (delivery: Delivery) => {
    if (delivery.rider_name) return delivery.rider_name
    if (delivery.courier_name) return delivery.courier_name
    return '-'
  }

  const deliveryDestination = (delivery: Delivery) => {
    return delivery.delivery_destination || delivery.courier_tracking_number || delivery.customer_name || '-'
  }

  const customerDeliveryFee = (delivery: Delivery) => {
    if (delivery.courier_name) {
      return Number(delivery.courier_customer_fee ?? delivery.delivery_fee ?? 0)
    }
    return Number(delivery.delivery_fee ?? delivery.delivery_income ?? 0)
  }

  const actualDeliveryCost = (delivery: Delivery) => {
    if (delivery.courier_name) {
      return Number(delivery.courier_actual_fee ?? delivery.earned_amount ?? delivery.delivery_cost ?? 0)
    }
    return Number(delivery.earned_amount ?? delivery.delivery_cost ?? 0)
  }

  const isCourierPassThroughFee = (delivery: Delivery) => {
    return Boolean(
      (delivery.courier_id || delivery.courier_name) &&
      ['paid_to_courier', 'pay_on_delivery'].includes(delivery.delivery_fee_payment_method || '')
    )
  }

  const deliveryMargin = (delivery: Delivery) => {
    if (isCourierPassThroughFee(delivery)) return 0
    const income = Number(delivery.delivery_income ?? customerDeliveryFee(delivery) ?? 0)
    const cost = Number(delivery.delivery_cost ?? actualDeliveryCost(delivery) ?? 0)
    return income - cost
  }

  const nextOrderStatus = (delivery: Delivery) => {
    const status = delivery.order_status
    if (status === 'pending') return 'confirmed'
    if (status === 'confirmed' || status === 'packed') {
      return delivery.delivery_type === 'walk_in' ? 'delivered' : 'in_transit'
    }
    if (status === 'in_transit' || status === 'dispatched') return 'delivered'
    return ''
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground">Failed to load deliveries</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Deliveries</h1>
          <p className="text-muted-foreground">Track deliveries created from orders</p>
        </div>
        {hasPermission('cod.remit') && (
          <button
            type="button"
            onClick={() => {
              setShowBulkPayment(value => !value)
              setSelectedWorkflowStatus('pending_payment')
              setSelectedStatus('')
              setPage(1)
              setBulkMessage(null)
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            <Banknote className="h-4 w-4" />
            {showBulkPayment ? 'Close Payment' : 'Record Speedaf Payment'}
          </button>
        )}
      </div>

      {showBulkPayment && hasPermission('cod.remit') && (
        <section className="rounded-xl border border-primary/30 bg-primary/5 p-4 sm:p-5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Record Speedaf Payment</h2>
              <p className="text-sm text-muted-foreground">Select the paid orders below. The difference between their COD total and the bank amount is recorded as the Speedaf fee.</p>
            </div>
            <span className="text-sm font-medium">{selectedBulkOrderIds.size} order{selectedBulkOrderIds.size === 1 ? '' : 's'} selected</span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm">Amount received
              <input type="number" min="0.01" step="0.01" value={bulkNetAmount} onChange={event => setBulkNetAmount(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" placeholder="Bank amount" />
            </label>
            <label className="text-sm">Payment date
              <input type="date" value={bulkPaymentDate} onChange={event => setBulkPaymentDate(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" />
            </label>
            <label className="text-sm">Received via
              <select value={bulkPaymentMethod} onChange={event => setBulkPaymentMethod(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2">
                <option value="bank_transfer">Bank</option>
                <option value="mpesa">M-PESA</option>
              </select>
            </label>
            <label className="text-sm">Bank narration/reference <span className="text-muted-foreground">(optional)</span>
              <input value={bulkReference} onChange={event => setBulkReference(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" placeholder="If available" />
            </label>
          </div>

          <div className="mt-4 grid gap-3 rounded-lg border bg-background p-3 sm:grid-cols-4">
            <div><div className="text-xs text-muted-foreground">Orders selected</div><strong>{selectedBulkOrderIds.size}</strong></div>
            <div><div className="text-xs text-muted-foreground">Expected from Speedaf</div><strong>{formatMoney(bulkGrossAmount)}</strong></div>
            <div><div className="text-xs text-muted-foreground">Amount received</div><strong>{formatMoney(parsedBulkNetAmount)}</strong></div>
            <div><div className="text-xs text-muted-foreground">Speedaf fee</div><strong>{formatMoney(calculatedBulkFee)}</strong></div>
          </div>
          <p className={`mt-2 text-sm ${bulkFeeRate > 0.1 ? 'text-destructive' : 'text-muted-foreground'}`}>
            {parsedBulkNetAmount <= 0
              ? 'Enter the amount received before selecting orders.'
              : !bulkSelectionCovered
                ? `${formatMoney(parsedBulkNetAmount - bulkGrossAmount)} still needs to be covered by the paid orders.`
                : bulkFeeRate > 0.1
                  ? 'The calculated fee is unusually high. Remove an incorrect order or check the bank amount.'
                  : 'The received amount is covered. Remaining orders are locked to prevent over-selection.'}
          </p>
          <label className="mt-3 block text-sm">Notes <span className="text-muted-foreground">(optional)</span>
            <input value={bulkNotes} onChange={event => setBulkNotes(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" placeholder="Payment or reconciliation notes" />
          </label>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {['admin', 'owner'].includes(user?.role || '')
                ? 'Confirmation will complete the selected orders and record the fee expense.'
                : 'This will be submitted for manager verification before orders and commissions are updated.'}
            </p>
            <button
              type="button"
              onClick={() => createSpeedafBatch.mutate()}
              disabled={createSpeedafBatch.isPending || selectedBulkOrderIds.size === 0 || parsedBulkNetAmount <= 0 || parsedBulkNetAmount > bulkGrossAmount || bulkDifference !== 0 || bulkFeeRate > 0.1}
              className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createSpeedafBatch.isPending ? 'Recording...' : ['admin', 'owner'].includes(user?.role || '') ? 'Confirm Bulk Payment' : 'Submit for Approval'}
            </button>
          </div>
          {bulkMessage && <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${bulkMessage.error ? 'bg-destructive/10 text-destructive' : 'bg-emerald-100 text-emerald-900'}`}>{bulkMessage.text}</div>}

          {speedafBatches.some(batch => batch.status === 'pending_approval') && (
            <div className="mt-5 border-t pt-4">
              <h3 className="font-medium">Awaiting manager approval</h3>
              <div className="mt-2 space-y-2">
                {speedafBatches.filter(batch => batch.status === 'pending_approval').map(batch => (
                  <div key={batch.id} className="flex flex-col gap-2 rounded-lg border bg-background p-3 text-sm lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <strong>{batch.batch_number}</strong>
                      <span className="ml-2 text-muted-foreground">{batch.allocations.length} orders · Gross {formatMoney(batch.gross_amount)} · Received {formatMoney(batch.net_amount)} · Fee {formatMoney(batch.fee_amount)}</span>
                      <div className="mt-1 text-xs text-muted-foreground">Prepared by {batch.created_by_name || 'User'} on {new Date(batch.payment_date).toLocaleDateString()}</div>
                    </div>
                    {['admin', 'owner'].includes(user?.role || '') && (
                      <div className="flex gap-2">
                        <button type="button" onClick={() => approveSpeedafBatch.mutate(batch.id)} disabled={approveSpeedafBatch.isPending} className="rounded bg-emerald-700 px-3 py-1.5 text-white disabled:opacity-50">Approve</button>
                        <button type="button" onClick={() => {
                          const reason = window.prompt('Reason for rejecting this Speedaf payment batch')?.trim()
                          if (reason) rejectSpeedafBatch.mutate({ batchId: batch.id, reason })
                        }} disabled={rejectSpeedafBatch.isPending} className="rounded border border-destructive px-3 py-1.5 text-destructive disabled:opacity-50">Reject</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {selectedDelivery && showStatusForm && hasPermission('deliveries.manage') && (
        <div className="border rounded-lg p-6 bg-card">
          <h2 className="font-semibold mb-1">Advance Order Workflow</h2>
          <p className="mb-4 text-sm text-muted-foreground">Delivery state updates follow the same controlled order workflow as the Orders page.</p>
          <form onSubmit={handleSubmitStatus(onStatusUpdate)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Next order status</label>
              {nextOrderStatus(selectedDelivery) ? <select
                {...registerStatus('delivery_status')}
                className="w-full px-3 py-2 border rounded-lg"
              >
                {nextOrderStatus(selectedDelivery) === 'confirmed'
                  ? <option value="confirmed">Confirm Order</option>
                  : nextOrderStatus(selectedDelivery) === 'in_transit'
                    ? <option value="in_transit">Dispatch / Mark In Transit</option>
                    : <option value="delivered">{selectedDelivery.courier_payment_type === 'cod' ? 'Client Collected - Await Payment' : 'Delivered - Complete Order'}</option>}
              </select> : <div className="rounded-lg border bg-muted px-3 py-2 text-sm">
                {selectedDelivery.courier_payment_type === 'cod' && selectedDelivery.delivery_status === 'delivered'
                  ? 'Waiting for courier remittance'
                  : 'No further delivery action required'}
              </div>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Provider Charge</label>
              <div className="rounded-lg border bg-muted px-3 py-2">{formatMoney(actualDeliveryCost(selectedDelivery))}</div>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea
                {...registerStatus('notes')}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Status update notes"
                rows={2}
              />
            </div>
            {nextOrderStatus(selectedDelivery) === 'delivered' &&
              selectedDelivery.courier_payment_type === 'cod' &&
              selectedDelivery.courier_name?.toLowerCase().includes('speedaf') && (
                <div className="md:col-span-2 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-950">
                  <p className="font-medium">Confirm delivery before continuing</p>
                  <p className="mt-1 text-orange-900/80">
                    Open the tracking link and confirm that the parcel was delivered and the customer payment was collected by Speedaf.
                  </p>
                  <div className="mt-3">
                    <TrackingLink
                      trackingNumber={selectedDelivery.courier_tracking_number}
                      trackingUrl={selectedDelivery.tracking_url}
                    />
                  </div>
                  <label className="mt-3 flex cursor-pointer items-start gap-2 font-medium">
                    <input
                      type="checkbox"
                      checked={speedafDeliveryConfirmed}
                      onChange={event => setSpeedafDeliveryConfirmed(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-orange-400"
                    />
                    <span>I confirm the parcel was delivered and collected.</span>
                  </label>
                </div>
              )}
            <div className="md:col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={
                  updateStatus.isPending ||
                  !nextOrderStatus(selectedDelivery) ||
                  (nextOrderStatus(selectedDelivery) === 'delivered' &&
                    selectedDelivery.courier_payment_type === 'cod' &&
                    selectedDelivery.courier_name?.toLowerCase().includes('speedaf') &&
                    !speedafDeliveryConfirmed)
                }
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
              >
                {updateStatus.isPending
                  ? 'Updating...'
                  : nextOrderStatus(selectedDelivery) === 'delivered' && selectedDelivery.courier_payment_type === 'cod'
                    ? 'Move to Pending Payment'
                    : 'Update Status'}
              </button>
              <button
                type="button"
                onClick={() => { setShowStatusForm(false); setSelectedDelivery(null); setSpeedafDeliveryConfirmed(false) }}
                className="px-4 py-2 border rounded-lg"
              >
                Cancel
              </button>
            </div>
          </form>
          {nextOrderStatus(selectedDelivery) === 'delivered' && selectedDelivery.rider_id && selectedDelivery.payment_status !== 'paid' && (
            <div className="mt-4 max-w-sm">
              <label className="block text-sm font-medium mb-1">Payment Received Via</label>
              <select value={completionPaymentMethod} onChange={event => setCompletionPaymentMethod(event.target.value)} className="w-full rounded-lg border px-3 py-2">
                <option value="cash">Cash</option>
                <option value="mpesa">M-PESA</option>
                <option value="bank_transfer">Bank</option>
              </select>
            </div>
          )}
          {hasPermission('cod.remit') && selectedDelivery.courier_payment_type === 'cod' && selectedDelivery.delivery_status === 'delivered' && (
            <div className="mt-6 border-t pt-5">
              <div className="mb-3">
                <h3 className="font-medium">Record Speedaf Payment</h3>
                <p className="text-sm text-muted-foreground">
                  Outstanding: {formatMoney(selectedDelivery.cod_outstanding)}
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={remittanceAmount}
                  onChange={event => setRemittanceAmount(event.target.value)}
                  className="px-3 py-2 border rounded-lg"
                  placeholder="Amount received"
                />
                <input
                  value={remittanceReference}
                  onChange={event => setRemittanceReference(event.target.value)}
                  className="px-3 py-2 border rounded-lg"
                  placeholder="M-Pesa or bank reference"
                />
                <button
                  type="button"
                  onClick={() => recordRemittance.mutate()}
                  disabled={recordRemittance.isPending}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
                >
                  <Banknote className="h-4 w-4" />
                  {recordRemittance.isPending ? 'Recording...' : 'Record Payment'}
                </button>
              </div>
              {remittanceError && <p className="mt-2 text-sm text-destructive">{remittanceError}</p>}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search deliveries..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasPermission('deliveries.manage') && trackingConfig?.configured && (
            <button
              type="button"
              onClick={() => { setTrackingFeedback(null); refreshTracking.mutate(undefined) }}
              disabled={refreshTracking.isPending}
              className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
              title="Check all active Speedaf tracking numbers"
            >
              <RefreshCw className={`h-4 w-4 ${refreshTracking.isPending ? 'animate-spin' : ''}`} />
              Check Speedaf updates
            </button>
          )}
          <select
            value={selectedWorkflowStatus}
            onChange={(event) => { setSelectedWorkflowStatus(event.target.value); setPage(1) }}
            aria-label="Filter by order workflow status"
            className="px-3 py-2 border rounded-lg"
          >
            <option value="">All order statuses</option>
            {workflowOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select
            value={selectedStatus}
            onChange={(event) => { setSelectedStatus(event.target.value); setPage(1) }}
            aria-label="Filter by delivery operation status"
            className="px-3 py-2 border rounded-lg"
          >
            <option value="">All delivery states</option>
            <option value="assigned">Assigned</option>
            <option value="in_transit">In Transit</option>
            <option value="delivered">Delivered to Client</option>
            <option value="collected_paid">Collected & Paid</option>
            <option value="returned">Returned</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <DateRangeFilter
            dateFrom={dateFrom}
            dateTo={dateTo}
            compact
            includeClear={false}
            onChange={range => { setDateFrom(range.dateFrom); setDateTo(range.dateTo); setPage(1) }}
          />
          {(dateFrom || dateTo || selectedWorkflowStatus || selectedStatus) && (
            <button type="button" onClick={() => { setDateFrom(''); setDateTo(''); setSelectedWorkflowStatus(''); setSelectedStatus('') }} className="px-3 py-2 border rounded-lg text-sm">
              Clear filters
            </button>
          )}
        </div>
      </div>
      {trackingFeedback && !trackingFeedback.orderId && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${trackingFeedback.error ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-emerald-300 bg-emerald-50 text-emerald-900'}`}>
          {trackingFeedback.message}
        </div>
      )}
      {codOnly && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"><strong>Outstanding COD filter active.</strong> Showing courier deliveries awaiting remittance.</div>}
      <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        Delivery fee shows what the client was charged. Provider charge shows the rider or courier cost. Business margin is only the amount Dlight gains or loses from delivery handling.
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : deliveries.length === 0 ? (
        <div className="text-center py-16">
          <Truck className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No deliveries found</h3>
          <p className="text-muted-foreground mt-1">
            {search ? 'Try adjusting your search' : 'Assign your first delivery'}
          </p>
        </div>
      ) : (
        <div className="mobile-scroll-table border rounded-lg overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                {showBulkPayment && <th className="w-16 px-4 py-3 text-left font-medium">Select</th>}
                <th className="text-left px-4 py-3 font-medium">Order #</th>
                <th className="text-left px-4 py-3 font-medium">Customer</th>
                <th className="text-left px-4 py-3 font-medium">Handled By</th>
                <th className="text-left px-4 py-3 font-medium">Destination</th>
                <th className="text-left px-4 py-3 font-medium">Order Status</th>
                <th className="text-left px-4 py-3 font-medium">Expected from Speedaf</th>
                <th className="text-left px-4 py-3 font-medium">Customer Fee</th>
                <th className="text-left px-4 py-3 font-medium">Provider Charge</th>
                <th className="text-left px-4 py-3 font-medium">Business Margin</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery: any) => {
                const workflowStatus = workflowStatusForDelivery(delivery)
                const presentation = workflowPresentation[workflowStatus]
                const StatusIcon = presentation.Icon
                return (
                  <tr key={delivery.id} className="border-t hover:bg-muted/50 transition-colors">
                    {showBulkPayment && <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${delivery.order_number || 'order'} for Speedaf payment`}
                        checked={selectedBulkOrderIds.has(delivery.order_id)}
                        disabled={!selectedBulkOrderIds.has(delivery.order_id) && (parsedBulkNetAmount <= 0 || bulkSelectionCovered)}
                        onChange={event => setSelectedBulkOrderIds(previous => {
                          const next = new Set(previous)
                          if (event.target.checked) next.add(delivery.order_id)
                          else next.delete(delivery.order_id)
                          return next
                        })}
                        className="h-4 w-4 rounded disabled:cursor-not-allowed disabled:opacity-40"
                      />
                    </td>}
                    <td className="px-4 py-3 font-medium">{delivery.order_number || '-'}</td>
                    <td className="px-4 py-3 text-sm">{delivery.customer_name || '-'}</td>
                    <td className="px-4 py-3 text-sm">{deliveryHandler(delivery)}</td>
                    <td className="max-w-64 px-4 py-3 text-sm">
                      <span className="block truncate" title={deliveryDestination(delivery)}>
                        {deliveryDestination(delivery)}
                      </span>
                      {delivery.courier_tracking_number && (
                        <span className="mt-1 block max-w-full text-xs">
                          <TrackingLink trackingNumber={delivery.courier_tracking_number} trackingUrl={delivery.tracking_url} />
                        </span>
                      )}
                      {delivery.tracking_message && (
                        <span className="mt-1 block max-w-64 truncate text-xs text-muted-foreground" title={delivery.tracking_message}>
                          Latest: {delivery.tracking_message}
                        </span>
                      )}
                      {delivery.tracking_checked_at && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          Checked {new Date(delivery.tracking_checked_at).toLocaleString('en-KE')}
                        </span>
                      )}
                      {delivery.tracking_sync_error && (
                        <span className="mt-1 block max-w-64 text-xs text-destructive">{delivery.tracking_sync_error}</span>
                      )}
                      {trackingFeedback && trackingFeedback.orderId === delivery.order_id && (
                        <span className={`mt-1 block max-w-64 text-xs ${trackingFeedback.error ? 'text-destructive' : 'text-emerald-700'}`}>
                          {trackingFeedback.message}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${presentation.className}`}
                        title={`Order status: ${presentation.label}`}
                      >
                        <StatusIcon className="h-3 w-3" />
                        {presentation.label}
                      </span>
                      <p className="mt-1 text-xs text-muted-foreground">Delivery: {deliveryStateLabel(delivery)}</p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {delivery.courier_payment_type === 'cod' ? (
                        <div>
                          <span className="font-semibold">{formatMoney(delivery.cod_outstanding)}</span>
                          {Number(delivery.remitted_amount || 0) > 0 && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {formatMoney(delivery.remitted_amount)} already received
                            </span>
                          )}
                        </div>
                      ) : '-'}
                    </td>
                    <td className="px-4 py-3">{formatMoney(customerDeliveryFee(delivery))}</td>
                    <td className="px-4 py-3">{formatMoney(actualDeliveryCost(delivery))}</td>
                    <td className={`px-4 py-3 font-medium ${deliveryMargin(delivery) < 0 ? 'text-destructive' : deliveryMargin(delivery) > 0 ? 'text-emerald-600' : ''}`}>
                      {formatMoney(deliveryMargin(delivery))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {hasPermission('deliveries.manage') && trackingConfig?.configured && delivery.courier_tracking_number && delivery.courier_name?.toLowerCase().includes('speedaf') && (
                          <button
                            type="button"
                            onClick={() => { setTrackingFeedback(null); refreshTracking.mutate(delivery.order_id) }}
                            disabled={refreshTracking.isPending}
                            className="rounded p-1.5 text-muted-foreground hover:text-primary disabled:opacity-50"
                            title="Check this Speedaf tracking number now"
                            aria-label={`Check tracking for ${delivery.order_number || delivery.courier_tracking_number}`}
                          >
                            <RefreshCw className={`h-4 w-4 ${refreshTracking.isPending && refreshTracking.variables === delivery.order_id ? 'animate-spin' : ''}`} />
                          </button>
                        )}
                        {hasPermission('deliveries.manage') && <button
                          onClick={() => {
                            setSelectedDelivery(delivery)
                            setShowStatusForm(true)
                            setRemittanceAmount(delivery.cod_outstanding ? String(delivery.cod_outstanding) : '')
                            setRemittanceReference('')
                            setRemittanceError('')
                            setSpeedafDeliveryConfirmed(false)
                            resetStatus({
                              delivery_status: nextOrderStatus(delivery),
                              earned_amount: delivery.earned_amount || 0,
                              notes: delivery.notes || ''
                            })
                            setCompletionPaymentMethod('cash')
                          }}
                          className="p-1.5 text-muted-foreground hover:text-primary rounded"
                        >
                          <Eye className="h-4 w-4" />
                        </button>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {deliveryPage && <Pagination meta={deliveryPage.pagination} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} />}
        </div>
      )}
    </div>
  )
}
