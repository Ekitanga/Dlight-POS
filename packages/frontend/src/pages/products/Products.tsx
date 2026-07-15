import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { Download, Edit, Eye, FileUp, FolderPlus, Package, Plus, Trash2, X } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useAuthStore } from '../../stores/authStore'
import { PaginatedResponse, Pagination } from '../../components/Pagination'
import { formatMoney } from '../../lib/format'

interface Product {
  id: string
  name: string
  sku?: string
  barcode?: string
  category_id?: string
  category_name?: string
  brand_name?: string
  selling_price: number
  cost_price: number
  reorder_level: number
  is_dropship: boolean
  is_active: boolean
  available_stock?: number
}

interface Category {
  id: string
  name: string
  description?: string
  product_count: number
}

interface ProductFormData {
  name: string
  sku: string
  barcode: string
  category_id: string
  cost_price?: number
  selling_price?: number
  reorder_level?: number
  is_dropship: boolean
}

interface ImportSummary {
  processed: number
  created: number
  updated: number
  skipped: number
  archived: number
  errors: Array<{ row: number; message: string }>
}

const inputClass = 'w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary'

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      row.push(value.trim())
      value = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(value.trim())
      if (row.some(cell => cell !== '')) rows.push(row)
      row = []
      value = ''
    } else {
      value += character
    }
  }
  row.push(value.trim())
  if (row.some(cell => cell !== '')) rows.push(row)
  return rows
}

const normalizeHeader = (header: string) => header.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_|_$/g, '')

const headerAliases: Record<string, string[]> = {
  name: ['name', 'product_name', 'title'],
  sku: ['sku', 'product_sku'],
  barcode: ['barcode', 'ean', 'upc'],
  category: ['category', 'categories', 'product_category'],
  cost_price: ['cost_price', 'cost', 'purchase_price'],
  selling_price: ['selling_price', 'price', 'regular_price', 'sale_price'],
  reorder_level: ['reorder_level', 'low_stock_amount'],
  is_dropship: ['is_dropship', 'dropship', 'fulfillment'],
  stock_quantity: ['stock_quantity', 'stock', 'quantity'],
  in_stock: ['in_stock', 'is_in_stock']
}

export function Products() {
  const { hasPermission } = useAuthStore()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [showCategories, setShowCategories] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null)
  const [categoryName, setCategoryName] = useState('')
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [importRows, setImportRows] = useState<Record<string, string>[]>([])
  const [excludedImportRows, setExcludedImportRows] = useState(0)
  const [importFileName, setImportFileName] = useState('')
  const [duplicateMode, setDuplicateMode] = useState<'skip' | 'update'>('skip')
  const [importDefaultCategory, setImportDefaultCategory] = useState('Perfumes')
  const [replaceCategory, setReplaceCategory] = useState(false)
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)
  const [formError, setFormError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const { data: productPage, isLoading, error } = useQuery<PaginatedResponse<Product>>({
    queryKey: ['products', search, categoryFilter, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (categoryFilter) params.set('category', categoryFilter)
      params.set('page', String(page))
      params.set('page_size', String(pageSize))
      return (await axios.get(`/api/products?${params.toString()}`)).data
    }
  })
  const products = productPage?.data || []

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['product-categories'],
    queryFn: async () => (await axios.get('/api/products/categories')).data
  })

  const { register, handleSubmit, reset, formState: { errors } } = useForm<ProductFormData>({
    defaultValues: { is_dropship: false }
  })

  const saveProduct = useMutation({
    mutationFn: async (data: ProductFormData) => {
      const payload = { ...data, category_id: data.category_id || null }
      return editingProduct
        ? (await axios.put(`/api/products/${editingProduct.id}`, payload)).data
        : (await axios.post('/api/products', payload)).data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['product-categories'] })
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
      setShowForm(false)
      setEditingProduct(null)
      setFormError('')
      reset()
    },
    onError: (mutationError: any) => setFormError(mutationError.response?.data?.error?.message || 'Failed to save product')
  })

  const deleteProduct = useMutation({
    mutationFn: async (id: string) => axios.delete(`/api/products/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['product-categories'] })
    }
  })

  const saveCategory = useMutation({
    mutationFn: async () => editingCategory
      ? axios.put(`/api/products/categories/${editingCategory.id}`, { name: categoryName })
      : axios.post('/api/products/categories', { name: categoryName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product-categories'] })
      setCategoryName('')
      setEditingCategory(null)
    }
  })

  const deleteCategory = useMutation({
    mutationFn: async (id: string) => axios.delete(`/api/products/categories/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['product-categories'] })
  })

  const importProducts = useMutation({
    mutationFn: async () => (await axios.post('/api/products/import', {
      rows: importRows,
      duplicate_mode: duplicateMode,
      default_category: importDefaultCategory,
      replace_category: replaceCategory
    })).data as ImportSummary,
    onSuccess: summary => {
      setImportSummary(summary)
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['product-categories'] })
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
    }
  })

  const openNewProduct = () => {
    setEditingProduct(null)
    setFormError('')
    reset({ name: '', sku: '', barcode: '', category_id: '', cost_price: undefined, selling_price: undefined, reorder_level: undefined, is_dropship: false })
    setShowForm(true)
  }

  const editProduct = (product: Product) => {
    setEditingProduct(product)
    setFormError('')
    reset({
      name: product.name, sku: product.sku || '', barcode: product.barcode || '',
      category_id: product.category_id || '', cost_price: Number(product.cost_price),
      selling_price: Number(product.selling_price), reorder_level: product.reorder_level,
      is_dropship: product.is_dropship
    })
    setShowForm(true)
  }

  const loadCsv = async (file?: File) => {
    if (!file) return
    setImportSummary(null)
    setImportFileName(file.name)
    const parsed = parseCsv(await file.text())
    if (parsed.length < 2) {
      setImportRows([])
      setExcludedImportRows(0)
      return
    }
    const headers = parsed[0].map(normalizeHeader)
    const columnFor = (field: string) => headers.findIndex(header => headerAliases[field].includes(header))
    const mappedRows = parsed.slice(1).map(cells => Object.fromEntries(
      Object.keys(headerAliases).map(field => [field, cells[columnFor(field)] || ''])
    ))
    const inStockColumn = columnFor('in_stock')
    const includedRows = inStockColumn >= 0
      ? mappedRows.filter(row => row.in_stock === '1')
      : mappedRows
    setExcludedImportRows(mappedRows.length - includedRows.length)
    setImportRows(includedRows)
  }

  const downloadTemplate = () => {
    const content = 'name,sku,barcode,category,cost_price,selling_price,reorder_level,is_dropship,stock_quantity\nExample Watch,WATCH-001,,Watches,1200,2000,2,false,5\nExample Perfume,PERF-001,,Perfumes,1500,2500,0,true,0'
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'dlight-product-import-template.csv'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  if (error) return <div className="flex h-64 items-center justify-center text-muted-foreground">Failed to load products</div>

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-bold">Products</h1><p className="text-muted-foreground">Organize and maintain the product catalogue</p></div>
        <div className="flex flex-wrap gap-2">
          {hasPermission('products.create') && <button onClick={() => setShowCategories(true)} className="inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 hover:bg-muted"><FolderPlus className="h-4 w-4" />Categories</button>}
          {hasPermission('products.create') && <button onClick={() => { setShowImport(true); setImportSummary(null) }} className="inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 hover:bg-muted"><FileUp className="h-4 w-4" />Import</button>}
          {hasPermission('products.create') && <button onClick={openNewProduct} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-primary-foreground hover:bg-primary/90"><Plus className="h-4 w-4" />Add Product</button>}
        </div>
      </div>

      {showForm && (
        <div className="mobile-sheet fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="product-form-title">
        <section className="mobile-sheet-panel max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-background shadow-xl">
          <div className="sticky top-0 z-10 mb-1 flex items-center justify-between border-b bg-background px-5 py-4"><div><h2 id="product-form-title" className="font-semibold">{editingProduct ? 'Edit Product' : 'Add Product'}</h2><p className="text-sm text-muted-foreground">{editingProduct ? 'Update product information and pricing' : 'Create a new catalogue item'}</p></div><button type="button" onClick={() => { setShowForm(false); setEditingProduct(null) }} className="rounded-md p-2 text-muted-foreground hover:bg-muted" title="Close"><X className="h-5 w-5" /></button></div>
          <form onSubmit={handleSubmit(data => saveProduct.mutate(data))} className="grid gap-4 p-5 md:grid-cols-2">
            {formError && <div className="md:col-span-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{formError}</div>}
            <label className="text-sm font-medium">Name *<input {...register('name', { required: 'Name is required' })} className={`${inputClass} mt-1`} placeholder="Product name" />{errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}</label>
            <label className="text-sm font-medium">SKU<input {...register('sku')} className={`${inputClass} mt-1`} placeholder="Leave blank to generate automatically" /></label>
            <label className="text-sm font-medium">Barcode<input {...register('barcode')} className={`${inputClass} mt-1`} placeholder="Optional barcode" /></label>
            <label className="text-sm font-medium">Category<select {...register('category_id')} className={`${inputClass} mt-1`}><option value="">Uncategorized</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label className="text-sm font-medium">Cost Price<input type="number" min="0" step="0.01" {...register('cost_price', { valueAsNumber: true })} className={`${inputClass} mt-1`} placeholder="Supplier or purchase cost" /></label>
            <label className="text-sm font-medium">Selling Price *<input type="number" min="0" step="0.01" {...register('selling_price', { required: 'Selling price is required', valueAsNumber: true })} className={`${inputClass} mt-1`} placeholder="Customer price" />{errors.selling_price && <span className="text-xs text-destructive">{errors.selling_price.message}</span>}</label>
            <label className="text-sm font-medium">Reorder Level<input type="number" min="0" {...register('reorder_level', { valueAsNumber: true })} className={`${inputClass} mt-1`} placeholder="Low-stock warning quantity" /></label>
            <label className="flex items-start gap-3 pt-6"><input type="checkbox" {...register('is_dropship')} className="mt-1 h-4 w-4" /><span><span className="block text-sm font-medium">Prefer Supplier Fulfillment</span><span className="block text-xs text-muted-foreground">Sets the default only. Each order may still use shop stock or a supplier.</span></span></label>
            <div className="sticky bottom-0 -mx-5 -mb-5 mt-2 flex flex-col-reverse gap-2 border-t bg-background p-4 sm:flex-row sm:justify-end md:col-span-2"><button type="button" onClick={() => { setShowForm(false); setEditingProduct(null) }} className="rounded-lg border px-4 py-2">Cancel</button><button type="submit" disabled={saveProduct.isPending} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{saveProduct.isPending ? 'Saving...' : editingProduct ? 'Update Product' : 'Create Product'}</button></div>
          </form>
        </section>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative max-w-md flex-1"><Package className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} className={`${inputClass} pl-10`} placeholder="Search name, SKU, or barcode" /></div>
        <select value={categoryFilter} onChange={event => { setCategoryFilter(event.target.value); setPage(1) }} className="rounded-lg border px-3 py-2 sm:w-56"><option value="">All categories</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name} ({category.product_count})</option>)}</select>
      </div>

      {isLoading ? <div className="h-64 animate-pulse rounded bg-muted" /> : products.length === 0 ? <div className="py-16 text-center text-muted-foreground">No products match this search</div> : (
        <>
        <div className="hidden overflow-x-auto rounded-lg border md:block">
          <table className="w-full"><thead className="bg-muted"><tr><th className="px-4 py-3 text-left">Product</th><th className="px-4 py-3 text-left">SKU</th><th className="px-4 py-3 text-left">Category</th><th className="px-4 py-3 text-left">Preferred Source</th><th className="px-4 py-3 text-left">Available</th><th className="px-4 py-3 text-left">Price</th><th className="px-4 py-3 text-right">Actions</th></tr></thead>
            <tbody>{products.map(product => <tr key={product.id} className="border-t hover:bg-muted/50">
              <td className="px-4 py-3 font-medium">{product.name}</td><td className="px-4 py-3 text-muted-foreground">{product.sku || '-'}</td><td className="px-4 py-3">{product.category_name || 'Uncategorized'}</td>
              <td className="px-4 py-3"><span className={`rounded px-2 py-1 text-xs font-medium ${product.is_dropship ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'}`}>{product.is_dropship ? 'Supplier first' : 'Stock first'}</span></td>
              <td className="px-4 py-3">{Number(product.available_stock || 0).toLocaleString()}</td>
              <td className="px-4 py-3 font-medium">{formatMoney(product.selling_price)}</td>
              <td className="px-4 py-3"><div className="flex justify-end gap-1"><button onClick={() => setViewingProduct(product)} className="rounded p-2 text-muted-foreground hover:bg-muted" title="View"><Eye className="h-4 w-4" /></button>{hasPermission('products.edit') && <button onClick={() => editProduct(product)} className="rounded p-2 text-muted-foreground hover:bg-muted" title="Edit"><Edit className="h-4 w-4" /></button>}{hasPermission('products.delete') && <button onClick={() => deleteProduct.mutate(product.id)} className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-destructive" title="Delete"><Trash2 className="h-4 w-4" /></button>}</div></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="space-y-3 md:hidden">
          {products.map(product => (
            <article key={product.id} className="rounded-lg border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <button type="button" onClick={() => setViewingProduct(product)} className="min-h-0 flex-1 text-left">
                  <h3 className="line-clamp-2 text-sm font-semibold leading-5">{product.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{product.sku || 'No SKU'} | {product.category_name || 'Uncategorized'}</p>
                </button>
                <span className={`shrink-0 rounded px-2 py-1 text-[11px] font-medium ${product.is_dropship ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'}`}>{product.is_dropship ? 'Supplier first' : 'Stock first'}</span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 border-y py-3 text-sm">
                <div><span className="block text-xs text-muted-foreground">Selling price</span><strong>{formatMoney(product.selling_price)}</strong></div>
                <div><span className="block text-xs text-muted-foreground">Available</span><strong>{Number(product.available_stock || 0).toLocaleString()}</strong></div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button type="button" onClick={() => setViewingProduct(product)} className="inline-flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs font-medium"><Eye className="h-4 w-4" />View</button>
                {hasPermission('products.edit') && <button type="button" onClick={() => editProduct(product)} className="inline-flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs font-medium"><Edit className="h-4 w-4" />Edit</button>}
                {hasPermission('products.delete') && <button type="button" onClick={() => deleteProduct.mutate(product.id)} className="inline-flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs font-medium text-destructive"><Trash2 className="h-4 w-4" />Delete</button>}
              </div>
            </article>
          ))}
        </div>
        {productPage && <Pagination meta={productPage.pagination} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} />}
        </>
      )}

      {showCategories && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"><div className="w-full max-w-lg rounded-lg bg-background shadow-xl"><div className="flex items-center justify-between border-b p-4"><div><h2 className="font-semibold">Product Categories</h2><p className="text-sm text-muted-foreground">Create and maintain catalogue groups</p></div><button onClick={() => setShowCategories(false)} title="Close"><X className="h-4 w-4" /></button></div>
        <div className="p-4"><div className="flex gap-2"><input value={categoryName} onChange={event => setCategoryName(event.target.value)} className={inputClass} placeholder="Category name" /><button disabled={!categoryName.trim() || saveCategory.isPending} onClick={() => saveCategory.mutate()} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{editingCategory ? 'Rename' : 'Add'}</button></div>
          {editingCategory && <button onClick={() => { setEditingCategory(null); setCategoryName('') }} className="mt-2 text-sm text-muted-foreground">Cancel rename</button>}
          <div className="mt-4 divide-y rounded-lg border">{categories.map(category => <div key={category.id} className="flex items-center justify-between p-3"><div><div className="font-medium">{category.name}</div><div className="text-xs text-muted-foreground">{category.product_count} products</div></div><div className="flex gap-1"><button onClick={() => { setEditingCategory(category); setCategoryName(category.name) }} className="rounded p-2 text-muted-foreground hover:bg-muted" title="Rename"><Edit className="h-4 w-4" /></button><button disabled={category.product_count > 0} onClick={() => deleteCategory.mutate(category.id)} className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-30" title={category.product_count > 0 ? 'Category contains products' : 'Delete'}><Trash2 className="h-4 w-4" /></button></div></div>)}</div>
        </div></div></div>}

      {showImport && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"><div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background shadow-xl"><div className="flex items-center justify-between border-b p-4"><div><h2 className="font-semibold">Import Products</h2><p className="text-sm text-muted-foreground">Upload a CSV exported from your website</p></div><button onClick={() => setShowImport(false)} title="Close"><X className="h-4 w-4" /></button></div>
        <div className="space-y-5 p-5"><div className="flex flex-wrap gap-2"><label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground"><FileUp className="h-4 w-4" />Choose CSV<input type="file" accept=".csv,text/csv" className="hidden" onChange={event => loadCsv(event.target.files?.[0])} /></label><button onClick={downloadTemplate} className="inline-flex items-center gap-2 rounded-lg border px-4 py-2"><Download className="h-4 w-4" />Download template</button></div>
          {importFileName && <div className="rounded-lg border p-3 text-sm"><strong>{importFileName}</strong><span className="ml-2 text-muted-foreground">{importRows.length} product rows ready to import{excludedImportRows > 0 ? `; ${excludedImportRows} out-of-stock rows excluded` : ''}</span></div>}
          <label className="block text-sm font-medium">Category for rows without a category<input value={importDefaultCategory} onChange={event => setImportDefaultCategory(event.target.value)} className={`${inputClass} mt-1`} placeholder="Example: Perfumes" /></label>
          <label className="block text-sm font-medium">When an SKU or product name already exists<select value={duplicateMode} onChange={event => setDuplicateMode(event.target.value as 'skip' | 'update')} className={`${inputClass} mt-1`}><option value="skip">Skip existing product</option><option value="update">Update existing product</option></select></label>
          <label className="flex items-start gap-3 rounded-lg border p-3"><input type="checkbox" checked={replaceCategory} onChange={event => setReplaceCategory(event.target.checked)} className="mt-1 h-4 w-4" /><span><span className="block text-sm font-medium">Archive products missing from this import</span><span className="block text-xs text-muted-foreground">Use for a complete website catalogue sync. Products omitted or marked out of stock will no longer appear in this category.</span></span></label>
          <div className="text-sm text-muted-foreground">Website headers such as Cost price, Sale price, and In stock? are accepted. When In stock? is present, only rows with value 1 are imported. Missing SKUs are generated automatically.</div>
          {importRows.length > 0 && <div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm"><thead className="bg-muted"><tr><th className="p-2 text-left">Name</th><th className="p-2 text-left">SKU</th><th className="p-2 text-left">Category</th><th className="p-2 text-left">Price</th></tr></thead><tbody>{importRows.slice(0, 5).map((row, index) => <tr key={index} className="border-t"><td className="p-2">{row.name || '-'}</td><td className="p-2">{row.sku || '-'}</td><td className="p-2">{row.category || '-'}</td><td className="p-2">{row.selling_price || '-'}</td></tr>)}</tbody></table></div>}
          {importSummary && <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 text-sm"><strong>Import complete.</strong> Created {importSummary.created}, updated {importSummary.updated}, skipped {importSummary.skipped}, archived {importSummary.archived}.{importSummary.errors.length > 0 && <div className="mt-2 text-destructive">{importSummary.errors.length} rows had errors. First: row {importSummary.errors[0].row}, {importSummary.errors[0].message}</div>}</div>}
          {importProducts.isError && <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{(importProducts.error as any)?.response?.data?.error?.message || 'Import failed'}</div>}
          <div className="flex justify-end gap-2"><button onClick={() => setShowImport(false)} className="rounded-lg border px-4 py-2">Close</button><button disabled={importRows.length === 0 || importProducts.isPending} onClick={() => importProducts.mutate()} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{importProducts.isPending ? 'Importing...' : `Import ${importRows.length} Products`}</button></div>
        </div></div></div>}

      {viewingProduct && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"><div className="w-full max-w-lg rounded-lg bg-background shadow-xl"><div className="flex items-center justify-between border-b p-4"><div><h2 className="font-semibold">{viewingProduct.name}</h2><p className="text-sm text-muted-foreground">Product details</p></div><button onClick={() => setViewingProduct(null)} title="Close"><X className="h-4 w-4" /></button></div><div className="grid gap-4 p-5 text-sm sm:grid-cols-2"><div><span className="text-muted-foreground">SKU</span><div>{viewingProduct.sku || '-'}</div></div><div><span className="text-muted-foreground">Barcode</span><div>{viewingProduct.barcode || '-'}</div></div><div><span className="text-muted-foreground">Category</span><div>{viewingProduct.category_name || 'Uncategorized'}</div></div><div><span className="text-muted-foreground">Preferred source</span><div>{viewingProduct.is_dropship ? 'Supplier first' : 'Shop stock first'}</div></div><div><span className="text-muted-foreground">Available stock</span><div>{Number(viewingProduct.available_stock || 0).toLocaleString()}</div></div><div><span className="text-muted-foreground">Cost</span><div>{formatMoney(viewingProduct.cost_price)}</div></div><div><span className="text-muted-foreground">Selling price</span><div className="font-semibold">{formatMoney(viewingProduct.selling_price)}</div></div></div></div></div>}
    </div>
  )
}
