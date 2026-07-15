import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Search, Edit, Eye, PackageCheck, Trash2, CreditCard, X, History } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useAuthStore } from '../../stores/authStore'
import { formatMoney } from '../../lib/format'

interface Supplier {
  id: string
  name: string
  contact_person?: string
  phone?: string
  email?: string
  balance: number
}

interface SupplierFormData {
  name: string
  contact_person: string
  phone: string
  email: string
  address: string
}

interface SupplierPayable {
  id: string
  order_number?: string
  order_date: string
  product_name?: string
  sku?: string
  quantity?: number
  supplier_quantity?: number
  supplier_cost?: number
  description?: string
  amount: number
  paid_amount: number
  outstanding_amount: number
  status: string
}

interface SupplierPayment {
  id: string
  amount: number
  payment_method: string
  reference?: string
  notes?: string
  created_at: string
  order_number?: string
  product_name?: string
  quantity?: number
}

export function Suppliers() {
  const { hasPermission } = useAuthStore()
  const [searchParams] = useSearchParams()
  const outstandingOnly = searchParams.get('filter') === 'outstanding'
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null)
  const [viewingSupplier, setViewingSupplier] = useState<Supplier | null>(null)
  const [payingSupplier, setPayingSupplier] = useState<Supplier | null>(null)
  const [paymentTab, setPaymentTab] = useState<'pending' | 'history'>('pending')
  const [selectedPayables, setSelectedPayables] = useState<Record<string, string>>({})
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [paymentReference, setPaymentReference] = useState('')
  const [paymentNotes, setPaymentNotes] = useState('')
  const [paymentError, setPaymentError] = useState('')
  const queryClient = useQueryClient()

  const { data: suppliers = [], isLoading, error } = useQuery<Supplier[]>({
    queryKey: ['suppliers', search],
    queryFn: async () => {
      const response = await axios.get(`/api/suppliers?search=${search}`)
      return response.data
    }
  })
  const displayedSuppliers = outstandingOnly ? suppliers.filter(supplier => Number(supplier.balance || 0) > 0) : suppliers

  const { register, handleSubmit, reset, formState: { errors } } = useForm<SupplierFormData>()

  const { data: pendingPayables = [], isLoading: payablesLoading } = useQuery<SupplierPayable[]>({
    queryKey: ['supplier-payables', payingSupplier?.id],
    queryFn: async () => (await axios.get(`/api/suppliers/${payingSupplier?.id}/payables?status=pending`)).data,
    enabled: Boolean(payingSupplier)
  })
  const { data: paymentHistory = [], isLoading: historyLoading } = useQuery<SupplierPayment[]>({
    queryKey: ['supplier-payment-history', payingSupplier?.id],
    queryFn: async () => (await axios.get(`/api/suppliers/${payingSupplier?.id}/payment-history`)).data,
    enabled: Boolean(payingSupplier) && paymentTab === 'history'
  })

  const createSupplier = useMutation({
    mutationFn: async (data: SupplierFormData) => {
      const response = await axios.post('/api/suppliers', data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setShowForm(false)
      reset()
    }
  })

  const updateSupplier = useMutation({
    mutationFn: async (data: SupplierFormData) => {
      const response = await axios.put(`/api/suppliers/${editingSupplier?.id}`, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      setEditingSupplier(null)
      setShowForm(false)
      reset()
    }
  })

  const deleteSupplier = useMutation({
    mutationFn: async (id: string) => {
      await axios.delete(`/api/suppliers/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
    }
  })

  const recordPayment = useMutation({
    mutationFn: async () => {
      if (!payingSupplier) return null
      const allocations = Object.entries(selectedPayables).map(([payable_id, amount]) => ({
        payable_id,
        amount: Number(amount)
      }))
      const response = await axios.post(`/api/suppliers/${payingSupplier.id}/payments/allocate`, {
        allocations,
        payment_method: paymentMethod,
        reference: paymentReference || null,
        notes: paymentNotes || null
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      queryClient.invalidateQueries({ queryKey: ['supplier-payables', payingSupplier?.id] })
      queryClient.invalidateQueries({ queryKey: ['supplier-payment-history', payingSupplier?.id] })
      setSelectedPayables({})
      setPaymentReference('')
      setPaymentNotes('')
      setPaymentError('')
    },
    onError: (error: any) => {
      setPaymentError(error.response?.data?.error?.message || 'Failed to record payment')
    }
  })

  const handleFormSubmit = (data: SupplierFormData) => {
    if (editingSupplier) {
      updateSupplier.mutate(data)
    } else {
      createSupplier.mutate(data)
    }
  }

  const handleEdit = (supplier: Supplier) => {
    setEditingSupplier(supplier)
    reset({
      name: supplier.name,
      contact_person: supplier.contact_person || '',
      phone: supplier.phone || '',
      email: supplier.email || '',
      address: ''
    })
    setShowForm(true)
  }

  const openPayment = (supplier: Supplier) => {
    setPayingSupplier(supplier)
    setPaymentTab('pending')
    setSelectedPayables({})
    setPaymentMethod('cash')
    setPaymentReference('')
    setPaymentNotes('')
    setPaymentError('')
  }

  const selectedTotal = Object.values(selectedPayables).reduce((total, amount) => total + Number(amount || 0), 0)
  const allPayablesSelected = pendingPayables.length > 0 && pendingPayables.every(payable => selectedPayables[payable.id] !== undefined)
  const togglePayable = (payable: SupplierPayable) => {
    setSelectedPayables(current => {
      const next = { ...current }
      if (next[payable.id] !== undefined) delete next[payable.id]
      else next[payable.id] = String(Number(payable.outstanding_amount))
      return next
    })
    setPaymentError('')
  }
  const toggleAllPayables = () => {
    if (allPayablesSelected) {
      setSelectedPayables({})
    } else {
      setSelectedPayables(Object.fromEntries(
        pendingPayables.map(payable => [payable.id, String(Number(payable.outstanding_amount))])
      ))
    }
    setPaymentError('')
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground">Failed to load suppliers</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Suppliers</h1>
          <p className="text-muted-foreground">Manage supplier relationships and settlements</p>
        </div>
        {hasPermission('suppliers.manage') && <button 
          onClick={() => { setShowForm(true); setEditingSupplier(null); reset() }}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Supplier
        </button>}
      </div>

      {showForm && (
        <div className="border rounded-lg p-6 bg-card">
          <h2 className="font-semibold mb-4">{editingSupplier ? 'Edit' : 'Add'} Supplier</h2>
          <form onSubmit={handleSubmit(handleFormSubmit)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input
                {...register('name', { required: 'Name is required' })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Supplier name"
              />
              {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Contact Person</label>
              <input
                {...register('contact_person')}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Ahmed Hassan"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Phone</label>
              <input
                {...register('phone')}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="0712345678"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                {...register('email')}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="supplier@example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Address</label>
              <textarea
                {...register('address')}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Supplier address"
                rows={2}
              />
            </div>
            <div className="md:col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={createSupplier.isPending || updateSupplier.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
              >
                {editingSupplier ? 'Update' : 'Create'} Supplier
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingSupplier(null) }}
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
          placeholder="Search suppliers..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
        />
      </div>

      {outstandingOnly && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"><strong>Outstanding filter active.</strong> Showing suppliers with balances due.</div>}

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : displayedSuppliers.length === 0 ? (
        <div className="text-center py-16">
          <PackageCheck className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No suppliers found</h3>
          <p className="text-muted-foreground mt-1">
            {search ? 'Try adjusting your search' : 'Add your first supplier'}
          </p>
        </div>
      ) : (
        <div className="mobile-scroll-table border rounded-lg overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Contact</th>
                <th className="text-left px-4 py-3 font-medium">Phone</th>
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-left px-4 py-3 font-medium">Balance</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedSuppliers.map(supplier => (
                <tr key={supplier.id} className="border-t hover:bg-muted/50 transition-colors">
                  <td className="px-4 py-3 font-medium">{supplier.name}</td>
                  <td className="px-4 py-3 text-sm">{supplier.contact_person || '-'}</td>
                  <td className="px-4 py-3 text-sm">{supplier.phone || '-'}</td>
                  <td className="px-4 py-3 text-sm">{supplier.email || '-'}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => openPayment(supplier)}
                      className={`font-medium underline-offset-4 ${(supplier.balance || 0) > 0 ? 'text-destructive hover:underline' : 'cursor-default text-green-600'}`}
                      title={(supplier.balance || 0) > 0 ? 'View pending supplier items' : 'No supplier balance due'}
                    >
                      {formatMoney(supplier.balance)}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setViewingSupplier(supplier)}
                        className="p-1.5 text-muted-foreground hover:text-primary rounded"
                        title="View supplier"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      {hasPermission('suppliers.pay') && <button
                        type="button"
                        onClick={() => openPayment(supplier)}
                        className="p-1.5 text-muted-foreground hover:text-green-600 rounded"
                        title="Record supplier payment"
                      >
                        <CreditCard className="h-4 w-4" />
                      </button>}
                      {hasPermission('suppliers.manage') && <button 
                        onClick={() => handleEdit(supplier)}
                        className="p-1.5 text-muted-foreground hover:text-primary rounded"
                      >
                        <Edit className="h-4 w-4" />
                      </button>}
                      {hasPermission('suppliers.manage') && <button 
                        onClick={() => deleteSupplier.mutate(supplier.id)}
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

      {viewingSupplier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">{viewingSupplier.name}</h2>
                <p className="text-sm text-muted-foreground">Supplier details</p>
              </div>
              <button type="button" onClick={() => setViewingSupplier(null)} className="rounded p-1.5 text-muted-foreground hover:text-foreground" title="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 p-6 text-sm">
              <div><span className="text-muted-foreground">Contact:</span> {viewingSupplier.contact_person || '-'}</div>
              <div><span className="text-muted-foreground">Phone:</span> {viewingSupplier.phone || '-'}</div>
              <div><span className="text-muted-foreground">Email:</span> {viewingSupplier.email || '-'}</div>
              <div className="text-base font-semibold">Balance: {formatMoney(viewingSupplier.balance)}</div>
            </div>
          </div>
        </div>
      )}

      {payingSupplier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">{payingSupplier.name}</h2>
                <p className="text-sm text-muted-foreground">Supplier items and payment allocation</p>
              </div>
              <button type="button" onClick={() => setPayingSupplier(null)} className="rounded p-1.5 text-muted-foreground hover:text-foreground" title="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex items-center gap-2 border-b px-6">
              <button type="button" onClick={() => setPaymentTab('pending')} className={`border-b-2 px-3 py-3 text-sm ${paymentTab === 'pending' ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground'}`}>
                Pending Items
              </button>
              <button type="button" onClick={() => setPaymentTab('history')} className={`inline-flex items-center gap-2 border-b-2 px-3 py-3 text-sm ${paymentTab === 'history' ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground'}`}>
                <History className="h-4 w-4" />Payment History
              </button>
              <div className="ml-auto text-sm">
                Balance: <strong className="text-destructive">{formatMoney(payingSupplier.balance)}</strong>
              </div>
            </div>

            <div className="overflow-auto p-6">
              {paymentTab === 'pending' ? <>
                {payablesLoading ? <div className="py-12 text-center text-muted-foreground">Loading supplier items...</div> :
                  pendingPayables.length === 0 ? <div className="py-12 text-center"><PackageCheck className="mx-auto mb-3 h-10 w-10 text-green-600" /><h3 className="font-medium">No pending supplier items</h3><p className="text-sm text-muted-foreground">All item-linked payables have been cleared.</p></div> :
                  <div className="mobile-scroll-table overflow-x-auto rounded-lg border">
                    <table className="min-w-[950px] w-full text-sm">
                      <thead className="bg-muted"><tr>
                        <th className="w-12 px-3 py-3">
                          <input
                            type="checkbox"
                            checked={allPayablesSelected}
                            onChange={toggleAllPayables}
                            aria-label={allPayablesSelected ? 'Clear all supplier items' : 'Select all supplier items'}
                            title={allPayablesSelected ? 'Clear all' : 'Select all'}
                          />
                        </th>
                        <th className="px-3 py-3 text-left">Order</th>
                        <th className="min-w-72 px-3 py-3 text-left">Product</th>
                        <th className="px-3 py-3 text-right">Qty</th>
                        <th className="px-3 py-3 text-right">Supplier Cost</th>
                        <th className="px-3 py-3 text-right">Paid</th>
                        <th className="px-3 py-3 text-right">Outstanding</th>
                        <th className="w-40 px-3 py-3 text-left">Pay Now</th>
                      </tr></thead>
                      <tbody>{pendingPayables.map(payable => {
                        const selected = selectedPayables[payable.id] !== undefined
                        return <tr key={payable.id} className="border-t align-top">
                          <td className="px-3 py-3 text-center"><input type="checkbox" checked={selected} onChange={() => togglePayable(payable)} aria-label={`Select ${payable.product_name || payable.order_number || 'supplier item'}`} /></td>
                          <td className="whitespace-nowrap px-3 py-3"><div className="font-medium">{payable.order_number || '-'}</div><div className="text-xs text-muted-foreground">{new Date(payable.order_date).toLocaleDateString('en-KE')}</div></td>
                          <td className="px-3 py-3"><div className="max-w-sm font-medium leading-5">{payable.product_name || payable.description || 'Supplier payable'}</div>{payable.sku && <div className="mt-1 text-xs text-muted-foreground">{payable.sku}</div>}</td>
                          <td className="px-3 py-3 text-right">{Number(payable.supplier_quantity || payable.quantity || 0).toLocaleString()}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-right">{formatMoney(payable.amount)}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-right">{formatMoney(payable.paid_amount)}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-right font-semibold text-destructive">{formatMoney(payable.outstanding_amount)}</td>
                          <td className="px-3 py-3"><input type="number" min="0.01" max={Number(payable.outstanding_amount)} step="0.01" disabled={!selected} value={selectedPayables[payable.id] ?? ''} onChange={event => setSelectedPayables(current => ({ ...current, [payable.id]: event.target.value }))} className="w-36 rounded-lg border px-3 py-2 disabled:opacity-40" placeholder="Amount" /></td>
                        </tr>
                      })}</tbody>
                    </table>
                  </div>}

                {pendingPayables.length > 0 && hasPermission('suppliers.pay') && <div className="mt-5 grid gap-4 rounded-lg border bg-card p-4 lg:grid-cols-4">
                  <label className="text-sm">Payment Method<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="cash">Cash</option><option value="mpesa">M-PESA</option><option value="bank_transfer">Bank</option></select></label>
                  <label className="text-sm">Reference<input value={paymentReference} onChange={event => setPaymentReference(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" placeholder="M-Pesa or bank reference" /></label>
                  <label className="text-sm">Notes<input value={paymentNotes} onChange={event => setPaymentNotes(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" placeholder="Optional payment note" /></label>
                  <div className="flex flex-col justify-end">
                    <div className="mb-1 text-xs text-muted-foreground">Selected total</div>
                    <div className="mb-2 text-lg font-bold">{formatMoney(selectedTotal)}</div>
                    <button type="button" onClick={() => recordPayment.mutate()} disabled={recordPayment.isPending || selectedTotal <= 0} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{recordPayment.isPending ? 'Recording...' : 'Record Selected Payment'}</button>
                  </div>
                  {paymentError && <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive lg:col-span-4">{paymentError}</div>}
                </div>}
              </> : <>
                {historyLoading ? <div className="py-12 text-center text-muted-foreground">Loading payment history...</div> :
                  paymentHistory.length === 0 ? <div className="py-12 text-center text-muted-foreground">No supplier payments recorded</div> :
                  <div className="mobile-scroll-table overflow-x-auto rounded-lg border"><table className="min-w-[850px] w-full text-sm">
                    <thead className="bg-muted"><tr><th className="px-3 py-3 text-left">Date</th><th className="px-3 py-3 text-left">Order</th><th className="min-w-72 px-3 py-3 text-left">Product</th><th className="px-3 py-3 text-left">Method</th><th className="px-3 py-3 text-left">Reference</th><th className="px-3 py-3 text-right">Amount</th></tr></thead>
                    <tbody>{paymentHistory.map(payment => <tr key={payment.id} className="border-t"><td className="whitespace-nowrap px-3 py-3">{new Date(payment.created_at).toLocaleDateString('en-KE')}</td><td className="px-3 py-3">{payment.order_number || '-'}</td><td className="px-3 py-3">{payment.product_name || 'General supplier payment'}</td><td className="px-3 py-3 capitalize">{payment.payment_method.replaceAll('_', ' ')}</td><td className="px-3 py-3">{payment.reference || '-'}</td><td className="whitespace-nowrap px-3 py-3 text-right font-medium">{formatMoney(payment.amount)}</td></tr>)}</tbody>
                  </table></div>}
              </>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
