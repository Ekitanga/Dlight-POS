import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { AlertTriangle, Archive, Building2, Check, CreditCard, Database, Download, Laptop, Loader2, Moon, Palette, Plus, Receipt, RefreshCcw, Save, ShieldAlert, SlidersHorizontal, Sun, Trash2, Upload, X } from 'lucide-react'
import { applyAppearance, AppearanceMode } from '../../lib/appearance'

interface SettingsData {
  company_name: string
  logo_url?: string
  company_phone?: string
  company_email?: string
  company_address?: string
  website?: string
  kra_pin?: string
  currency: string
  tax_rate: number
  mpesa_paybill?: string
  mpesa_account_number?: string
  mpesa_till?: string
  bank_details?: string
  order_prefix?: string
  receipt_header?: string
  receipt_footer?: string
  receipt_paper_width?: string
  receipt_show_customer_address?: boolean
  receipt_show_payment_details?: boolean
  receipt_show_delivery_details?: boolean
  appearance_mode: AppearanceMode
  brand_preset: string
  primary_color: string
  accent_color: string
  sidebar_style: 'dark' | 'light'
  interface_density: 'comfortable' | 'compact'
  expense_categories: string[]
}

interface CleanupPreview {
  mode: 'transactions' | 'full'
  confirmation_phrase: string
  counts: Record<string, number>
  total_records: number
  preserves: string[]
}

interface BackupFile {
  file_name: string
  size_bytes: number
  created_at: string
  modified_at: string
}

const inputClass = 'w-full rounded-md border px-3 py-2.5 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none'

const brandPresets = [
  { id: 'dlight', name: 'Dlight Gold', primary: '#B08D57', accent: '#D4AF67' },
  { id: 'classic', name: 'Classic Blue', primary: '#356FD4', accent: '#5B8DEF' },
  { id: 'emerald', name: 'Emerald', primary: '#16866B', accent: '#35A989' }
]

const defaultExpenseCategories = ['Rent', 'Salaries', 'Electricity', 'Internet', 'Packaging', 'Fuel', 'Miscellaneous']

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function Settings() {
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [backupMessage, setBackupMessage] = useState('')
  const [backupError, setBackupError] = useState('')
  const [downloadingBackup, setDownloadingBackup] = useState('')
  const [cleanupMode, setCleanupMode] = useState<'transactions' | 'full'>('transactions')
  const [cleanupConfirmation, setCleanupConfirmation] = useState('')
  const [cleanupMessage, setCleanupMessage] = useState('')
  const [newExpenseCategory, setNewExpenseCategory] = useState('')
  const { register, handleSubmit, formState: { errors }, reset, watch, setValue } = useForm<SettingsData>()
  const queryClient = useQueryClient()
  const logoUrl = watch('logo_url')
  const appearanceMode = watch('appearance_mode')
  const primaryColor = watch('primary_color')
  const accentColor = watch('accent_color')
  const sidebarStyle = watch('sidebar_style')
  const interfaceDensity = watch('interface_density')
  const expenseCategories = watch('expense_categories') || []

  const { data: settings, isLoading } = useQuery<SettingsData>({
    queryKey: ['settings'],
    queryFn: async () => (await axios.get('/api/settings')).data
  })

  const { data: cleanupPreview, isLoading: cleanupPreviewLoading, refetch: refetchCleanupPreview } = useQuery<CleanupPreview>({
    queryKey: ['cleanup-preview', cleanupMode],
    queryFn: async () => (await axios.get(`/api/settings/cleanup/preview?mode=${cleanupMode}`)).data
  })

  const { data: backups = [], isLoading: backupsLoading } = useQuery<BackupFile[]>({
    queryKey: ['settings-backups'],
    queryFn: async () => (await axios.get('/api/settings/backups')).data
  })

  useEffect(() => {
    if (settings) reset({
      ...settings,
      expense_categories: settings.expense_categories?.length ? settings.expense_categories : defaultExpenseCategories
    })
  }, [settings, reset])

  useEffect(() => {
    if (!primaryColor || !accentColor) return
    applyAppearance({
      appearance_mode: appearanceMode,
      primary_color: primaryColor,
      accent_color: accentColor,
      sidebar_style: sidebarStyle,
      interface_density: interfaceDensity
    })
  }, [appearanceMode, primaryColor, accentColor, sidebarStyle, interfaceDensity])

  const updateSettings = useMutation({
    mutationFn: async (data: SettingsData) => (await axios.put('/api/settings', {
      ...data,
      expense_categories: data.expense_categories?.length ? data.expense_categories : defaultExpenseCategories
    })).data,
    onSuccess: data => {
      reset(data)
      setErrorMessage('')
      setMessage('Settings saved successfully')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      queryClient.invalidateQueries({ queryKey: ['receipts'] })
      queryClient.invalidateQueries({ queryKey: ['branding'] })
    },
    onError: (error: any) => {
      setMessage('')
      setErrorMessage(error.response?.data?.error?.message || 'Failed to save settings')
    }
  })

  const runCleanup = useMutation({
    mutationFn: async () => (await axios.post('/api/settings/cleanup/run', {
      mode: cleanupMode,
      confirmation: cleanupConfirmation
    })).data,
    onSuccess: data => {
      setCleanupConfirmation('')
      setCleanupMessage(`Cleanup completed. ${Number(data.total_records_deleted || 0).toLocaleString()} records were cleared.`)
      setErrorMessage('')
      queryClient.invalidateQueries()
      refetchCleanupPreview()
    },
    onError: (error: any) => {
      setCleanupMessage('')
      setErrorMessage(error.response?.data?.error?.message || 'Cleanup failed')
    }
  })

  const createBackup = useMutation({
    mutationFn: async () => (await axios.post('/api/settings/backups')).data,
    onSuccess: (data: BackupFile) => {
      setBackupError('')
      setBackupMessage(`Backup created: ${data.file_name}`)
      queryClient.invalidateQueries({ queryKey: ['settings-backups'] })
    },
    onError: (error: any) => {
      setBackupMessage('')
      setBackupError(error.response?.data?.error?.message || 'Backup failed')
    }
  })

  const downloadBackup = async (fileName: string) => {
    try {
      setDownloadingBackup(fileName)
      setBackupError('')
      const response = await axios.get(`/api/settings/backups/${encodeURIComponent(fileName)}`, { responseType: 'blob' })
      const url = window.URL.createObjectURL(new Blob([response.data]))
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch (error: any) {
      setBackupError(error.response?.data?.error?.message || 'Backup download failed')
    } finally {
      setDownloadingBackup('')
    }
  }

  const uploadLogo = (file?: File) => {
    if (!file) return
    setErrorMessage('')
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Select a PNG, JPG, or WebP image')
      return
    }
    if (file.size > 1024 * 1024) {
      setErrorMessage('Logo must be smaller than 1 MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setValue('logo_url', String(reader.result), { shouldDirty: true })
    reader.readAsDataURL(file)
  }

  const addExpenseCategory = () => {
    const category = newExpenseCategory.trim().replace(/\s+/g, ' ')
    if (!category) return
    const exists = expenseCategories.some(item => item.toLowerCase() === category.toLowerCase())
    if (exists) {
      setNewExpenseCategory('')
      return
    }
    setValue('expense_categories', [...expenseCategories, category], { shouldDirty: true })
    setNewExpenseCategory('')
  }

  const removeExpenseCategory = (category: string) => {
    if (expenseCategories.length <= 1) {
      setErrorMessage('Keep at least one expense category')
      return
    }
    setValue('expense_categories', expenseCategories.filter(item => item !== category), { shouldDirty: true })
  }

  if (isLoading) {
    return <div className="space-y-4"><div className="h-8 w-48 animate-pulse rounded bg-muted" /><div className="h-96 animate-pulse rounded bg-muted" /></div>
  }

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage business identity, payments, sales defaults, and receipts</p>
      </div>

      <form onSubmit={handleSubmit(data => updateSettings.mutate(data))} className="w-full max-w-6xl space-y-8">
        {(message || errorMessage) && (
          <div className={`rounded-lg border p-3 text-sm ${errorMessage ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'}`}>
            {errorMessage || message}
          </div>
        )}

        <section className="min-w-0 space-y-5 border-b pb-8">
          <div className="flex items-center gap-2"><Building2 className="h-5 w-5 text-primary" /><h2 className="font-semibold">Business Identity</h2></div>
          <div className="grid gap-5 md:grid-cols-[180px_1fr]">
            <div>
              <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-muted">
                {logoUrl ? <img src={logoUrl} alt="Business logo" className="h-full w-full object-contain p-3" /> : <Building2 className="h-12 w-12 text-muted-foreground" />}
              </div>
              <div className="mt-2 flex gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted">
                  <Upload className="h-4 w-4" /> Upload
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => uploadLogo(event.target.files?.[0])} />
                </label>
                {logoUrl && <button type="button" onClick={() => setValue('logo_url', '')} className="rounded-lg border p-2 text-muted-foreground hover:text-destructive" title="Remove logo"><X className="h-4 w-4" /></button>}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">PNG, JPG, or WebP. Maximum 1 MB.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="sm:col-span-2 text-sm font-medium">Business Name *
                <input {...register('company_name', { required: 'Business name is required' })} className={`${inputClass} mt-1.5`} placeholder="Dlight Giftshop" />
                {errors.company_name && <span className="text-xs text-destructive">{errors.company_name.message}</span>}
              </label>
              <label className="text-sm font-medium">Phone<input {...register('company_phone')} className={`${inputClass} mt-1.5`} placeholder="07XX XXX XXX" /></label>
              <label className="text-sm font-medium">Email<input type="email" {...register('company_email')} className={`${inputClass} mt-1.5`} placeholder="sales@example.com" /></label>
              <label className="sm:col-span-2 text-sm font-medium">Address<textarea {...register('company_address')} className={`${inputClass} mt-1.5`} rows={2} placeholder="Shop location or postal address" /></label>
              <label className="text-sm font-medium">Website<input {...register('website')} className={`${inputClass} mt-1.5`} placeholder="www.example.com" /></label>
              <label className="text-sm font-medium">KRA PIN<input {...register('kra_pin')} className={`${inputClass} mt-1.5`} placeholder="Business tax PIN" /></label>
            </div>
          </div>
        </section>

        <section className="min-w-0 space-y-5 border-b pb-8">
          <div className="flex items-center gap-2"><Palette className="h-5 w-5 text-primary" /><div><h2 className="font-semibold">Appearance</h2><p className="text-sm text-muted-foreground">Set the business-wide look used on every device</p></div></div>

          <div>
            <p className="mb-2 text-sm font-medium">Brand Palette</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {brandPresets.map(preset => {
                const selected = primaryColor?.toUpperCase() === preset.primary.toUpperCase() && accentColor?.toUpperCase() === preset.accent.toUpperCase()
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setValue('brand_preset', preset.id, { shouldDirty: true })
                      setValue('primary_color', preset.primary, { shouldDirty: true })
                      setValue('accent_color', preset.accent, { shouldDirty: true })
                    }}
                    className={`flex items-center gap-3 rounded-md border p-3 text-left transition-colors ${selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted'}`}
                  >
                    <span className="flex -space-x-1"><span className="h-8 w-8 rounded-full border-2 border-background" style={{ backgroundColor: preset.primary }} /><span className="h-8 w-8 rounded-full border-2 border-background" style={{ backgroundColor: preset.accent }} /></span>
                    <span className="flex-1 text-sm font-medium">{preset.name}</span>
                    {selected && <Check className="h-4 w-4 text-primary" />}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <label className="text-sm font-medium">Primary Color
              <span className="mt-1.5 flex items-center gap-2 rounded-md border p-2">
                <input type="color" {...register('primary_color')} className="h-8 w-10 cursor-pointer border-0 bg-transparent p-0" />
                <input {...register('primary_color', { pattern: /^#[0-9a-fA-F]{6}$/ })} className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none" />
              </span>
            </label>
            <label className="text-sm font-medium">Accent Color
              <span className="mt-1.5 flex items-center gap-2 rounded-md border p-2">
                <input type="color" {...register('accent_color')} className="h-8 w-10 cursor-pointer border-0 bg-transparent p-0" />
                <input {...register('accent_color', { pattern: /^#[0-9a-fA-F]{6}$/ })} className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none" />
              </span>
            </label>
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Display Mode</legend>
              <div className="grid grid-cols-3 rounded-md border p-1">
                {[
                  { value: 'light', label: 'Light', icon: Sun },
                  { value: 'dark', label: 'Dark', icon: Moon },
                  { value: 'system', label: 'System', icon: Laptop }
                ].map(option => {
                  const Icon = option.icon
                  return <label key={option.value} className={`flex cursor-pointer flex-col items-center gap-1 rounded px-2 py-2 text-xs ${appearanceMode === option.value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><input type="radio" value={option.value} {...register('appearance_mode')} className="sr-only" /><Icon className="h-4 w-4" />{option.label}</label>
                })}
              </div>
            </fieldset>
            <label className="text-sm font-medium">Sidebar
              <select {...register('sidebar_style')} className={`${inputClass} mt-1.5`}><option value="dark">Dark premium</option><option value="light">Match workspace</option></select>
            </label>
            <label className="text-sm font-medium">Interface Density
              <select {...register('interface_density')} className={`${inputClass} mt-1.5`}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select>
            </label>
          </div>

          <div className="overflow-hidden rounded-md border bg-card">
            <div className="flex items-center gap-3 border-b bg-primary px-4 py-3 text-primary-foreground"><span className="h-7 w-7 rounded bg-black/20" /><span className="text-sm font-semibold">Live appearance preview</span></div>
            <div className="grid gap-3 p-4 sm:grid-cols-[160px_1fr]"><div className="rounded bg-sidebar-preview p-3 text-sm"><div className="rounded bg-primary px-3 py-2 text-primary-foreground">Active section</div><div className="mt-2 px-3 py-2 text-muted-foreground">Other section</div></div><div className="rounded border p-4"><p className="text-xs uppercase text-muted-foreground">Business snapshot</p><p className="mt-1 text-xl font-semibold">KES 24,500</p><button type="button" className="mt-4 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">Primary action</button></div></div>
          </div>
        </section>

        <section className="min-w-0 space-y-5 border-b pb-8">
          <div className="flex items-center gap-2"><CreditCard className="h-5 w-5 text-primary" /><h2 className="font-semibold">Payment Details</h2></div>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm font-medium">M-PESA Paybill<input {...register('mpesa_paybill')} className={`${inputClass} mt-1.5`} placeholder="Paybill number" /></label>
            <label className="text-sm font-medium">Paybill Account Number<input {...register('mpesa_account_number')} className={`${inputClass} mt-1.5`} placeholder="Account number customers enter" /></label>
            <label className="text-sm font-medium">M-PESA Till<input {...register('mpesa_till')} className={`${inputClass} mt-1.5`} placeholder="Till number" /></label>
            <label className="sm:col-span-3 text-sm font-medium">Bank Details<textarea {...register('bank_details')} className={`${inputClass} mt-1.5`} rows={2} placeholder="Bank, account name, and account number" /></label>
          </div>
        </section>

        <section className="min-w-0 space-y-5 border-b pb-8">
          <div className="flex items-center gap-2"><SlidersHorizontal className="h-5 w-5 text-primary" /><h2 className="font-semibold">Sales Defaults</h2></div>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm font-medium">Currency<input {...register('currency', { required: true })} className={`${inputClass} mt-1.5`} placeholder="KES" /></label>
            <label className="text-sm font-medium">Tax Rate (%)<input type="number" min="0" step="0.01" {...register('tax_rate', { valueAsNumber: true })} className={`${inputClass} mt-1.5`} placeholder="Tax percentage" /></label>
            <label className="text-sm font-medium">Order Prefix<input {...register('order_prefix')} className={`${inputClass} mt-1.5 uppercase`} maxLength={20} placeholder="ORD" /></label>
          </div>
        </section>

        <section className="min-w-0 space-y-5 border-b pb-8">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" />
            <div>
              <h2 className="font-semibold">Expense Categories</h2>
              <p className="text-sm text-muted-foreground">Control the categories used when recording rent, ads, salaries, utilities, and other costs.</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <input
              value={newExpenseCategory}
              onChange={event => setNewExpenseCategory(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addExpenseCategory()
                }
              }}
              className={inputClass}
              placeholder="Example: Meta Ads, Rent, Airtime, Salaries"
            />
            <button
              type="button"
              onClick={addExpenseCategory}
              disabled={!newExpenseCategory.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Add Category
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {expenseCategories.map(category => (
              <span key={category} className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm">
                {category}
                <button
                  type="button"
                  onClick={() => removeExpenseCategory(category)}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title={`Remove ${category}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        </section>

        <section className="min-w-0 space-y-5">
          <div className="flex items-center gap-2"><Receipt className="h-5 w-5 text-primary" /><h2 className="font-semibold">Receipt Layout</h2></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium">Receipt Heading<input {...register('receipt_header')} className={`${inputClass} mt-1.5`} placeholder="Sales Receipt" /></label>
            <label className="text-sm font-medium">Paper Width
              <select {...register('receipt_paper_width')} className={`${inputClass} mt-1.5`}><option value="58mm">58 mm</option><option value="80mm">80 mm</option></select>
            </label>
            <label className="sm:col-span-2 text-sm font-medium">Footer Message<textarea {...register('receipt_footer')} className={`${inputClass} mt-1.5`} rows={2} placeholder="Thank you for shopping with us." /></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" {...register('receipt_show_customer_address')} className="h-4 w-4" /> Customer address</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" {...register('receipt_show_payment_details')} className="h-4 w-4" /> Payment details</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" {...register('receipt_show_delivery_details')} className="h-4 w-4" /> Delivery details</label>
          </div>
        </section>

        <section className="min-w-0 space-y-5 border-t pt-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="rounded-lg bg-primary/10 p-2 text-primary"><Archive className="h-5 w-5" /></span>
              <div>
                <h2 className="font-semibold">Database Backups</h2>
                <p className="text-sm text-muted-foreground">Create a verified PostgreSQL backup and download recent backup files.</p>
              </div>
            </div>
            <button
              type="button"
              disabled={createBackup.isPending}
              onClick={() => createBackup.mutate()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createBackup.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
              Create Backup
            </button>
          </div>

          {(backupMessage || backupError) && (
            <div className={`rounded-lg border p-3 text-sm ${backupError ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'}`}>
              {backupError || backupMessage}
            </div>
          )}

          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h3 className="font-semibold">Recent Backups</h3>
                <p className="text-xs text-muted-foreground">Stored in the server backup folder.</p>
              </div>
              <button type="button" onClick={() => queryClient.invalidateQueries({ queryKey: ['settings-backups'] })} className="rounded-lg border p-2 text-muted-foreground hover:text-foreground" title="Refresh backups">
                <RefreshCcw className="h-4 w-4" />
              </button>
            </div>
            {backupsLoading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading backups...</div>
            ) : backups.length ? (
              <div className="divide-y">
                {backups.slice(0, 8).map(backup => (
                  <div key={backup.file_name} className="grid min-w-0 gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">{backup.file_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(backup.modified_at).toLocaleString()} • {formatBytes(backup.size_bytes)}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">Verified dump</span>
                    <button
                      type="button"
                      onClick={() => downloadBackup(backup.file_name)}
                      disabled={downloadingBackup === backup.file_name}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                    >
                      {downloadingBackup === backup.file_name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      Download
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-sm text-muted-foreground">No backups have been created from this screen yet.</div>
            )}
          </div>
        </section>

        <section className="min-w-0 space-y-5 border-t pt-8">
          <div className="flex items-start gap-3">
            <span className="rounded-lg bg-destructive/10 p-2 text-destructive"><ShieldAlert className="h-5 w-5" /></span>
            <div>
              <h2 className="font-semibold">Admin Data Cleanup</h2>
              <p className="text-sm text-muted-foreground">Prepare the system for go-live by clearing test activity. This is admin-only and audited.</p>
            </div>
          </div>

          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
            <div className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Create a database backup before running cleanup. This action cannot be undone from the frontend.</p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <label className={`cursor-pointer rounded-lg border p-4 ${cleanupMode === 'transactions' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted'}`}>
              <input type="radio" value="transactions" checked={cleanupMode === 'transactions'} onChange={() => { setCleanupMode('transactions'); setCleanupConfirmation(''); setCleanupMessage('') }} className="sr-only" />
              <span className="flex items-center gap-2 font-semibold"><Database className="h-4 w-4 text-primary" /> Clean Test Transactions</span>
              <span className="mt-2 block text-sm text-muted-foreground">Clears orders, payments, deliveries, COD, supplier/rider ledgers, expenses, reconciliations, refunds, and audit logs. Keeps products, suppliers, riders, couriers, inventory records, users, permissions, and settings.</span>
            </label>
            <label className={`cursor-pointer rounded-lg border p-4 ${cleanupMode === 'full' ? 'border-destructive bg-destructive/5 ring-1 ring-destructive' : 'hover:bg-muted'}`}>
              <input type="radio" value="full" checked={cleanupMode === 'full'} onChange={() => { setCleanupMode('full'); setCleanupConfirmation(''); setCleanupMessage('') }} className="sr-only" />
              <span className="flex items-center gap-2 font-semibold"><Trash2 className="h-4 w-4 text-destructive" /> Full Business Reset</span>
              <span className="mt-2 block text-sm text-muted-foreground">Clears all business data including products, customers, suppliers, riders, couriers, inventory, orders, and ledgers. Keeps only users, roles, permissions, and settings.</span>
            </label>
          </div>

          <div className="rounded-lg border bg-card">
            <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="font-semibold">Cleanup Preview</h3>
                <p className="text-sm text-muted-foreground">Review what will be removed before you proceed.</p>
              </div>
              <button type="button" onClick={() => refetchCleanupPreview()} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                <RefreshCcw className="h-4 w-4" /> Refresh
              </button>
            </div>
            {cleanupPreviewLoading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading cleanup preview...</div>
            ) : cleanupPreview ? (
              <div className="space-y-4 p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border p-3"><p className="text-xs uppercase text-muted-foreground">Records affected</p><p className="mt-1 text-2xl font-bold">{cleanupPreview.total_records.toLocaleString()}</p></div>
                  <div className="min-w-0 rounded-lg border p-3 sm:col-span-2"><p className="text-xs uppercase text-muted-foreground">Preserved</p><p className="mt-1 break-words text-sm">{cleanupPreview.preserves.join(', ')}</p></div>
                </div>
                <div className="grid max-h-56 gap-2 overflow-y-auto text-sm sm:grid-cols-2 lg:grid-cols-3">
                  {Object.entries(cleanupPreview.counts).map(([table, count]) => (
                    <div key={table} className="flex min-w-0 justify-between gap-3 rounded border px-3 py-2">
                      <span className="min-w-0 truncate capitalize text-muted-foreground">{table.replaceAll('_', ' ')}</span>
                      <strong>{Number(count || 0).toLocaleString()}</strong>
                    </div>
                  ))}
                </div>
                <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
                  <label className="text-sm font-medium">Confirmation phrase
                    <input
                      value={cleanupConfirmation}
                      onChange={event => setCleanupConfirmation(event.target.value)}
                      className={`${inputClass} mt-1.5 font-mono`}
                      placeholder={cleanupPreview.confirmation_phrase}
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">Type exactly: {cleanupPreview.confirmation_phrase}</span>
                  </label>
                  <button
                    type="button"
                    disabled={runCleanup.isPending || cleanupConfirmation !== cleanupPreview.confirmation_phrase}
                    onClick={() => runCleanup.mutate()}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-destructive px-4 py-2.5 text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                  >
                    {runCleanup.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    Run Cleanup
                  </button>
                </div>
                {cleanupMessage && <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300">{cleanupMessage}</div>}
              </div>
            ) : (
              <div className="p-6 text-sm text-muted-foreground">Unable to load cleanup preview.</div>
            )}
          </div>
        </section>

        <button type="submit" disabled={updateSettings.isPending} className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {updateSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Settings
        </button>
      </form>
    </div>
  )
}
