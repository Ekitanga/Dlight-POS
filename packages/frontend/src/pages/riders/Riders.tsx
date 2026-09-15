import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus, Search, Edit, Eye, Truck, Trash2, CreditCard, X } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useAuthStore } from '../../stores/authStore'
import { formatMoney } from '../../lib/format'
import { Pagination } from '../../components/Pagination'

interface Rider {
  id: string
  name: string
  phone: string
  national_id?: string
  balance: number
}

interface RiderFormData {
  name: string
  phone: string
  national_id: string
  notes: string
}

interface PaymentFormData {
  amount: number
  payment_method: string
  reference: string
  notes: string
}

interface RiderDelivery {
  id: string
  order_id: string
  order_number: string
  order_status: string
  delivery_status: string
  created_at: string
  delivered_at: string | null
  customer_name: string | null
  delivery_location: string | null
  location_source: 'order' | 'customer' | 'missing'
  rider_fee: number
  recorded_earning: number
}

interface RiderDeliveryResponse {
  data: RiderDelivery[]
  summary: {
    total_earnings: number
    total_payments: number
    balance: number
  }
}

function formatRiderAmount(value: unknown) {
  return `KES ${new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))}`
}

function RiderDeliveryBreakdown({ riderId }: { riderId: string }) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const { data, isLoading, error } = useQuery<RiderDeliveryResponse>({
    queryKey: ['rider-deliveries', riderId],
    queryFn: async () => (await axios.get(`/api/riders/${riderId}/deliveries`)).data
  })

  if (isLoading) return <p className="p-4 text-sm text-muted-foreground">Loading rider deliveries...</p>
  if (error || !data) return <p className="p-4 text-sm text-destructive">Unable to load rider deliveries.</p>

  const totalPages = Math.max(1, Math.ceil(data.data.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const visibleDeliveries = data.data.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const deliveryEarnings = data.data.reduce((sum, delivery) => sum + Number(delivery.recorded_earning || 0), 0)
  const otherEarnings = Number(data.summary.total_earnings || 0) - deliveryEarnings

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-semibold">Rider deliveries</h3>
        <p className="text-sm text-muted-foreground">Each delivery shows its rider fee and the earning recorded toward the rider balance.</p>
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-lg border p-3"><span className="text-muted-foreground">Earnings recorded</span><strong className="mt-1 block">{formatRiderAmount(data.summary.total_earnings)}</strong></div>
        <div className="rounded-lg border p-3"><span className="text-muted-foreground">Payments recorded</span><strong className="mt-1 block">{formatRiderAmount(data.summary.total_payments)}</strong></div>
        <div className="rounded-lg border p-3"><span className="text-muted-foreground">Balance owed</span><strong className="mt-1 block">{formatRiderAmount(data.summary.balance)}</strong></div>
      </div>
      {otherEarnings > 0.005 && <p className="text-sm text-muted-foreground">{formatRiderAmount(otherEarnings)} of the earnings total is not linked to a delivery.</p>}
      <p className="text-xs text-muted-foreground">Location comes from the order delivery address, or the customer address when the order has none. A separate confirmed drop-off location is not recorded.</p>
      <p className="text-xs text-muted-foreground">Rider payments reduce the overall balance; they are not assigned to individual deliveries.</p>
      {data.data.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">No deliveries recorded for this rider.</p>
      ) : (
        <div className="mobile-scroll-table overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[920px] text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Order</th>
                <th className="px-3 py-2 text-left font-medium">Customer</th>
                <th className="px-3 py-2 text-left font-medium">Delivery location</th>
                <th className="px-3 py-2 text-left font-medium">Recorded</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Rider fee</th>
                <th className="px-3 py-2 text-right font-medium">Recorded earning</th>
              </tr>
            </thead>
            <tbody>
              {visibleDeliveries.map(delivery => (
                <tr key={delivery.id} className="border-t">
                  <td className="px-3 py-2"><Link to={`/orders?order_id=${delivery.order_id}`} className="font-medium text-primary hover:underline">{delivery.order_number}</Link></td>
                  <td className="px-3 py-2">{delivery.customer_name || '-'}</td>
                  <td className="max-w-72 break-words px-3 py-2">
                    {delivery.delivery_location || <span className="text-destructive">Location not recorded</span>}
                    {delivery.delivery_location && <span className="mt-0.5 block text-xs text-muted-foreground">{delivery.location_source === 'order' ? 'Order address' : 'Customer address'}</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {new Date(delivery.created_at).toLocaleDateString('en-KE')}
                    {delivery.delivered_at && <span className="mt-0.5 block text-xs text-muted-foreground">Delivered {new Date(delivery.delivered_at).toLocaleDateString('en-KE')}</span>}
                  </td>
                  <td className="px-3 py-2 capitalize">
                    {delivery.order_status.replaceAll('_', ' ')}
                    <span className="block text-xs text-muted-foreground">Delivery: {delivery.delivery_status.replaceAll('_', ' ')}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{formatRiderAmount(delivery.rider_fee)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium">{formatRiderAmount(delivery.recorded_earning)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            meta={{ page: currentPage, pageSize, total: data.data.length, totalPages }}
            onPageChange={setPage}
            onPageSizeChange={size => { setPageSize(size); setPage(1) }}
            pageSizeOptions={[10, 25, 50, 100]}
          />
        </div>
      )}
    </section>
  )
}

export function Riders() {
  const { hasPermission } = useAuthStore()
  const [searchParams] = useSearchParams()
  const outstandingOnly = searchParams.get('filter') === 'outstanding'
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingRider, setEditingRider] = useState<Rider | null>(null)
  const [viewingRider, setViewingRider] = useState<Rider | null>(null)
  const [payingRider, setPayingRider] = useState<Rider | null>(null)
  const [paymentError, setPaymentError] = useState('')
  const queryClient = useQueryClient()

  const { data: riders = [], isLoading, error } = useQuery<Rider[]>({
    queryKey: ['riders', search],
    queryFn: async () => {
      const response = await axios.get(`/api/riders?search=${search}`)
      return response.data
    }
  })
  const displayedRiders = outstandingOnly ? riders.filter(rider => Number(rider.balance || 0) > 0) : riders

  const { register, handleSubmit, reset, formState: { errors } } = useForm<RiderFormData>()
  const paymentForm = useForm<PaymentFormData>()

  const createRider = useMutation({
    mutationFn: async (data: RiderFormData) => {
      const response = await axios.post('/api/riders', data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['riders'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setShowForm(false)
      reset()
    }
  })

  const updateRider = useMutation({
    mutationFn: async (data: RiderFormData) => {
      const response = await axios.put(`/api/riders/${editingRider?.id}`, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['riders'] })
      setEditingRider(null)
      setShowForm(false)
      reset()
    }
  })

  const deleteRider = useMutation({
    mutationFn: async (id: string) => {
      await axios.delete(`/api/riders/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['riders'] })
    }
  })

  const recordPayment = useMutation({
    mutationFn: async (data: PaymentFormData) => {
      if (!payingRider) return null
      const response = await axios.post(`/api/riders/${payingRider.id}/payments`, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['riders'] })
      queryClient.invalidateQueries({ queryKey: ['rider-deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setPayingRider(null)
      setPaymentError('')
      paymentForm.reset()
    },
    onError: (error: any) => {
      setPaymentError(error.response?.data?.error?.message || 'Failed to record payment')
    }
  })

  const handleFormSubmit = (data: RiderFormData) => {
    if (editingRider) {
      updateRider.mutate(data)
    } else {
      createRider.mutate(data)
    }
  }

  const handleEdit = (rider: Rider) => {
    setEditingRider(rider)
    reset({
      name: rider.name,
      phone: rider.phone,
      national_id: rider.national_id || '',
      notes: ''
    })
    setShowForm(true)
  }

  const openPayment = (rider: Rider) => {
    setPayingRider(rider)
    setPaymentError('')
    paymentForm.reset({
      amount: rider.balance || 0,
      payment_method: 'cash',
      reference: '',
      notes: ''
    })
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground">Failed to load riders</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Riders</h1>
          <p className="text-muted-foreground">Manage delivery riders and settlements</p>
        </div>
        {hasPermission('riders.manage') && <button 
          onClick={() => { setShowForm(true); setEditingRider(null); reset() }}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Rider
        </button>}
      </div>

      {showForm && (
        <div className="border rounded-lg p-6 bg-card">
          <h2 className="font-semibold mb-4">{editingRider ? 'Edit' : 'Add'} Rider</h2>
          <form onSubmit={handleSubmit(handleFormSubmit)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input
                {...register('name', { required: 'Name is required' })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Rider name"
              />
              {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Phone *</label>
              <input
                {...register('phone', { required: 'Phone is required' })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="0712345678"
              />
              {errors.phone && <span className="text-xs text-destructive">{errors.phone.message}</span>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">National ID</label>
              <input
                {...register('national_id')}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="12345678"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea
                {...register('notes')}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Additional notes"
                rows={2}
              />
            </div>
            <div className="md:col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={createRider.isPending || updateRider.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
              >
                {editingRider ? 'Update' : 'Create'} Rider
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingRider(null) }}
                className="px-4 py-2 border rounded-lg"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search riders..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
        />
      </div>

      {outstandingOnly && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"><strong>Outstanding filter active.</strong> Showing riders with payments due.</div>}

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : displayedRiders.length === 0 ? (
        <div className="text-center py-16">
          <Truck className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No riders found</h3>
          <p className="text-muted-foreground mt-1">
            {search ? 'Try adjusting your search' : 'Add your first rider'}
          </p>
        </div>
      ) : (
        <div className="mobile-scroll-table border rounded-lg overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Phone</th>
                <th className="text-left px-4 py-3 font-medium">National ID</th>
                <th className="text-left px-4 py-3 font-medium">Balance</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedRiders.map(rider => (
                <tr key={rider.id} className="border-t hover:bg-muted/50 transition-colors">
                  <td className="px-4 py-3 font-medium">{rider.name}</td>
                  <td className="px-4 py-3 text-sm">{rider.phone || '-'}</td>
                  <td className="px-4 py-3 text-sm">{rider.national_id || '-'}</td>
                  <td className={`px-4 py-3 font-medium ${(rider.balance || 0) > 0 ? 'text-destructive' : 'text-green-600'}`}>
                    {formatMoney(rider.balance)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setViewingRider(rider)}
                        className="p-1.5 text-muted-foreground hover:text-primary rounded"
                        title="View rider deliveries and earnings"
                        aria-label={`View deliveries for ${rider.name}`}
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      {hasPermission('riders.pay') && <button
                        type="button"
                        onClick={() => openPayment(rider)}
                        className="p-1.5 text-muted-foreground hover:text-green-600 rounded"
                        title="Record rider payment"
                      >
                        <CreditCard className="h-4 w-4" />
                      </button>}
                      {hasPermission('riders.manage') && <button 
                        onClick={() => handleEdit(rider)}
                        className="p-1.5 text-muted-foreground hover:text-primary rounded"
                      >
                        <Edit className="h-4 w-4" />
                      </button>}
                      {hasPermission('riders.manage') && <button 
                        onClick={() => deleteRider.mutate(rider.id)}
                        className="p-1.5 text-muted-foreground hover:text-destructive rounded"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {viewingRider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">{viewingRider.name}</h2>
                <p className="text-sm text-muted-foreground">Rider details</p>
              </div>
              <button type="button" onClick={() => setViewingRider(null)} className="rounded p-1.5 text-muted-foreground hover:text-foreground" title="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-5 overflow-y-auto p-6 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <div><span className="text-muted-foreground">Phone:</span> {viewingRider.phone || '-'}</div>
                <div><span className="text-muted-foreground">National ID:</span> {viewingRider.national_id || '-'}</div>
              </div>
              <RiderDeliveryBreakdown key={viewingRider.id} riderId={viewingRider.id} />
            </div>
          </div>
        </div>
      )}

      {payingRider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">Record Rider Payment</h2>
                <p className="text-sm text-muted-foreground">Review deliveries and balance for {payingRider.name} before paying.</p>
              </div>
              <button type="button" onClick={() => setPayingRider(null)} className="rounded p-1.5 text-muted-foreground hover:text-foreground" title="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto p-6">
              <RiderDeliveryBreakdown key={payingRider.id} riderId={payingRider.id} />
              <form onSubmit={paymentForm.handleSubmit(data => recordPayment.mutate(data))} className="mt-6 space-y-4 border-t pt-5">
                <div>
                  <label className="block text-sm font-medium mb-1">Amount Paid</label>
                  <input type="number" step="0.01" {...paymentForm.register('amount', { required: true, valueAsNumber: true, min: 0.01 })} className="w-full px-3 py-2 border rounded-lg" placeholder="Amount paid" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Payment Method</label>
                  <select {...paymentForm.register('payment_method')} className="w-full px-3 py-2 border rounded-lg">
                    <option value="cash">Cash</option>
                    <option value="mpesa">M-PESA</option>
                    <option value="bank_transfer">Bank</option>
                  </select>
                </div>
                <input {...paymentForm.register('reference')} className="w-full px-3 py-2 border rounded-lg" placeholder="Reference number" />
                <textarea {...paymentForm.register('notes')} className="w-full px-3 py-2 border rounded-lg" placeholder="Payment notes" rows={2} />
                {paymentError && <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{paymentError}</div>}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setPayingRider(null)} className="px-4 py-2 border rounded-lg">Cancel</button>
                  <button type="submit" disabled={recordPayment.isPending} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50">
                    {recordPayment.isPending ? 'Recording...' : 'Record Payment'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
