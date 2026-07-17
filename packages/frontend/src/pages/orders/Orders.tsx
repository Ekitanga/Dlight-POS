import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useDeferredValue, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Check, ChevronDown, Plus, Search, Eye, Edit, Package, X, ExternalLink } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useAuthStore } from '../../stores/authStore'
import { PaginatedResponse, Pagination } from '../../components/Pagination'
import { DateRangeFilter } from '../../components/DateRangeFilter'
import { formatMoney } from '../../lib/format'

interface Order {
  id: string
  order_number: string
  customer_name?: string
  customer_phone?: string
  customer_address?: string
  rider_name?: string
  courier_name?: string
  delivery_type?: string
  courier_payment_type?: string
  courier_tracking_number?: string
  rider_id?: string
  courier_id?: string
  status: string
  payment_status: string
  total_amount: number
  delivery_income?: number
  delivery_cost?: number
  delivery_fee_payment_method?: string
  courier_customer_fee?: number
  courier_actual_fee?: number
  subtotal?: number
  paid_amount?: number
  cod_amount?: number
  remitted_amount?: number
  cod_outstanding?: number
  cod_status?: string
  last_payment_method?: string
  notes?: string
  sale_date?: string
  created_at: string
}

interface OrderDetailItem {
  id: string
  product_id: string
  product_name?: string
  sku?: string
  category_name?: string
  quantity: number
  internal_quantity?: number
  supplier_quantity?: number
  unit_price: number
  total_price: number
  fulfillment_type?: string
  supplier_id?: string
  supplier_cost?: number
  available_stock?: number
}

interface OrderDetail {
  order: Order
  items: OrderDetailItem[]
}

interface Product {
  id: string
  name: string
  sku?: string
  category_name?: string
  selling_price: number
  is_dropship?: boolean
  available_stock?: number
}

interface Supplier {
  id: string
  name: string
}

interface Rider {
  id: string
  name: string
}

interface Courier {
  id: string
  name: string
}

interface OrderItemFormData {
  product_id: string
  product_name?: string
  sku?: string
  category_name?: string
  available_stock?: number
  quantity?: number
  selling_price?: number
  fulfillment_source: 'internal' | 'supplier'
  supplier_id?: string
  supplier_cost?: number
}

interface OrderFormData {
  sale_date: string
  customer_name: string
  customer_phone: string
  customer_address: string
  customer_notes: string
  delivery_type: 'walk_in' | 'rider' | 'courier'
  rider_id: string
  courier_id: string
  courier_tracking_number: string
  courier_payment_type: 'prepaid' | 'cod'
  delivery_fee_payment_method: 'cash' | 'mpesa' | 'bank_transfer' | 'pay_on_delivery' | 'paid_to_courier'
  customer_delivery_fee?: number
  actual_rider_fee?: number
  actual_courier_fee?: number
  delivery_notes: string
  payment_method: 'cash' | 'mpesa' | 'bank_transfer' | 'credit' | 'pay_on_delivery'
  notes: string
  items: OrderItemFormData[]
}

const blankItem: OrderItemFormData = {
  product_id: '',
  quantity: undefined,
  selling_price: undefined,
  fulfillment_source: 'internal',
  supplier_id: '',
  supplier_cost: undefined
}

function todayDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function displayBusinessDate(value?: string | null, fallback?: string | null): string {
  if (!value) return '-'
  const rawValue = String(value)
  const dateOnly = rawValue.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
  const parsedDate = dateOnly ? new Date(`${dateOnly}T00:00:00`) : new Date(rawValue)
  if (Number.isNaN(parsedDate.getTime())) return fallback ? displayBusinessDate(fallback) : '-'
  return parsedDate.toLocaleDateString()
}

const DEFAULT_SPEEDAF_TRACKING_URL = 'https://parcelsapp.com/en/tracking/'

function orderTrackingUrl(order: Pick<Order, 'courier_name' | 'courier_tracking_number'>) {
  const cleanedTrackingNumber = order.courier_tracking_number?.trim()
  if (!cleanedTrackingNumber) return ''
  if ((order.courier_name || '').toLowerCase().includes('speedaf')) {
    return `${DEFAULT_SPEEDAF_TRACKING_URL}${encodeURIComponent(cleanedTrackingNumber)}`
  }
  return ''
}

function OrderTrackingLink({ order }: { order: Order }) {
  const cleanedTrackingNumber = order.courier_tracking_number?.trim()
  if (!cleanedTrackingNumber) return null

  const url = orderTrackingUrl(order)
  if (!url) {
    return <p className="text-sm text-muted-foreground">Tracking: <span className="break-all">{cleanedTrackingNumber}</span></p>
  }

  return (
    <p className="text-sm text-muted-foreground">
      Tracking:{' '}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
        title={`Track ${cleanedTrackingNumber}`}
      >
        <span className="break-all">{cleanedTrackingNumber}</span>
        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
      </a>
    </p>
  )
}

interface ProductSearchSelectProps {
  value: string
  onChange: (product: Product) => void
  resultsId: string
  selectedProduct?: Product | null
}

function ProductSearchSelect({ value, onChange, resultsId, selectedProduct }: ProductSearchSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [selected, setSelected] = useState<Product | null>(null)
  const deferredQuery = useDeferredValue(query.trim())
  const { data: products = [], isLoading, isError: loadError } = useQuery<Product[]>({
    queryKey: ['order-product-search', deferredQuery],
    enabled: open && deferredQuery.length >= 2,
    queryFn: async () => {
      const response = await axios.get<Product[] | PaginatedResponse<Product>>('/api/products', {
        params: { search: deferredQuery }
      })
      return Array.isArray(response.data) ? response.data : response.data.data
    },
    staleTime: 60_000
  })

  useEffect(() => {
    if (selectedProduct?.id && selectedProduct.id !== selected?.id) {
      setSelected(selectedProduct)
    }
  }, [selected?.id, selectedProduct])

  const normalizeSearchText = (text: string) => text
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim()
  const searchTerms = normalizeSearchText(query).split(/\s+/).filter(Boolean)
  const matches = products.filter(product => {
    if (searchTerms.length === 0) return true
    const searchableText = normalizeSearchText([
      product.name,
      product.sku || '',
      product.category_name || '',
      String(product.selling_price)
    ].join(' '))
    return searchTerms.every(term => searchableText.includes(term))
  }).slice(0, 30)

  const choose = (product: Product) => {
    setSelected(product)
    onChange(product)
    setQuery('')
    setOpen(false)
    setActiveIndex(0)
  }

  return (
    <div
      className="relative lg:col-span-2"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      {open ? (
        <div className="rounded-lg border bg-background shadow-sm focus-within:ring-2 focus-within:ring-primary">
          <div className="flex items-center gap-2 px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={resultsId}
              value={query}
              onChange={event => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={event => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  if (matches.length > 0) setActiveIndex(index => Math.min(index + 1, matches.length - 1))
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setActiveIndex(index => Math.max(index - 1, 0))
                } else if (event.key === 'Enter' && matches[activeIndex]) {
                  event.preventDefault()
                  choose(matches[activeIndex])
                } else if (event.key === 'Escape') {
                  setOpen(false)
                }
              }}
              className="min-w-0 flex-1 bg-transparent py-2 outline-none"
              placeholder="Search product name, SKU, or price"
            />
            <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-muted-foreground" title="Close product search">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex min-h-10 w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left hover:bg-muted"
        >
          <span className="min-w-0">
            <span className={`block truncate text-sm ${selected ? 'font-medium' : 'text-muted-foreground'}`}>
              {selected?.name || 'Search and select product'}
            </span>
            {selected && (
              <span className="block truncate text-xs text-muted-foreground">
                {selected.sku || 'No SKU'} | {formatMoney(selected.selling_price)} | Stock {Number(selected.available_stock || 0)}
              </span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      )}

      {open && (
        <div id={resultsId} role="listbox" className="absolute z-50 mt-1 max-h-72 w-full min-w-0 overflow-y-auto rounded-lg border bg-background shadow-xl sm:min-w-[320px]">
          {deferredQuery.length < 2 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">Type at least 2 letters to search products</div>
          ) : isLoading ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">Loading products...</div>
          ) : loadError ? (
            <div className="px-3 py-6 text-center text-sm text-destructive">Products could not be loaded. Close and try again.</div>
          ) : matches.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">No matching products</div>
          ) : matches.map((product, index) => (
            <button
              type="button"
              role="option"
              aria-selected={product.id === value}
              key={product.id}
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(product)}
              onMouseEnter={() => setActiveIndex(index)}
              className={`flex w-full items-center justify-between gap-3 border-b px-3 py-2.5 text-left last:border-b-0 ${index === activeIndex ? 'bg-muted' : 'hover:bg-muted/60'}`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{product.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {product.sku || 'No SKU'} | {formatMoney(product.selling_price)} | Available {Number(product.available_stock || 0)}
                </span>
              </span>
              {product.id === value && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Orders() {
  const { hasPermission } = useAuthStore()
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const requestedStage = searchParams.get('workflow_stage') || 'all'
  const [activeTab, setActiveTab] = useState(['all', 'pending', 'in_transit', 'pending_payment', 'completed'].includes(requestedStage) ? requestedStage : 'all')
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') || '')
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') || '')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [selectedStatus, setSelectedStatus] = useState('')
  const [completionPaymentMethod, setCompletionPaymentMethod] = useState('cash')
  const [statusNotes, setStatusNotes] = useState('')
  const [statusError, setStatusError] = useState('')
  const [codRemittanceAmount, setCodRemittanceAmount] = useState('')
  const [codRemittanceMethod, setCodRemittanceMethod] = useState('mpesa')
  const [codRemittanceReference, setCodRemittanceReference] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const queryClient = useQueryClient()

  const { data: orderPage, isLoading } = useQuery<PaginatedResponse<Order>>({
    queryKey: ['orders', search, dateFrom, dateTo, activeTab, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      if (activeTab !== 'all') params.set('workflow_stage', activeTab)
      params.set('page', String(page))
      params.set('page_size', String(pageSize))
      const response = await axios.get(`/api/orders?${params.toString()}`)
      return response.data
    }
  })
  const orders = orderPage?.data || []

  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ['suppliers'],
    queryFn: async () => (await axios.get('/api/suppliers')).data
  })

  const { data: riders = [] } = useQuery<Rider[]>({
    queryKey: ['riders'],
    queryFn: async () => (await axios.get('/api/riders')).data
  })

  const { data: couriers = [] } = useQuery<Courier[]>({
    queryKey: ['couriers'],
    queryFn: async () => (await axios.get('/api/couriers')).data
  })

  const { data: selectedOrderDetail, isLoading: isLoadingOrderDetail } = useQuery<OrderDetail>({
    queryKey: ['order-detail', selectedOrderId],
    enabled: Boolean(selectedOrderId),
    queryFn: async () => (await axios.get(`/api/orders/${selectedOrderId}`)).data
  })

  useEffect(() => {
    const order = selectedOrderDetail?.order
    if (order?.delivery_type === 'courier' && order.courier_payment_type === 'cod' && order.status === 'delivered') {
      setCodRemittanceAmount(String(Number(order.cod_outstanding || 0)))
    }
  }, [selectedOrderDetail])

  const { register, handleSubmit, reset, watch, setValue, getValues, formState: { errors } } = useForm<OrderFormData>({
    defaultValues: {
      sale_date: todayDate(),
      customer_name: '',
      customer_phone: '',
      customer_address: '',
      customer_notes: '',
      delivery_type: 'walk_in',
      rider_id: '',
      courier_id: '',
      courier_tracking_number: '',
      courier_payment_type: 'prepaid',
      delivery_fee_payment_method: 'paid_to_courier',
      customer_delivery_fee: undefined,
      actual_rider_fee: undefined,
      actual_courier_fee: undefined,
      delivery_notes: '',
      payment_method: 'cash',
      notes: '',
      items: [{ ...blankItem }]
    }
  })

  const watchedItems = watch('items') || []
  const deliveryType = watch('delivery_type')
  const paymentMethod = watch('payment_method')
  const courierPaymentType = watch('courier_payment_type')
  const deliveryFeePaymentMethod = watch('delivery_fee_payment_method')
  const customerDeliveryFee = Number(watch('customer_delivery_fee') || 0)
  const actualDeliveryCost = deliveryType === 'rider'
    ? Number(watch('actual_rider_fee') || 0)
    : deliveryType === 'courier'
      ? Number(watch('actual_courier_fee') || 0)
      : 0
  const speedafPassThroughFee = deliveryType === 'courier' && ['paid_to_courier', 'pay_on_delivery'].includes(deliveryFeePaymentMethod)
  const deliveryMarginPreview = speedafPassThroughFee ? 0 : customerDeliveryFee - actualDeliveryCost
  const customerNameRequired = paymentMethod === 'credit'
  const customerPhoneRequired = deliveryType !== 'walk_in' || paymentMethod === 'credit' || paymentMethod === 'pay_on_delivery'
  const customerAddressRequired = deliveryType !== 'walk_in'

  useEffect(() => {
    const currentPaymentMethod = getValues('payment_method')

    if (deliveryType === 'courier') {
      if (courierPaymentType === 'cod') {
        setValue('payment_method', 'pay_on_delivery')
      } else if (currentPaymentMethod === 'pay_on_delivery') {
        setValue('payment_method', 'cash')
      }
    } else if (deliveryType === 'rider') {
      setValue('payment_method', 'pay_on_delivery')
    } else if (currentPaymentMethod === 'pay_on_delivery') {
      setValue('payment_method', 'cash')
    }
  }, [courierPaymentType, deliveryType, getValues, setValue])

  const resetOrderForm = () => {
    setEditingOrderId(null)
    setFormError('')
    reset({
      sale_date: todayDate(),
      customer_name: '',
      customer_phone: '',
      customer_address: '',
      customer_notes: '',
      delivery_type: 'walk_in',
      rider_id: '',
      courier_id: '',
      courier_tracking_number: '',
      courier_payment_type: 'prepaid',
      delivery_fee_payment_method: 'paid_to_courier',
      customer_delivery_fee: undefined,
      actual_rider_fee: undefined,
      actual_courier_fee: undefined,
      delivery_notes: '',
      payment_method: 'cash',
      notes: '',
      items: [{ ...blankItem }]
    })
  }

  const buildOrderPayload = (data: OrderFormData) => ({
    ...data,
    sale_date: data.sale_date || todayDate(),
    payment_method: data.delivery_type === 'courier' && data.courier_payment_type === 'cod'
      ? 'pay_on_delivery'
      : data.payment_method,
    courier_payment_type: data.delivery_type === 'courier' ? data.courier_payment_type : undefined,
    delivery_fee_payment_method: data.delivery_type === 'courier' ? data.delivery_fee_payment_method : undefined,
    items: data.items.map(item => ({
      ...item,
      fulfillment_source: item.fulfillment_source === 'supplier' ? 'supplier_fulfilled' : 'shop_stock'
    }))
  })

  const createOrder = useMutation({
    mutationFn: async (data: OrderFormData) => {
      setFormError('')
      const response = await axios.post('/api/orders', buildOrderPayload(data))
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      queryClient.invalidateQueries({ queryKey: ['riders'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setShowCreateForm(false)
      resetOrderForm()
    },
    onError: (error: any) => {
      setFormError(error.response?.data?.error?.message || 'Failed to save order')
    }
  })

  const updateOrder = useMutation({
    mutationFn: async (data: OrderFormData) => {
      if (!editingOrderId) throw new Error('No order selected for editing')
      setFormError('')
      const response = await axios.put(`/api/orders/${editingOrderId}`, buildOrderPayload(data))
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['order-detail', editingOrderId] })
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      queryClient.invalidateQueries({ queryKey: ['riders'] })
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['receipts'] })
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setSelectedOrderId(null)
      setShowCreateForm(false)
      resetOrderForm()
    },
    onError: (error: any) => {
      setFormError(error.response?.data?.error?.message || error.message || 'Failed to update order')
    }
  })

  const updateOrderStatus = useMutation({
    mutationFn: async () => {
      if (!selectedOrderId || !selectedStatus) return null
      setStatusError('')
      const response = await axios.put(`/api/orders/${selectedOrderId}/status`, {
        status: selectedStatus,
        notes: statusNotes,
        completion_payment_method: completionPaymentMethod
      })
      return response.data
    },
    onSuccess: (updatedOrder) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['order-detail', selectedOrderId] })
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['receipts'] })
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      queryClient.invalidateQueries({ queryKey: ['riders'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setStatusNotes('')
      if (updatedOrder) setSelectedStatus(validStatusOptions(updatedOrder)[0]?.value || '')
    },
    onError: (error: any) => {
      setStatusError(error.response?.data?.error?.message || 'Failed to update order status')
    }
  })

  const recordCodRemittance = useMutation({
    mutationFn: async () => {
      if (!selectedOrderId) return null
      setStatusError('')
      const amount = Number(codRemittanceAmount)
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter the amount received from Speedaf')
      if (!codRemittanceReference.trim()) throw new Error('Enter the Speedaf payment reference')
      return (await axios.post(`/api/deliveries/orders/${selectedOrderId}/cod`, {
        amount,
        payment_method: codRemittanceMethod,
        reference: codRemittanceReference.trim()
      })).data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['order-detail', selectedOrderId] })
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      queryClient.invalidateQueries({ queryKey: ['reports-overview'] })
      setCodRemittanceAmount('')
      setCodRemittanceReference('')
      setStatusError('')
    },
    onError: (error: any) => {
      setStatusError(error.response?.data?.error?.message || error.message || 'Failed to record Speedaf remittance')
    }
  })

  const selectProduct = (index: number, product: Product) => {
    setValue(`items.${index}.product_id`, product.id, { shouldValidate: true })
    setValue(`items.${index}.product_name`, product.name)
    setValue(`items.${index}.sku`, product.sku || '')
    setValue(`items.${index}.category_name`, product.category_name || '')
    setValue(`items.${index}.available_stock`, Number(product.available_stock || 0))
    setValue(`items.${index}.selling_price`, product.selling_price)
    setValue(`items.${index}.fulfillment_source`, Number(product.available_stock || 0) > 0 ? 'internal' : 'supplier')
  }

  const addItem = () => {
    reset({ ...watch(), items: [...watchedItems, { ...blankItem }] })
  }

  const removeItem = (index: number) => {
    reset({ ...watch(), items: watchedItems.filter((_, itemIndex) => itemIndex !== index) })
  }

  const simplifiedStatus = (status: string, order?: Order) => {
    if (status === 'packed') return 'confirmed'
    if (status === 'dispatched') return 'in_transit'
    if (status === 'collected_paid' && order?.courier_payment_type !== 'cod') return 'delivered'
    return status
  }

  const workflowStage = (order: Order) => {
    const status = simplifiedStatus(order.status, order)
    if (['pending', 'confirmed'].includes(status)) return 'pending'
    if (status === 'in_transit') return 'in_transit'
    if (order.delivery_type === 'courier' && order.courier_payment_type === 'cod' && status === 'delivered') return 'pending_payment'
    if (['delivered', 'collected_paid'].includes(status)) return 'completed'
    return status
  }

  const nextOrderStatuses = (order: Order) => {
    const stage = workflowStage(order)
    const normalizedStatus = simplifiedStatus(order.status, order)
    if (normalizedStatus === 'pending') return ['confirmed']
    if (normalizedStatus === 'confirmed') {
      return order.delivery_type === 'walk_in' ? ['delivered'] : ['in_transit']
    }
    if (stage === 'in_transit') return ['delivered']
    return []
  }

  const nextStatusLabel = (order: Order, status: string) => {
    if (status === 'confirmed') return 'Confirm Order'
    if (status === 'in_transit') return 'Dispatch / Mark In Transit'
    if (status === 'delivered' && order.delivery_type === 'courier' && order.courier_payment_type === 'cod') return 'Client Collected - Await Payment'
    if (status === 'delivered' && order.delivery_type === 'rider') return 'Delivered - Complete Order'
    if (status === 'delivered') return 'Complete Order'
    return statusLabel(status, order)
  }

  const validStatusOptions = (order: Order) => {
    const options: Array<{ value: string; label: string }> = nextOrderStatuses(order)
      .map(status => ({ value: status, label: nextStatusLabel(order, status) }))
    if (hasPermission('orders.cancel')) {
      const stage = workflowStage(order)
      if (stage === 'pending') options.push({ value: 'cancelled', label: 'Cancel Order' })
      if (stage === 'in_transit') options.push({ value: 'returned', label: 'Mark Returned' })
    }
    return options
  }

  const canEditOrderDetails = (order: Order) => ['pending', 'confirmed'].includes(simplifiedStatus(order.status, order))
  const canUpdateOrderStatus = () => hasPermission('orders.status') || hasPermission('orders.edit')

  const editableDate = (value?: string | null) => {
    const dateOnly = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
    return dateOnly || todayDate()
  }

  const openOrderEdit = (detail: OrderDetail) => {
    const order = detail.order
    const deliveryTypeValue = (order.delivery_type || 'walk_in') as OrderFormData['delivery_type']
    const paymentMethodValue = order.courier_payment_type === 'cod'
      ? 'pay_on_delivery'
      : ((order.last_payment_method || (order.payment_status === 'pending' ? 'pay_on_delivery' : 'cash')) as OrderFormData['payment_method'])

    setEditingOrderId(order.id)
    setSelectedOrderId(null)
    setShowCreateForm(true)
    setFormError('')
    reset({
      sale_date: editableDate(order.sale_date || order.created_at),
      customer_name: order.customer_name || '',
      customer_phone: order.customer_phone || '',
      customer_address: order.customer_address || '',
      customer_notes: '',
      delivery_type: deliveryTypeValue,
      rider_id: order.rider_id || '',
      courier_id: order.courier_id || '',
      courier_tracking_number: order.courier_tracking_number || '',
      courier_payment_type: (order.courier_payment_type || 'prepaid') as OrderFormData['courier_payment_type'],
      delivery_fee_payment_method: (order.delivery_fee_payment_method || 'paid_to_courier') as OrderFormData['delivery_fee_payment_method'],
      customer_delivery_fee: deliveryTypeValue === 'courier'
        ? Number(order.courier_customer_fee || order.delivery_income || 0) || undefined
        : Number(order.delivery_income || 0) || undefined,
      actual_rider_fee: deliveryTypeValue === 'rider' ? Number(order.delivery_cost || 0) || undefined : undefined,
      actual_courier_fee: deliveryTypeValue === 'courier' ? Number(order.courier_actual_fee || order.delivery_cost || 0) || undefined : undefined,
      delivery_notes: '',
      payment_method: paymentMethodValue,
      notes: order.notes || '',
      items: detail.items.map(item => ({
        product_id: item.product_id,
        product_name: item.product_name || '',
        sku: item.sku || '',
        category_name: item.category_name || '',
        available_stock: Number(item.available_stock || 0),
        quantity: Number(item.quantity || 1),
        selling_price: Number(item.unit_price || 0),
        fulfillment_source: Number(item.supplier_quantity || 0) > 0 || item.fulfillment_type === 'supplier' ? 'supplier' : 'internal',
        supplier_id: item.supplier_id || '',
        supplier_cost: Number(item.supplier_cost || 0) || undefined
      }))
    })
  }

  const filteredOrders = orders
  const tabs = [
    { id: 'all', label: 'All Orders' },
    { id: 'pending', label: 'Pending' },
    { id: 'in_transit', label: 'Dispatched / In Transit' },
    { id: 'pending_payment', label: 'Pending Payment' },
    { id: 'completed', label: 'Completed' }
  ]

  const statusOptions = [
    { value: 'pending', label: 'Pending' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'in_transit', label: 'Dispatched / In Transit' },
    { value: 'delivered', label: 'Completed' },
    { value: 'returned', label: 'Returned' },
    { value: 'cancelled', label: 'Cancelled' }
  ]

  const statusLabel = (status: string, order?: Order) => {
    if (order?.delivery_type === 'courier' && order.courier_payment_type === 'cod') {
      if (status === 'in_transit' || status === 'dispatched') return 'Dispatched / In Transit'
      if (status === 'delivered') return 'Pending Payment'
      if (status === 'collected_paid') return 'Completed'
    }
    const normalizedStatus = simplifiedStatus(status, order)
    return statusOptions.find(option => option.value === normalizedStatus)?.label || status.replace('_', ' ')
  }

  const statusColors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    confirmed: 'bg-blue-100 text-blue-800',
    in_transit: 'bg-blue-100 text-blue-800',
    delivered: 'bg-green-100 text-green-800',
    collected_paid: 'bg-emerald-100 text-emerald-800',
    returned: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-800'
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Orders</h1>
          <p className="text-muted-foreground">Create orders and update customers, stock, suppliers, delivery and payments</p>
        </div>
        {hasPermission('orders.create') && <button
          onClick={() => { resetOrderForm(); setShowCreateForm(true) }}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 sm:px-4"
        >
          <Plus className="h-4 w-4" />
          New Order
        </button>}
      </div>

      {showCreateForm && (
        <div className="order-create-panel border rounded-lg p-6 bg-card">
          <div className="order-create-header flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold">{editingOrderId ? 'Edit Order' : 'New Order'}</h2>
              <p className="text-xs text-muted-foreground md:hidden">Customer, products, delivery and payment</p>
            </div>
            <button type="button" onClick={() => { setShowCreateForm(false); resetOrderForm() }} className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close new order">
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit(data => editingOrderId ? updateOrder.mutate(data) : createOrder.mutate(data))} className="space-y-6">
            <section>
              <h3 className="font-medium mb-3">A. Customer Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="text-sm font-medium md:col-span-2">
                  Sale date *
                  <input
                    type="date"
                    {...register('sale_date', { required: 'Sale date is required' })}
                    className="mt-1 w-full px-3 py-2 border rounded-lg"
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">Use the real business date, even if you enter the order later after an outage.</span>
                  {errors.sale_date && <span className="mt-1 block text-xs text-destructive">{errors.sale_date.message}</span>}
                </label>
                <label className="text-sm font-medium">
                  Customer name{customerNameRequired ? ' *' : ''}
                  <input {...register('customer_name', { required: customerNameRequired ? 'Customer name is required for credit sales' : false })} className="mt-1 w-full px-3 py-2 border rounded-lg" placeholder={customerNameRequired ? 'Customer name' : 'Customer name (optional)'} />
                  {errors.customer_name && <span className="mt-1 block text-xs text-destructive">{errors.customer_name.message}</span>}
                </label>
                <label className="text-sm font-medium">
                  Phone number{customerPhoneRequired ? ' *' : ''}
                  <input {...register('customer_phone', { required: customerPhoneRequired ? 'Phone number is required for this order' : false })} className="mt-1 w-full px-3 py-2 border rounded-lg" placeholder="Phone number" />
                  {errors.customer_phone && <span className="mt-1 block text-xs text-destructive">{errors.customer_phone.message}</span>}
                </label>
                <label className="text-sm font-medium md:col-span-2">
                  Location / address{customerAddressRequired ? ' *' : ''}
                  <input {...register('customer_address', { required: customerAddressRequired ? 'Location is required for delivery orders' : false })} className="mt-1 w-full px-3 py-2 border rounded-lg" placeholder="Location / address" />
                  {errors.customer_address && <span className="mt-1 block text-xs text-destructive">{errors.customer_address.message}</span>}
                </label>
                <textarea {...register('customer_notes')} className="px-3 py-2 border rounded-lg md:col-span-2" placeholder="Customer notes" rows={2} />
              </div>
            </section>

            <section className="border-t pt-4">
              <h3 className="font-medium mb-3">B. Order Items</h3>
              <div className="space-y-4">
                {watchedItems.map((item, index) => (
                  <div key={index} className="order-item-card grid grid-cols-1 lg:grid-cols-6 gap-3 border rounded-lg p-3">
                    <input type="hidden" {...register(`items.${index}.product_id` as const, { required: true })} />
                    <ProductSearchSelect
                      value={item.product_id}
                      resultsId={`order-product-results-${index}`}
                      onChange={product => selectProduct(index, product)}
                      selectedProduct={item.product_id ? {
                        id: item.product_id,
                        name: item.product_name || 'Selected product',
                        sku: item.sku,
                        category_name: item.category_name,
                        selling_price: Number(item.selling_price || 0),
                        available_stock: item.available_stock
                      } : null}
                    />
                    <label className="text-xs font-medium text-muted-foreground lg:contents"><span className="lg:hidden">Quantity</span><input type="number" {...register(`items.${index}.quantity` as const, { valueAsNumber: true, min: 1 })} className="mt-1 w-full px-3 py-2 border rounded-lg lg:mt-0" placeholder="Quantity" /></label>
                    <label className="text-xs font-medium text-muted-foreground lg:contents"><span className="lg:hidden">Selling price</span><input type="number" {...register(`items.${index}.selling_price` as const, { valueAsNumber: true, min: 0 })} className="mt-1 w-full px-3 py-2 border rounded-lg lg:mt-0" placeholder="Selling price" /></label>
                    <select {...register(`items.${index}.fulfillment_source` as const)} className="px-3 py-2 border rounded-lg">
                      <option value="internal">Shop Stock</option>
                      <option value="supplier">Supplier Fulfilled</option>
                    </select>
                    <button type="button" onClick={() => removeItem(index)} className="px-3 py-2 border rounded-lg text-destructive disabled:opacity-50" disabled={watchedItems.length === 1}>
                      Remove
                    </button>
                    {item.fulfillment_source === 'supplier' && (
                      <>
                        <select {...register(`items.${index}.supplier_id` as const)} className="px-3 py-2 border rounded-lg lg:col-span-3">
                          <option value="">Supplier</option>
                          {suppliers.map(supplier => (
                            <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                          ))}
                        </select>
                        <input type="number" {...register(`items.${index}.supplier_cost` as const, { valueAsNumber: true, min: 0 })} className="px-3 py-2 border rounded-lg lg:col-span-3" placeholder="Supplier cost per item" />
                      </>
                    )}
                  </div>
                ))}
              </div>
              <button type="button" onClick={addItem} className="mt-3 text-sm text-primary hover:underline">+ Add another item</button>
            </section>

            <section className="border-t pt-4">
              <h3 className="font-medium mb-3">C. Delivery Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <select {...register('delivery_type')} aria-label="Delivery Type" className="px-3 py-2 border rounded-lg">
                  <option value="walk_in">Walk-In</option>
                  <option value="rider">Rider</option>
                  <option value="courier">Courier</option>
                </select>

                {deliveryType !== 'walk_in' && (
                  <label className="text-sm">
                    Customer Delivery Fee Charged
                    <input type="number" step="0.01" {...register('customer_delivery_fee', { valueAsNumber: true })} className="mt-1 w-full px-3 py-2 border rounded-lg" placeholder="Amount charged to customer" />
                  </label>
                )}

                {deliveryType === 'rider' && (
                  <>
                    <select {...register('rider_id')} className="px-3 py-2 border rounded-lg">
                      <option value="">Select rider</option>
                      {riders.map(rider => <option key={rider.id} value={rider.id}>{rider.name}</option>)}
                    </select>
                    <label className="text-sm">
                      Actual Rider Fee
                      <input type="number" step="0.01" {...register('actual_rider_fee', { valueAsNumber: true })} className="mt-1 w-full px-3 py-2 border rounded-lg" placeholder="Amount payable to rider" />
                    </label>
                  </>
                )}

                {deliveryType === 'courier' && (
                  <>
                    <select {...register('courier_id')} aria-label="Courier" className="px-3 py-2 border rounded-lg">
                      <option value="">Select courier</option>
                      {couriers.map(courier => <option key={courier.id} value={courier.id}>{courier.name}</option>)}
                    </select>
                    <input {...register('courier_tracking_number')} className="px-3 py-2 border rounded-lg" placeholder="Tracking number" />
                    <label className="text-sm">
                      Actual Courier Fee
                      <input type="number" step="0.01" {...register('actual_courier_fee', { valueAsNumber: true })} className="mt-1 w-full px-3 py-2 border rounded-lg" placeholder="Amount charged by courier" />
                    </label>
                    <label className="text-sm">
                      Item Payment Through Courier
                      <select {...register('courier_payment_type')} aria-label="Speedaf Item Collection" className="mt-1 w-full px-3 py-2 border rounded-lg">
                        <option value="prepaid">Item already paid / no item COD</option>
                        <option value="cod">Speedaf collects item amount on delivery</option>
                      </select>
                    </label>
                    <label className="text-sm md:col-span-2">
                      Delivery Fee Handling
                      <select {...register('delivery_fee_payment_method')} aria-label="Delivery Fee Handling" className="mt-1 w-full px-3 py-2 border rounded-lg">
                        <option value="paid_to_courier">Client paid Speedaf directly</option>
                        <option value="pay_on_delivery">Speedaf collects delivery fee on delivery</option>
                        <option value="mpesa">Client paid shop by M-PESA</option>
                        <option value="cash">Client paid shop by Cash</option>
                        <option value="bank_transfer">Client paid shop by Bank</option>
                      </select>
                    </label>
                  </>
                )}

                {deliveryType !== 'walk_in' && (
                  <textarea {...register('delivery_notes')} className="px-3 py-2 border rounded-lg md:col-span-2" placeholder="Delivery notes" rows={2} />
                )}

                {deliveryType !== 'walk_in' && (
                  <div className={`rounded-lg border px-4 py-3 md:col-span-2 ${deliveryMarginPreview === 0 ? 'bg-muted/40' : deliveryMarginPreview < 0 ? 'border-destructive/40 bg-destructive/5' : 'border-primary/30 bg-primary/5'}`}>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm font-medium">Delivery Margin Preview</div>
                        <div className="text-xs text-muted-foreground">
                          {speedafPassThroughFee
                            ? 'Speedaf handles this fee, so it is not counted as shop income or delivery cost'
                            : 'Customer delivery fee minus actual delivery cost'}
                        </div>
                      </div>
                      <strong className={deliveryMarginPreview < 0 ? 'text-destructive' : ''}>
                        {formatMoney(deliveryMarginPreview)}
                      </strong>
                    </div>
                    {deliveryMarginPreview !== 0 && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Confirm both delivery amounts before saving. This difference will appear on the dashboard.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section className="border-t pt-4">
              <h3 className="font-medium mb-3">
                D. Payment Details
              </h3>
              {deliveryType === 'courier' && courierPaymentType === 'cod' ? (
                <div className="max-w-2xl rounded-lg border bg-muted/30 px-4 py-3 text-sm">
                  <div className="font-medium">Item payment: Speedaf collects on delivery</div>
                  <p className="text-sm text-muted-foreground">
                    {deliveryFeePaymentMethod === 'paid_to_courier' &&
                      'The delivery fee was paid directly to Speedaf, so it will not be counted as shop income or delivery cost.'}
                    {deliveryFeePaymentMethod === 'pay_on_delivery' &&
                      'Speedaf will collect the product amount and delivery fee from the customer. Only the product amount becomes COD owed to the shop; the delivery fee is a Speedaf pass-through.'}
                    {['cash', 'mpesa', 'bank_transfer'].includes(deliveryFeePaymentMethod) &&
                      `Only the delivery fee of ${formatMoney(customerDeliveryFee)} is recorded as paid to the shop now. Speedaf will collect the product amount.`}
                  </p>
                </div>
              ) : (
                <div className="max-w-xl space-y-2">
                  <select {...register('payment_method')} aria-label="Payment Method" className="w-full md:w-96 px-3 py-2 border rounded-lg">
                    {deliveryType === 'rider' && <option value="pay_on_delivery">Rider collects on delivery</option>}
                    <option value="cash">{deliveryType === 'rider' ? 'Cash already received' : 'Cash'}</option>
                    <option value="mpesa">{deliveryType === 'rider' ? 'M-PESA already received' : 'M-PESA'}</option>
                    <option value="bank_transfer">{deliveryType === 'rider' ? 'Bank payment already received' : 'Bank'}</option>
                    <option value="credit">Credit</option>
                  </select>
                  {deliveryType === 'rider' && (
                    <p className="text-sm text-muted-foreground">
                      {paymentMethod === 'pay_on_delivery'
                        ? 'Print a Delivery Note for dispatch. The final paid receipt becomes valid after delivery and payment confirmation.'
                        : 'Choose an already-received method only when the money is visible in cash, M-PESA, or the bank.'}
                    </p>
                  )}
                </div>
              )}
            </section>

            <section className="border-t pt-4">
              <h3 className="font-medium mb-3">E. Notes</h3>
              <textarea {...register('notes')} className="w-full px-3 py-2 border rounded-lg" placeholder="Order notes" rows={2} />
            </section>

            <div className="order-create-actions flex gap-2 pt-2">
              {formError && (
                <div className="flex-1 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {formError}
                </div>
              )}
              <button type="submit" disabled={createOrder.isPending || updateOrder.isPending} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50">
                {createOrder.isPending || updateOrder.isPending
                  ? 'Saving...'
                  : editingOrderId ? 'Update Order' : 'Save Order'}
              </button>
              <button type="button" onClick={() => { setShowCreateForm(false); resetOrderForm() }} className="px-4 py-2 border rounded-lg">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="border-b">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); setPage(1) }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search orders..."
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1) }}
            className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
          />
        </div>
        <DateRangeFilter
          dateFrom={dateFrom}
          dateTo={dateTo}
          compact
          onChange={range => { setDateFrom(range.dateFrom); setDateTo(range.dateTo); setPage(1) }}
          onClear={() => { setDateFrom(''); setDateTo(''); setPage(1) }}
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(5)].map((_, index) => <div key={index} className="h-16 bg-muted rounded-lg animate-pulse" />)}</div>
      ) : filteredOrders.length === 0 ? (
        <div className="text-center py-16">
          <Package className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No orders found</h3>
          <p className="text-muted-foreground mt-1">{search ? 'Try adjusting your search' : 'Create your first order'}</p>
        </div>
      ) : (
        <div className="mobile-scroll-table border rounded-lg overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Order #</th>
                <th className="text-left px-4 py-3 font-medium">Customer</th>
                <th className="text-left px-4 py-3 font-medium">Destination</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Payment</th>
                <th className="text-left px-4 py-3 font-medium">Total</th>
                <th className="text-left px-4 py-3 font-medium">Delivery Margin</th>
                <th className="text-left px-4 py-3 font-medium">Date</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map(order => (
                <tr key={order.id} className="border-t hover:bg-muted/50 transition-colors">
                  <td className="px-4 py-3 font-medium">{order.order_number}</td>
                  <td className="px-4 py-3 text-sm">{order.customer_name || '-'}</td>
                  <td className="max-w-56 px-4 py-3 text-sm" title={order.customer_address || ''}>
                    <span className="block truncate">{order.delivery_type === 'walk_in' ? 'Walk-in' : order.customer_address || '-'}</span>
                  </td>
                  <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[simplifiedStatus(order.status, order)] || 'bg-muted text-muted-foreground'}`}>{statusLabel(order.status, order)}</span></td>
                  <td className="px-4 py-3 text-sm capitalize">{order.payment_status.replace('_', ' ')}</td>
                  <td className="px-4 py-3 font-medium">{formatMoney(order.total_amount)}</td>
                  <td className="px-4 py-3 text-sm">{formatMoney((order.delivery_income || 0) - (order.delivery_cost || 0))}</td>
                  <td className="px-4 py-3 text-sm">{displayBusinessDate(order.sale_date, order.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedOrderId(order.id)
                        setSelectedStatus(validStatusOptions(order)[0]?.value || '')
                        setCompletionPaymentMethod('cash')
                        setStatusNotes('')
                        setStatusError('')
                        setCodRemittanceAmount('')
                        setCodRemittanceMethod('mpesa')
                        setCodRemittanceReference('')
                      }}
                      className="p-1.5 text-muted-foreground hover:text-primary rounded"
                      title="View order"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {orderPage && <Pagination meta={orderPage.pagination} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} />}
        </div>
      )}

      {selectedOrderId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">Order Details</h2>
                <p className="text-sm text-muted-foreground">
                  {selectedOrderDetail?.order.order_number || 'Loading order...'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {selectedOrderDetail && hasPermission('orders.edit') && canEditOrderDetails(selectedOrderDetail.order) && (
                  <button
                    type="button"
                    onClick={() => openOrderEdit(selectedOrderDetail)}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-muted"
                    title="Edit open order"
                  >
                    <Edit className="h-4 w-4" />
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedOrderId(null)}
                  className="rounded p-1.5 text-muted-foreground hover:text-foreground"
                  title="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {isLoadingOrderDetail ? (
              <div className="p-6 text-sm text-muted-foreground">Loading order details...</div>
            ) : selectedOrderDetail ? (
              <div className="space-y-6 p-6">
                {canUpdateOrderStatus() && <div className="rounded-lg border p-4">
                  <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr_auto] gap-3 items-end">
                    <div>
                      <label className="block text-sm font-medium mb-1">Next Action</label>
                      {validStatusOptions(selectedOrderDetail.order).length > 0 ? <select
                        value={selectedStatus}
                        onChange={(event) => setSelectedStatus(event.target.value)}
                        className="w-full px-3 py-2 border rounded-lg"
                      >
                        {validStatusOptions(selectedOrderDetail.order).map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select> : <div className="rounded-lg border bg-muted px-3 py-2 text-sm">
                        {workflowStage(selectedOrderDetail.order) === 'pending_payment'
                          ? 'Waiting for Speedaf remittance'
                          : 'No further order action required'}
                      </div>}
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Status Notes</label>
                      <input
                        value={statusNotes}
                        onChange={(event) => setStatusNotes(event.target.value)}
                        className="w-full px-3 py-2 border rounded-lg"
                        placeholder="Optional reason or delivery note"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => updateOrderStatus.mutate()}
                      disabled={updateOrderStatus.isPending || !selectedStatus}
                      className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
                    >
                      {updateOrderStatus.isPending ? 'Updating...' : 'Update Status'}
                    </button>
                  </div>
                  {selectedStatus === 'delivered' && selectedOrderDetail.order.delivery_type === 'rider' && selectedOrderDetail.order.payment_status !== 'paid' && (
                    <div className="mt-3 max-w-sm">
                      <label className="block text-sm font-medium mb-1">Payment Received Via</label>
                      <select value={completionPaymentMethod} onChange={event => setCompletionPaymentMethod(event.target.value)} className="w-full rounded-lg border px-3 py-2">
                        <option value="cash">Cash</option>
                        <option value="mpesa">M-PESA</option>
                        <option value="bank_transfer">Bank</option>
                      </select>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    Status changes here update the order, delivery tracking, COD tracking, and related payable records automatically.
                  </p>
                  {statusError && workflowStage(selectedOrderDetail.order) !== 'pending_payment' && <div className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{statusError}</div>}
                </div>}

                {workflowStage(selectedOrderDetail.order) === 'pending_payment' && hasPermission('cod.remit') && (
                  <section className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                    <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <h3 className="font-semibold">Record Speedaf Remittance</h3>
                        <p className="text-sm text-muted-foreground">When the full outstanding amount is received, this order becomes paid and completed automatically.</p>
                      </div>
                      <div className="mt-2 shrink-0 text-sm sm:mt-0 sm:text-right">
                        <div className="text-muted-foreground">Outstanding COD</div>
                        <strong className="text-lg">{formatMoney(selectedOrderDetail.order.cod_outstanding)}</strong>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="text-sm">Amount Received
                        <input type="number" min="0.01" max={Number(selectedOrderDetail.order.cod_outstanding || 0)} step="0.01" value={codRemittanceAmount} onChange={event => setCodRemittanceAmount(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" placeholder="Amount received" />
                      </label>
                      <label className="text-sm">Received Via
                        <select value={codRemittanceMethod} onChange={event => setCodRemittanceMethod(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2">
                          <option value="mpesa">M-PESA</option>
                          <option value="bank_transfer">Bank</option>
                        </select>
                      </label>
                      <label className="text-sm md:col-span-2">Payment Reference <span className="text-destructive">*</span>
                        <input value={codRemittanceReference} onChange={event => setCodRemittanceReference(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" placeholder="Enter the M-Pesa transaction code or bank reference" />
                      </label>
                      <div className="flex flex-col gap-2 md:col-span-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs text-muted-foreground">
                          {!codRemittanceReference.trim()
                            ? 'Enter the payment reference to enable confirmation.'
                            : 'The reference prevents the same remittance from being recorded twice.'}
                        </p>
                        <button type="button" onClick={() => recordCodRemittance.mutate()} disabled={recordCodRemittance.isPending || Number(codRemittanceAmount) <= 0 || !codRemittanceReference.trim()} className="shrink-0 rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
                          {recordCodRemittance.isPending ? 'Recording...' : 'Confirm Payment'}
                        </button>
                      </div>
                    </div>
                    {statusError && <div className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{statusError}</div>}
                  </section>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Customer</p>
                    <p className="font-medium">{selectedOrderDetail.order.customer_name || '-'}</p>
                    <p className="text-sm text-muted-foreground">{selectedOrderDetail.order.customer_phone || '-'}</p>
                    <p className="text-sm text-muted-foreground">{selectedOrderDetail.order.customer_address || '-'}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Payment</p>
                    <p className="font-medium capitalize">{selectedOrderDetail.order.payment_status?.replace('_', ' ') || '-'}</p>
                    <p className="text-sm text-muted-foreground">Paid: {formatMoney(selectedOrderDetail.order.paid_amount)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Delivery</p>
                    <p className="font-medium capitalize">{selectedOrderDetail.order.delivery_type?.replace('_', ' ') || '-'}</p>
                    <p className="text-sm text-muted-foreground">
                      {selectedOrderDetail.order.rider_name || selectedOrderDetail.order.courier_name || 'Walk-in'}
                    </p>
                    <OrderTrackingLink order={selectedOrderDetail.order} />
                  </div>
                </div>

                <div className="mobile-scroll-table border rounded-lg overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left px-4 py-3 font-medium">Product</th>
                        <th className="text-left px-4 py-3 font-medium">Source</th>
                        <th className="text-right px-4 py-3 font-medium">Qty</th>
                        <th className="text-right px-4 py-3 font-medium">Price</th>
                        <th className="text-right px-4 py-3 font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedOrderDetail.items.map(item => (
                        <tr key={item.id} className="border-t">
                          <td className="px-4 py-3">{item.product_name || '-'}</td>
                          <td className="px-4 py-3 capitalize">{(item.fulfillment_type || '-').replace('_', ' ')}</td>
                          <td className="px-4 py-3 text-right">{item.quantity}</td>
                          <td className="px-4 py-3 text-right">{formatMoney(item.unit_price)}</td>
                          <td className="px-4 py-3 text-right font-medium">{formatMoney(item.total_price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 rounded-lg border p-4">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Subtotal</p>
                    <p className="font-semibold">{formatMoney(selectedOrderDetail.order.subtotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Delivery Income</p>
                    <p className="font-semibold">{formatMoney(selectedOrderDetail.order.delivery_income)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Delivery Cost</p>
                    <p className="font-semibold">{formatMoney(selectedOrderDetail.order.delivery_cost)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Total</p>
                    <p className="font-semibold">{formatMoney(selectedOrderDetail.order.total_amount)}</p>
                  </div>
                  {selectedOrderDetail.order.delivery_type === 'courier' && Number(selectedOrderDetail.order.courier_customer_fee || 0) > 0 && (
                    <div className="md:col-span-4 rounded-lg bg-muted/40 px-3 py-2 text-sm">
                      <div className="font-medium">Speedaf fee shown to customer: {formatMoney(selectedOrderDetail.order.courier_customer_fee)}</div>
                      <div className="text-muted-foreground">
                        {['paid_to_courier', 'pay_on_delivery'].includes(selectedOrderDetail.order.delivery_fee_payment_method || '')
                          ? 'This fee is handled by Speedaf and is not included in shop sales, delivery cost, or profit.'
                          : 'This fee was handled by the shop and is included in delivery income/cost above.'}
                      </div>
                    </div>
                  )}
                </div>

                {selectedOrderDetail.order.notes && (
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Notes</p>
                    <p className="text-sm">{selectedOrderDetail.order.notes}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-6 text-sm text-destructive">Could not load this order.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
