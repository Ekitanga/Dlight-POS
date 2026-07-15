import { useState, useEffect } from 'react'
import { Plus, Search, ShoppingCart, Trash2, CreditCard, Banknote, Smartphone, Wallet, X } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { formatMoney } from '../../lib/format'

interface Product {
  id: string
  name: string
  selling_price: number
  barcode?: string
  sku?: string
}

interface CartItem {
  product: Product
  quantity: number
  discount: number
}

export function POS() {
  const [searchTerm, setSearchTerm] = useState('')
  const [cart, setCart] = useState<CartItem[]>([])
  const [orderSuccess, setOrderSuccess] = useState(false)
  const queryClient = useQueryClient()

  const { data: products = [], isLoading: productsLoading, error: productsError } = useQuery<Product[]>({
    queryKey: ['products', searchTerm],
    queryFn: async () => {
      const response = await axios.get(`/api/products?search=${searchTerm}`)
      return response.data
    },
    enabled: true
  })

  const createOrder = useMutation({
    mutationFn: async (orderData: any) => {
      const response = await axios.post('/api/orders', orderData)
      return response.data
    },
    onSuccess: () => {
      setOrderSuccess(true)
      setCart([])
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    }
  })

  const total = cart.reduce((sum, item) => sum + (item.product.selling_price * item.quantity - item.discount), 0)

  const addToCart = (product: Product) => {
    setCart(prev => {
      const existing = prev.find(item => item.product.id === product.id)
      if (existing) {
        return prev.map(item => item.product.id === product.id 
          ? { ...item, quantity: item.quantity + 1 } 
          : item)
      }
      return [...prev, { product, quantity: 1, discount: 0 }]
    })
  }

  const removeFromCart = (productId: string) => {
    setCart(prev => prev.filter(item => item.product.id !== productId))
  }

  const updateQuantity = (productId: string, quantity: number) => {
    if (quantity < 1) return
    setCart(prev => prev.map(item => 
      item.product.id === productId ? { ...item, quantity } : item
    ))
  }

  const handlePayment = (method: string) => {
    if (cart.length === 0) return
    createOrder.mutate({
      items: cart.map(item => ({
        product_id: item.product.id,
        quantity: item.quantity,
        discount: item.discount
      })),
      payment_method: method,
      delivery_type: 'walk_in'
    })
  }

  const clearSearch = () => setSearchTerm('')

  useEffect(() => {
    if (orderSuccess) {
      setTimeout(() => setOrderSuccess(false), 3000)
    }
  }, [orderSuccess])

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <div>
              <h1 className="text-2xl font-bold">Point of Sale</h1>
              <p className="text-muted-foreground">Create and manage sales transactions</p>
            </div>
            
            {orderSuccess && (
              <div className="p-3 bg-green-100 text-green-800 rounded-lg text-sm">
                Order created successfully!
              </div>
            )}
            
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search products by name, SKU or barcode..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-10 py-2.5 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
              />
              {searchTerm && (
                <button
                  onClick={clearSearch}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {productsLoading && (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
                ))}
              </div>
            )}

            {productsError && (
              <div className="p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
                Error loading products. Make sure the backend server is running.
              </div>
            )}

            {!productsLoading && !productsError && products.length === 0 && searchTerm && (
              <div className="text-center py-8 text-muted-foreground">
                No products found for &quot;{searchTerm}&quot;
              </div>
            )}

            {!productsLoading && !productsError && products.length > 0 && (
              <div className="border rounded-lg divide-y max-h-96 overflow-y-auto">
                {products.map(product => (
                  <div 
                    key={product.id} 
                    className="p-3 hover:bg-muted cursor-pointer transition-colors flex items-center justify-between"
                    onClick={() => addToCart(product)}
                  >
                    <div>
                      <p className="font-medium">{product.name}</p>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        {product.sku && <span className="bg-muted px-1.5 py-0.5 rounded text-xs">{product.sku}</span>}
                        <span>{formatMoney(product.selling_price)}</span>
                      </div>
                    </div>
                    <button className="p-1.5 bg-primary/10 text-primary rounded-lg hover:bg-primary/20">
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="bg-card rounded-lg border p-4">
              <div className="flex items-center gap-2 mb-4">
                <ShoppingCart className="h-5 w-5 text-primary" />
                <h2 className="font-semibold">Current Cart ({cart.length})</h2>
              </div>

              {cart.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <ShoppingCart className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>Cart is empty</p>
                  <p className="text-xs mt-1">Search and add products to get started</p>
                </div>
              ) : (
                <div className="space-y-3 max-h-64 overflow-y-auto">
                  {cart.map(item => (
                    <div key={item.product.id} className="flex items-center justify-between py-2 border-b last:border-0">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{item.product.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatMoney(item.product.selling_price)} × {item.quantity}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={item.quantity}
                          onChange={(e) => updateQuantity(item.product.id, parseInt(e.target.value) || 1)}
                          className="w-14 text-center text-sm border rounded"
                          min="1"
                        />
                        <button
                          onClick={() => removeFromCart(item.product.id)}
                          className="p-1 text-muted-foreground hover:text-destructive rounded"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}

                  <div className="border-t pt-3 mt-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium">Subtotal</span>
                      <span className="text-sm">{formatMoney(total)}</span>
                    </div>
                    <div className="flex justify-between items-center font-bold text-lg mt-1">
                      <span>Total</span>
                      <span className="text-primary">{formatMoney(total)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {cart.length > 0 && (
              <div className="bg-card rounded-lg border p-4">
                <h3 className="font-medium mb-3">Payment Method</h3>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handlePayment('cash')}
                    disabled={createOrder.isPending}
                    className="flex items-center justify-center gap-2 py-3 border rounded-lg hover:bg-muted transition-colors disabled:opacity-50 font-medium"
                  >
                    <Banknote className="h-4 w-4" />
                    Cash
                  </button>
                  <button
                    onClick={() => handlePayment('mpesa')}
                    disabled={createOrder.isPending}
                    className="flex items-center justify-center gap-2 py-3 border rounded-lg hover:bg-muted transition-colors disabled:opacity-50 font-medium"
                  >
                    <Smartphone className="h-4 w-4" />
                    M-PESA
                  </button>
                  <button
                    onClick={() => handlePayment('bank_transfer')}
                    disabled={createOrder.isPending}
                    className="flex items-center justify-center gap-2 py-3 border rounded-lg hover:bg-muted transition-colors disabled:opacity-50 font-medium"
                  >
                    <CreditCard className="h-4 w-4" />
                    Bank
                  </button>
                  <button
                    onClick={() => handlePayment('credit')}
                    disabled={createOrder.isPending}
                    className="flex items-center justify-center gap-2 py-3 border rounded-lg hover:bg-muted transition-colors disabled:opacity-50 font-medium"
                  >
                    <Wallet className="h-4 w-4" />
                    Credit
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
