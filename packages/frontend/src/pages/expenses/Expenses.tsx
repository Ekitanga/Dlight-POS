import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Search, Edit, CheckCircle, CreditCard, Trash2, XCircle } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useAuthStore } from '../../stores/authStore'
import { PaginatedResponse, Pagination } from '../../components/Pagination'
import { DateRangeFilter } from '../../components/DateRangeFilter'
import { formatMoney } from '../../lib/format'

interface Expense {
  id: string
  category: string
  description: string
  amount: number
  frequency: 'daily' | 'monthly' | 'one_off'
  expense_date: string
  effective_end_date?: string | null
  payment_method: string
  reference_notes?: string
  status: string
}

interface ExpenseFormData {
  category: string
  description: string
  amount: number
  frequency: 'daily' | 'monthly' | 'one_off'
  expense_date: string
  effective_end_date: string
  payment_method: string
  reference_notes: string
  receipt_url: string
}

interface SettingsData {
  expense_categories?: string[]
}

const fallbackCategories = ['Rent', 'Salaries', 'Electricity', 'Internet', 'Packaging', 'Fuel', 'Miscellaneous']
const frequencyLabels: Record<string, string> = {
  daily: 'Daily',
  monthly: 'Monthly',
  one_off: 'One-off'
}

function todayDate() {
  return new Date().toISOString().split('T')[0]
}

function businessDateInputValue(value?: string | null) {
  if (!value) return ''
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text

  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return ''

  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function defaultExpenseValues(): ExpenseFormData {
  return {
    category: '',
    description: '',
    amount: undefined as unknown as number,
    frequency: 'one_off',
    expense_date: todayDate(),
    effective_end_date: '',
    payment_method: 'cash',
    reference_notes: '',
    receipt_url: ''
  }
}

function formatSchedule(expense: Expense) {
  const start = businessDateInputValue(expense.expense_date)
  const end = businessDateInputValue(expense.effective_end_date)

  if (expense.frequency === 'one_off') return start || '-'
  return end ? `${start} to ${end}` : `${start} onwards`
}

export function Expenses() {
  const { hasPermission } = useAuthStore()
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedFrequency, setSelectedFrequency] = useState('')
  const [selectedStatus, setSelectedStatus] = useState('')
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') || '')
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') || '')
  const [showForm, setShowForm] = useState(false)
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null)
  const [formError, setFormError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const queryClient = useQueryClient()

  const { data: settings } = useQuery<SettingsData>({
    queryKey: ['settings'],
    queryFn: async () => (await axios.get('/api/settings')).data
  })

  const categories = settings?.expense_categories?.length ? settings.expense_categories : fallbackCategories

  const { data: expensePage, isLoading, error } = useQuery<PaginatedResponse<Expense>>({
    queryKey: ['expenses', search, selectedCategory, selectedFrequency, selectedStatus, dateFrom, dateTo, page, pageSize],
    queryFn: async () => {
      const params: Record<string, string> = {}
      if (search) params['search'] = search
      if (selectedCategory) params['category'] = selectedCategory
      if (selectedFrequency) params['frequency'] = selectedFrequency
      if (selectedStatus) params['status'] = selectedStatus
      if (dateFrom) params['date_from'] = dateFrom
      if (dateTo) params['date_to'] = dateTo
      params['page'] = String(page)
      params['page_size'] = String(pageSize)
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
      const response = await axios.get(`/api/expenses?${queryString}`)
      return response.data
    }
  })
  const expenses = expensePage?.data || []

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<ExpenseFormData>({
    defaultValues: defaultExpenseValues()
  })
  const watchedFrequency = watch('frequency')

  const createExpense = useMutation({
    mutationFn: async (data: ExpenseFormData) => {
      const payload = {
        ...data,
        effective_end_date: data.frequency === 'one_off' ? '' : data.effective_end_date
      }
      const response = await axios.post('/api/expenses', payload)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      queryClient.invalidateQueries({ queryKey: ['reports'] })
      setShowForm(false)
      setEditingExpense(null)
      setFormError('')
      reset(defaultExpenseValues())
    },
    onError: (error: any) => {
      setFormError(error.response?.data?.error?.message || 'Failed to save expense')
    }
  })

  const updateExpense = useMutation({
    mutationFn: async (data: ExpenseFormData) => {
      const payload = {
        ...data,
        effective_end_date: data.frequency === 'one_off' ? '' : data.effective_end_date
      }
      const response = await axios.put(`/api/expenses/${editingExpense?.id}`, payload)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      queryClient.invalidateQueries({ queryKey: ['reports'] })
      setShowForm(false)
      setEditingExpense(null)
      setFormError('')
      reset(defaultExpenseValues())
    },
    onError: (error: any) => {
      setFormError(error.response?.data?.error?.message || 'Failed to update expense')
    }
  })

  const deleteExpense = useMutation({
    mutationFn: async (id: string) => {
      await axios.delete(`/api/expenses/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      queryClient.invalidateQueries({ queryKey: ['reports'] })
    }
  })

  const approveExpense = useMutation({
    mutationFn: async (id: string) => {
      await axios.put(`/api/expenses/${id}/approve`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      queryClient.invalidateQueries({ queryKey: ['reports'] })
    }
  })

  const rejectExpense = useMutation({
    mutationFn: async (id: string) => {
      await axios.put(`/api/expenses/${id}/reject`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      queryClient.invalidateQueries({ queryKey: ['reports'] })
    }
  })

  const handleFormSubmit = (data: ExpenseFormData) => {
    if (editingExpense) {
      updateExpense.mutate(data)
    } else {
      createExpense.mutate(data)
    }
  }

  const handleEdit = (expense: Expense) => {
    setEditingExpense(expense)
    reset({
      category: expense.category,
      description: expense.description,
      amount: expense.amount,
      frequency: expense.frequency || 'one_off',
      expense_date: businessDateInputValue(expense.expense_date),
      effective_end_date: businessDateInputValue(expense.effective_end_date),
      payment_method: expense.payment_method,
      reference_notes: expense.reference_notes || '',
      receipt_url: ''
    })
    setShowForm(true)
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground">Failed to load expenses</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Expenses</h1>
          <p className="text-muted-foreground">Track and manage business expenses</p>
        </div>
        {hasPermission('expenses.create') && <button
          onClick={() => { setShowForm(true); setEditingExpense(null); setFormError(''); reset(defaultExpenseValues()) }}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Expense
        </button>}
      </div>

      {showForm && (
        <div className="border rounded-lg p-6 bg-card">
          <h2 className="font-semibold mb-4">{editingExpense ? 'Edit' : 'Add'} Expense</h2>
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            Only approved expenses reduce profit and appear in reconciliation. Use Pending when the cost needs owner review.
          </div>
          {formError && <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{formError}</div>}
          <form onSubmit={handleSubmit(handleFormSubmit)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium mb-1">Expense name *</label>
              <input
                {...register('description', { required: 'Expense name is required' })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Example: Meta ads, shop rent, salary, packaging bags"
              />
              {errors.description && <span className="text-xs text-destructive">{errors.description.message}</span>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Category *</label>
              <select
                {...register('category', { required: 'Category is required' })}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="">Select category</option>
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              {errors.category && <span className="text-xs text-destructive">{errors.category.message}</span>}
              <p className="mt-1 text-xs text-muted-foreground">Manage this list from Settings &gt; Expense Categories.</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Amount *</label>
              <input
                type="number"
                {...register('amount', { required: 'Amount is required', valueAsNumber: true, min: 0 })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Amount paid"
              />
              {errors.amount && <span className="text-xs text-destructive">{errors.amount.message}</span>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Frequency *</label>
              <select
                {...register('frequency', { required: 'Frequency is required' })}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="daily">Daily</option>
                <option value="monthly">Monthly</option>
                <option value="one_off">One-off</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Daily and monthly expenses are recognized from the start date until the optional end date.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                {watchedFrequency === 'one_off' ? 'Expense date *' : 'Start date *'}
              </label>
              <input
                type="date"
                {...register('expense_date', { required: 'Expense date is required' })}
                className="w-full px-3 py-2 border rounded-lg"
              />
              {errors.expense_date && <span className="text-xs text-destructive">{errors.expense_date.message}</span>}
              <p className="mt-1 text-xs text-muted-foreground">
                {watchedFrequency === 'one_off'
                  ? 'Use the business date this cost belongs to or was paid.'
                  : 'Use the first business date this recurring cost should affect profit.'}
              </p>
            </div>
            {watchedFrequency !== 'one_off' && (
              <div>
                <label className="block text-sm font-medium mb-1">End date</label>
                <input
                  type="date"
                  {...register('effective_end_date')}
                  className="w-full px-3 py-2 border rounded-lg"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Leave blank while ongoing. When the amount changes, end this schedule and create a new one from the next date.
                </p>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium mb-1">Payment method *</label>
              <select
                {...register('payment_method')}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="cash">Cash</option>
                <option value="mpesa">M-PESA</option>
                <option value="bank_transfer">Bank Transfer</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium mb-1">Notes / reference</label>
              <textarea
                {...register('reference_notes')}
                className="w-full px-3 py-2 border rounded-lg"
                rows={3}
                placeholder="M-Pesa code, invoice number, supplier reference, or explanation"
              />
            </div>
            <div className="md:col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={createExpense.isPending || updateExpense.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
              >
                {editingExpense ? 'Update' : 'Create'} Expense
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingExpense(null); setFormError('') }}
                className="px-4 py-2 border rounded-lg"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search expenses..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
          />
        </div>

        <select
          value={selectedCategory}
          onChange={(e) => { setSelectedCategory(e.target.value); setPage(1) }}
          className="px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
        >
          <option value="">All Categories</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
        <select
          value={selectedFrequency}
          onChange={(e) => { setSelectedFrequency(e.target.value); setPage(1) }}
          className="px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
        >
          <option value="">All Frequencies</option>
          <option value="daily">Daily</option>
          <option value="monthly">Monthly</option>
          <option value="one_off">One-off</option>
        </select>
        <select
          value={selectedStatus}
          onChange={(e) => { setSelectedStatus(e.target.value); setPage(1) }}
          className="px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <DateRangeFilter
          dateFrom={dateFrom}
          dateTo={dateTo}
          compact
          includeClear={false}
          onChange={range => { setDateFrom(range.dateFrom); setDateTo(range.dateTo); setPage(1) }}
        />
        {(selectedCategory || selectedFrequency || selectedStatus || dateFrom || dateTo) && (
          <button type="button" onClick={() => { setSelectedCategory(''); setSelectedFrequency(''); setSelectedStatus(''); setDateFrom(''); setDateTo('') }} className="px-3 py-2 border rounded-lg text-sm">
            Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : expenses.length === 0 ? (
        <div className="text-center py-16">
          <CreditCard className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No expenses found</h3>
          <p className="text-muted-foreground mt-1">
            {search ? 'Try adjusting your search' : 'Add your first expense'}
          </p>
        </div>
      ) : (
        <div className="mobile-scroll-table border rounded-lg overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Expense</th>
                <th className="text-left px-4 py-3 font-medium">Category</th>
                <th className="text-left px-4 py-3 font-medium">Frequency</th>
                <th className="text-left px-4 py-3 font-medium">Amount</th>
                <th className="text-left px-4 py-3 font-medium">Schedule</th>
                <th className="text-left px-4 py-3 font-medium">Payment</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map(expense => (
                <tr key={expense.id} className="border-t hover:bg-muted/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{expense.description}</div>
                    {expense.reference_notes && <div className="mt-1 max-w-xs truncate text-xs text-muted-foreground">{expense.reference_notes}</div>}
                  </td>
                  <td className="px-4 py-3 text-sm">{expense.category}</td>
                  <td className="px-4 py-3 text-sm">{frequencyLabels[expense.frequency] || 'One-off'}</td>
                  <td className="px-4 py-3 font-medium">{formatMoney(expense.amount)}</td>
                  <td className="px-4 py-3 text-sm">{formatSchedule(expense)}</td>
                  <td className="px-4 py-3 text-sm capitalize">{expense.payment_method?.replace('_', ' ')}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${
                      expense.status === 'approved' 
                        ? 'bg-green-100 text-green-800' 
                        : expense.status === 'rejected'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}>
                      {expense.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {expense.status === 'pending' && hasPermission('expenses.approve') && (
                        <button
                          onClick={() => approveExpense.mutate(expense.id)}
                          className="p-1.5 text-green-600 hover:bg-green-50 rounded"
                          title="Approve expense"
                        >
                          <CheckCircle className="h-4 w-4" />
                        </button>
                      )}
                      {expense.status === 'pending' && hasPermission('expenses.approve') && (
                        <button
                          onClick={() => rejectExpense.mutate(expense.id)}
                          className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                          title="Reject expense"
                        >
                          <XCircle className="h-4 w-4" />
                        </button>
                      )}
                      <button 
                        onClick={() => handleEdit(expense)}
                        className="p-1.5 text-muted-foreground hover:text-primary rounded"
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                      <button 
                        onClick={() => deleteExpense.mutate(expense.id)}
                        className="p-1.5 text-muted-foreground hover:text-destructive rounded"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {expensePage && <Pagination meta={expensePage.pagination} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} />}
        </div>
      )}
    </div>
  )
}
