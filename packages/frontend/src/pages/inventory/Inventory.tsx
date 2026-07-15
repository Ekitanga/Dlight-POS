import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Search, Package, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Ban } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useAuthStore } from '../../stores/authStore'
import { PaginatedResponse, Pagination } from '../../components/Pagination'
import { formatMoney } from '../../lib/format'

interface InventoryItem {
  id: string
  product_id: string
  product_name: string
  sku: string
  quantity: number
  reserved_quantity: number
  damaged_quantity: number
  lost_quantity: number
  returned_quantity: number
  reorder_level: number
  available_stock: number
  selling_price: number
}

interface AdjustmentFormData {
  product_id: string
  type: string
  quantity: number
  notes: string
}

const adjustmentTypes = [
  { value: 'stock_in', label: 'Stock In', icon: ArrowDownToLine, color: 'text-green-600' },
  { value: 'stock_out', label: 'Stock Out', icon: ArrowUpFromLine, color: 'text-red-600' },
  { value: 'damaged', label: 'Damaged', icon: Ban, color: 'text-orange-600' },
  { value: 'lost', label: 'Lost', icon: AlertTriangle, color: 'text-red-600' },
  { value: 'reserved', label: 'Reserved', icon: Package, color: 'text-blue-600' },
  { value: 'reservation_release', label: 'Release Reservation', icon: Package, color: 'text-slate-600' },
  { value: 'return_sellable', label: 'Return - Sellable', icon: ArrowDownToLine, color: 'text-green-600' },
  { value: 'return_damaged', label: 'Return - Damaged', icon: AlertTriangle, color: 'text-orange-600' }
]

const formatCurrency = (value: number) => formatMoney(value)

export function Inventory() {
  const { hasPermission } = useAuthStore()
  const [searchParams] = useSearchParams()
  const lowStockOnly = searchParams.get('filter') === 'low_stock'
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const queryClient = useQueryClient()

  const { data: inventoryPage, isLoading, error } = useQuery<PaginatedResponse<InventoryItem>>({
    queryKey: ['inventory', search, lowStockOnly, page, pageSize],
    queryFn: async () => {
      const response = await axios.get(`/api/inventory?search=${encodeURIComponent(search)}&low_stock=${lowStockOnly}&page=${page}&page_size=${pageSize}`)
      return response.data
    }
  })
  const inventory = inventoryPage?.data || []
  const { data: inventoryLookup = [] } = useQuery<InventoryItem[]>({
    queryKey: ['inventory-lookup'],
    queryFn: async () => (await axios.get('/api/inventory')).data,
    enabled: showForm
  })

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<AdjustmentFormData>({
    defaultValues: {
      product_id: '',
      type: 'stock_in',
      quantity: 0,
      notes: ''
    }
  })
  const selectedProduct = inventoryLookup.find(item => item.product_id === watch('product_id'))

  const adjustInventory = useMutation({
    mutationFn: async (data: AdjustmentFormData) => {
      const response = await axios.post('/api/inventory/adjust', data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-lookup'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setShowForm(false)
      reset()
    }
  })

  const handleFormSubmit = (data: AdjustmentFormData) => {
    adjustInventory.mutate(data)
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground">Failed to load inventory</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-muted-foreground">Manage stock levels and adjustments</p>
        </div>
        {hasPermission('inventory.adjust') && <button
          onClick={() => { setShowForm(true); reset() }}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Adjust Stock
        </button>}
      </div>

      {showForm && (
        <div className="border rounded-lg p-6 bg-card">
          <h2 className="font-semibold mb-4">Inventory Adjustment</h2>
          <form onSubmit={handleSubmit(handleFormSubmit)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Product *</label>
              <select
                {...register('product_id', { required: 'Product is required' })}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="">Select product</option>
                {inventoryLookup.map(item => (
                  <option key={item.product_id} value={item.product_id}>
                    {item.product_name} | {item.sku || 'No SKU'} | {formatCurrency(item.selling_price)} | Stock: {item.quantity}
                  </option>
                ))}
              </select>
              {selectedProduct && (
                <div className="mt-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{selectedProduct.sku || 'No SKU'}</span>
                  {' | '}{formatCurrency(selectedProduct.selling_price)}
                  {' | '}Current stock: {selectedProduct.quantity}
                </div>
              )}
              {errors.product_id && <span className="text-xs text-destructive">{errors.product_id.message}</span>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Adjustment Type *</label>
              <select
                {...register('type', { required: 'Type is required' })}
                className="w-full px-3 py-2 border rounded-lg"
              >
                {adjustmentTypes.map(type => (
                  <option key={type.value} value={type.value}>{type.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Quantity *</label>
              <input
                type="number"
                {...register('quantity', { required: 'Quantity is required', valueAsNumber: true, min: 1 })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="0"
              />
              {errors.quantity && <span className="text-xs text-destructive">{errors.quantity.message}</span>}
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea
                {...register('notes')}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Adjustment reason"
                rows={2}
              />
            </div>
            <div className="md:col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={adjustInventory.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
              >
                {adjustInventory.isPending ? 'Adjusting...' : 'Apply Adjustment'}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); reset() }}
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
          placeholder="Search inventory..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
        />
      </div>
      {lowStockOnly && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"><strong>Low-stock filter active.</strong> Showing products at or below their reorder level.</div>}

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : inventory.length === 0 ? (
        <div className="text-center py-16">
          <Package className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No inventory items found</h3>
          <p className="text-muted-foreground mt-1">
            {search ? 'Try adjusting your search' : 'Add products to start tracking inventory'}
          </p>
        </div>
      ) : (
        <div className="mobile-scroll-table border rounded-lg overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Product</th>
                <th className="text-left px-4 py-3 font-medium">SKU</th>
                <th className="text-left px-4 py-3 font-medium">Selling Price</th>
                <th className="text-left px-4 py-3 font-medium">In Stock</th>
                <th className="text-left px-4 py-3 font-medium">Reserved</th>
                <th className="text-left px-4 py-3 font-medium">Damaged</th>
                <th className="text-left px-4 py-3 font-medium">Lost</th>
                <th className="text-left px-4 py-3 font-medium">Returned</th>
                <th className="text-left px-4 py-3 font-medium">Available</th>
                <th className="text-left px-4 py-3 font-medium">Reorder Level</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((item) => (
                <tr key={item.id} className="border-t hover:bg-muted/50 transition-colors">
                  <td className="px-4 py-3 font-medium">{item.product_name}</td>
                  <td className="px-4 py-3 text-sm">{item.sku || '-'}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-medium">{formatCurrency(item.selling_price)}</td>
                  <td className="px-4 py-3 font-medium">{item.quantity}</td>
                  <td className="px-4 py-3 text-sm">{item.reserved_quantity}</td>
                  <td className="px-4 py-3 text-sm text-destructive">{item.damaged_quantity}</td>
                  <td className="px-4 py-3 text-sm text-destructive">{item.lost_quantity}</td>
                  <td className="px-4 py-3 text-sm">{item.returned_quantity || 0}</td>
                  <td className={`px-4 py-3 font-medium ${item.available_stock <= item.reorder_level ? 'text-destructive' : 'text-green-600'}`}>
                    {item.available_stock}
                  </td>
                  <td className="px-4 py-3 text-sm">{item.reorder_level}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {inventoryPage && <Pagination meta={inventoryPage.pagination} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} />}
        </div>
      )}
    </div>
  )
}
