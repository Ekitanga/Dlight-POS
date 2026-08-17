import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, Truck, CheckCircle, Clock, AlertCircle, X, Eye, Banknote, ExternalLink, type LucideIcon } from 'lucide-react'
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
  const { hasPermission } = useAuthStore()
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
    }
  })
  const deliveries = deliveryPage?.data || []

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

  const onStatusUpdate = (data: StatusFormData) => {
    if (selectedDelivery) {
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
      </div>

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
            <div className="md:col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={updateStatus.isPending || !nextOrderStatus(selectedDelivery)}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
              >
                {updateStatus.isPending ? 'Updating...' : 'Update Status'}
              </button>
              <button
                type="button"
                onClick={() => { setShowStatusForm(false); setSelectedDelivery(null) }}
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
                <th className="text-left px-4 py-3 font-medium">Order #</th>
                <th className="text-left px-4 py-3 font-medium">Customer</th>
                <th className="text-left px-4 py-3 font-medium">Handled By</th>
                <th className="text-left px-4 py-3 font-medium">Destination</th>
                <th className="text-left px-4 py-3 font-medium">Order Status</th>
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
                    <td className="px-4 py-3">{formatMoney(customerDeliveryFee(delivery))}</td>
                    <td className="px-4 py-3">{formatMoney(actualDeliveryCost(delivery))}</td>
                    <td className={`px-4 py-3 font-medium ${deliveryMargin(delivery) < 0 ? 'text-destructive' : deliveryMargin(delivery) > 0 ? 'text-emerald-600' : ''}`}>
                      {formatMoney(deliveryMargin(delivery))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {hasPermission('deliveries.manage') && <button
                          onClick={() => {
                            setSelectedDelivery(delivery)
                            setShowStatusForm(true)
                            setRemittanceAmount(delivery.cod_outstanding ? String(delivery.cod_outstanding) : '')
                            setRemittanceReference('')
                            setRemittanceError('')
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
