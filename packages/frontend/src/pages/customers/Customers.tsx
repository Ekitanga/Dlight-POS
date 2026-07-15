import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { Plus, Search, Edit, Eye, Trash2, Users, X, Banknote } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useAuthStore } from '../../stores/authStore'
import { formatMoney } from '../../lib/format'
import { PaginatedResponse, Pagination } from '../../components/Pagination'

interface Customer {
  id: string
  name: string
  phone?: string
  email?: string
  balance: number
  credit_limit?: number
  address?: string
}

interface CustomerFormData {
  name: string
  phone: string
  email: string
  address: string
  credit_limit: number
}

export function Customers() {
  const { hasPermission } = useAuthStore()
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
  const [viewingCustomer, setViewingCustomer] = useState<Customer | null>(null)
  const [payingCustomer, setPayingCustomer] = useState<Customer | null>(null)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [paymentReference, setPaymentReference] = useState('')
  const [paymentError, setPaymentError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const queryClient = useQueryClient()

  const { data: customerPage, isLoading, error } = useQuery<PaginatedResponse<Customer>>({
    queryKey: ['customers', search, page, pageSize],
    queryFn: async () => {
      const response = await axios.get(`/api/customers?search=${encodeURIComponent(search)}&page=${page}&page_size=${pageSize}`)
      return response.data
    }
  })
  const customers = customerPage?.data || []

  const { register, handleSubmit, reset, formState: { errors } } = useForm<CustomerFormData>()

  const createCustomer = useMutation({
    mutationFn: async (data: CustomerFormData) => {
      const response = await axios.post('/api/customers', data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setShowForm(false)
      reset()
    }
  })

  const updateCustomer = useMutation({
    mutationFn: async (data: CustomerFormData) => {
      const response = await axios.put(`/api/customers/${editingCustomer?.id}`, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      setEditingCustomer(null)
      setShowForm(false)
      reset()
    }
  })

  const deleteCustomer = useMutation({
    mutationFn: async (id: string) => {
      await axios.delete(`/api/customers/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] })
    }
  })

  const recordPayment = useMutation({
    mutationFn: async () => {
      if (!payingCustomer) return
      return (await axios.post(`/api/customers/${payingCustomer.id}/payments`, {
        amount: Number(paymentAmount), payment_method: paymentMethod, reference: paymentReference || null
      })).data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setPayingCustomer(null)
      setPaymentAmount('')
      setPaymentReference('')
    },
    onError: (error: any) => setPaymentError(error.response?.data?.error?.message || 'Failed to record payment')
  })

  const handleFormSubmit = (data: CustomerFormData) => {
    if (editingCustomer) {
      updateCustomer.mutate(data)
    } else {
      createCustomer.mutate(data)
    }
  }

  const handleEdit = (customer: Customer) => {
    setEditingCustomer(customer)
    reset({
      name: customer.name,
      phone: customer.phone || '',
      email: customer.email || '',
      address: customer.address || '',
      credit_limit: customer.credit_limit || 0
    })
    setShowForm(true)
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground">Failed to load customers</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Customers</h1>
          <p className="text-muted-foreground">Manage customer accounts and credit</p>
        </div>
        {hasPermission('customers.create') && <button 
          onClick={() => { setShowForm(true); setEditingCustomer(null); reset() }}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Customer
        </button>}
      </div>

      {showForm && (
        <div className="border rounded-lg p-6 bg-card">
          <h2 className="font-semibold mb-4">{editingCustomer ? 'Edit' : 'Add'} Customer</h2>
          <form onSubmit={handleSubmit(handleFormSubmit)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input
                {...register('name', { required: 'Name is required' })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Customer name"
              />
              {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
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
                placeholder="customer@example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Credit Limit</label>
              <input
                type="number"
                {...register('credit_limit', { valueAsNumber: true })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Address</label>
              <textarea
                {...register('address')}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Customer address"
                rows={2}
              />
            </div>
            <div className="md:col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={createCustomer.isPending || updateCustomer.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
              >
                {editingCustomer ? 'Update' : 'Create'} Customer
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingCustomer(null) }}
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
          placeholder="Search customers..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="text-center py-16">
          <Users className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No customers found</h3>
          <p className="text-muted-foreground mt-1">
            {search ? 'Try adjusting your search' : 'Add your first customer'}
          </p>
        </div>
      ) : (
        <div className="mobile-scroll-table border rounded-lg overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Phone</th>
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-left px-4 py-3 font-medium">Balance</th>
                <th className="text-left px-4 py-3 font-medium">Credit Limit</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {customers.map(customer => (
                <tr key={customer.id} className="border-t hover:bg-muted/50 transition-colors">
                  <td className="px-4 py-3 font-medium">{customer.name}</td>
                  <td className="px-4 py-3 text-sm">{customer.phone || '-'}</td>
                  <td className="px-4 py-3 text-sm">{customer.email || '-'}</td>
                  <td className={`px-4 py-3 font-medium ${(customer.balance || 0) > 0 ? 'text-destructive' : 'text-green-600'}`}>
                    {formatMoney(customer.balance)}
                  </td>
                  <td className="px-4 py-3 text-sm">{formatMoney(customer.credit_limit)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setViewingCustomer(customer)}
                        className="p-1.5 text-muted-foreground hover:text-primary rounded"
                        title="View customer"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      <button 
                        type="button"
                        onClick={() => { setPayingCustomer(customer); setPaymentAmount(String(customer.balance || '')); setPaymentError('') }}
                        disabled={(customer.balance || 0) <= 0}
                        className="p-1.5 text-muted-foreground hover:text-primary rounded disabled:opacity-30"
                        title="Record credit payment"
                      >
                        <Banknote className="h-4 w-4" />
                      </button>
                      {hasPermission('customers.edit') && <button 
                        onClick={() => handleEdit(customer)}
                        className="p-1.5 text-muted-foreground hover:text-primary rounded"
                      >
                        <Edit className="h-4 w-4" />
                      </button>}
                      {hasPermission('customers.delete') && <button 
                        onClick={() => deleteCustomer.mutate(customer.id)}
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
          {customerPage && <Pagination meta={customerPage.pagination} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} />}
        </div>
      )}

      {viewingCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">{viewingCustomer.name}</h2>
                <p className="text-sm text-muted-foreground">Customer details</p>
              </div>
              <button type="button" onClick={() => setViewingCustomer(null)} className="rounded p-1.5 text-muted-foreground hover:text-foreground" title="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 p-6 text-sm">
              <div><span className="text-muted-foreground">Phone:</span> {viewingCustomer.phone || '-'}</div>
              <div><span className="text-muted-foreground">Email:</span> {viewingCustomer.email || '-'}</div>
              <div><span className="text-muted-foreground">Credit limit:</span> {formatMoney(viewingCustomer.credit_limit)}</div>
              <div className="text-base font-semibold">Balance: {formatMoney(viewingCustomer.balance)}</div>
            </div>
          </div>
        </div>
      )}
      {payingCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div><h2 className="font-semibold">Record Credit Payment</h2><p className="text-sm text-muted-foreground">{payingCustomer.name} owes {formatMoney(payingCustomer.balance)}</p></div>
              <button onClick={() => setPayingCustomer(null)} title="Close"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-4 p-6">
              <label className="block text-sm font-medium">Amount<input type="number" min="0.01" step="0.01" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} placeholder="Amount received" className="mt-1 w-full rounded border px-3 py-2" /></label>
              <label className="block text-sm font-medium">Payment method<select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className="mt-1 w-full rounded border px-3 py-2"><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank_transfer">Bank</option></select></label>
              <label className="block text-sm font-medium">Reference<input value={paymentReference} onChange={e => setPaymentReference(e.target.value)} placeholder="M-Pesa or bank reference" className="mt-1 w-full rounded border px-3 py-2" /></label>
              {paymentError && <p className="text-sm text-destructive">{paymentError}</p>}
              <button onClick={() => recordPayment.mutate()} disabled={recordPayment.isPending || Number(paymentAmount) <= 0} className="w-full rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">Record Payment</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
