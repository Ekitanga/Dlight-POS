import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Search, Edit, Eye, Truck, Trash2, CreditCard, X } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useAuthStore } from '../../stores/authStore'
import { formatMoney } from '../../lib/format'

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
                        title="View rider"
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
          <div className="w-full max-w-lg rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">{viewingRider.name}</h2>
                <p className="text-sm text-muted-foreground">Rider details</p>
              </div>
              <button type="button" onClick={() => setViewingRider(null)} className="rounded p-1.5 text-muted-foreground hover:text-foreground" title="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 p-6 text-sm">
              <div><span className="text-muted-foreground">Phone:</span> {viewingRider.phone || '-'}</div>
              <div><span className="text-muted-foreground">National ID:</span> {viewingRider.national_id || '-'}</div>
              <div className="text-base font-semibold">Balance: {formatMoney(viewingRider.balance)}</div>
            </div>
          </div>
        </div>
      )}

      {payingRider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">Record Rider Payment</h2>
                <p className="text-sm text-muted-foreground">{payingRider.name} is owed {formatMoney(payingRider.balance)}</p>
              </div>
              <button type="button" onClick={() => setPayingRider(null)} className="rounded p-1.5 text-muted-foreground hover:text-foreground" title="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={paymentForm.handleSubmit(data => recordPayment.mutate(data))} className="space-y-4 p-6">
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
      )}
    </div>
  )
}
