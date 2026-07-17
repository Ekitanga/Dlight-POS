import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { Download, FileText, Printer, ReceiptText, Search, X } from 'lucide-react'
import { PaginatedResponse, Pagination } from '../../components/Pagination'
import { DateRangeFilter } from '../../components/DateRangeFilter'
import { formatMoney } from '../../lib/format'

interface ReceiptItem {
  product_name: string
  quantity: number
  unit_price: number
  total_price: number
}

interface Receipt {
  id: string
  order_number: string
  customer_name?: string
  customer_phone?: string
  customer_address?: string
  items: ReceiptItem[]
  subtotal: number
  discount: number
  tax: number
  total_amount: number
  paid_amount: number
  delivery_type: string
  delivery_income: number
  delivery_fee_payment_method?: string
  courier_customer_fee?: number
  courier_actual_fee?: number
  courier_tracking_number?: string
  payment_method: string
  payment_status: string
  order_status: string
  created_at: string
  company_name?: string
  logo_url?: string
  company_phone?: string
  company_email?: string
  company_address?: string
  website?: string
  kra_pin?: string
  currency?: string
  mpesa_paybill?: string
  mpesa_account_number?: string
  mpesa_till?: string
  receipt_header?: string
  receipt_footer?: string
  receipt_paper_width?: string
  receipt_show_customer_address?: boolean
  receipt_show_payment_details?: boolean
  receipt_show_delivery_details?: boolean
  courier_name?: string
}

const escapeHtml = (value: unknown) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;')

const money = (receipt: Receipt, amount: number) =>
  formatMoney(amount, receipt.currency || 'KES')

type DocumentVariant = 'delivery' | 'sales'

const isFullyPaid = (receipt: Receipt) =>
  receipt.payment_status === 'paid' && Number(receipt.paid_amount) >= Number(receipt.total_amount)

const isSpeedafPassThroughFee = (receipt: Receipt) =>
  receipt.delivery_type === 'courier' &&
  ['paid_to_courier', 'pay_on_delivery'].includes(receipt.delivery_fee_payment_method || '')

const speedafCustomerFee = (receipt: Receipt) =>
  isSpeedafPassThroughFee(receipt) ? Number(receipt.courier_customer_fee || 0) : 0

const mpesaInstructionRows = (receipt: Receipt) => [
  receipt.mpesa_paybill ? { label: 'Paybill', value: receipt.mpesa_paybill } : null,
  receipt.mpesa_account_number ? { label: 'Account', value: receipt.mpesa_account_number } : null,
  receipt.mpesa_till ? { label: 'Till', value: receipt.mpesa_till } : null
].filter((row): row is { label: string; value: string } => Boolean(row))

const absoluteAssetUrl = (value?: string) => {
  if (!value || value.includes('${')) return ''
  if (/^(https?:|data:)/i.test(value)) return value
  try {
    return new URL(value, window.location.origin).href
  } catch {
    return ''
  }
}

function ReceiptPaper({ receipt, variant }: { receipt: Receipt; variant: DocumentVariant }) {
  const balance = Math.max(0, Number(receipt.total_amount) - Number(receipt.paid_amount))
  const isDeliveryReceipt = variant === 'delivery'
  const passThroughSpeedafFee = speedafCustomerFee(receipt)
  const amountToPay = isDeliveryReceipt
    ? Number(receipt.total_amount) + (receipt.delivery_fee_payment_method === 'pay_on_delivery' ? passThroughSpeedafFee : 0)
    : balance
  const documentTitle = isDeliveryReceipt ? 'Delivery Receipt' : receipt.receipt_header || 'Sales Receipt'
  const logoUrl = absoluteAssetUrl(receipt.logo_url)
  const mpesaRows = mpesaInstructionRows(receipt)
  return (
    <div className="mx-auto w-full max-w-[380px] bg-white p-6 text-[13px] leading-5 text-zinc-900 shadow-sm print:shadow-none">
      <header className="border-b border-dashed border-zinc-400 pb-4 text-center">
        {logoUrl && <img src={logoUrl} alt="" className="mx-auto mb-2 max-h-16 max-w-36 object-contain" />}
        <h3 className="text-lg font-bold">{receipt.company_name || 'Dlight Giftshop'}</h3>
        {receipt.company_address && <p>{receipt.company_address}</p>}
        {(receipt.company_phone || receipt.company_email) && <p>{[receipt.company_phone, receipt.company_email].filter(Boolean).join(' | ')}</p>}
        {receipt.kra_pin && <p>KRA PIN: {receipt.kra_pin}</p>}
      </header>

      <section className="py-4">
        {['cancelled', 'returned'].includes(receipt.order_status) && <div className="mb-3 border-2 border-zinc-900 p-2 text-center text-lg font-bold uppercase">{receipt.order_status} - Not a valid sale</div>}
        <div className="mb-2 text-center font-semibold uppercase">{documentTitle}</div>
        {isDeliveryReceipt && <div className="mb-3 border border-zinc-400 bg-zinc-50 p-2 text-center font-semibold uppercase">For delivery</div>}
        {!isDeliveryReceipt && <div className="mb-3 border border-zinc-900 p-2 text-center font-bold uppercase">Paid</div>}
        <div className="flex justify-between gap-4"><span>{isDeliveryReceipt ? 'Order' : 'Receipt'}</span><strong>{receipt.order_number}</strong></div>
        <div className="flex justify-between gap-4"><span>Date</span><span>{new Date(receipt.created_at).toLocaleString()}</span></div>
        <div className="mt-2"><strong>{receipt.customer_name || 'Walk-in customer'}</strong></div>
        {receipt.customer_phone && <div>{receipt.customer_phone}</div>}
        {receipt.receipt_show_customer_address !== false && receipt.customer_address && <div>{receipt.customer_address}</div>}
      </section>

      <section className="border-y border-dashed border-zinc-400 py-3">
        {(receipt.items || []).map((item, index) => (
          <div key={`${item.product_name}-${index}`} className="mb-2 last:mb-0">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 font-medium">
              <span className="break-words">{item.product_name}</span>
              <span className="whitespace-nowrap text-right">{money(receipt, item.total_price)}</span>
            </div>
            <div className="text-zinc-600">{item.quantity} x {money(receipt, item.unit_price)}</div>
          </div>
        ))}
      </section>

      <section className="space-y-1 py-4">
        <div className="flex justify-between"><span>Subtotal</span><span>{money(receipt, receipt.subtotal)}</span></div>
        {Number(receipt.delivery_income) > 0 && <div className="flex justify-between"><span>Delivery fee</span><span>{money(receipt, receipt.delivery_income)}</span></div>}
        {passThroughSpeedafFee > 0 && (
          <div className="flex justify-between text-zinc-700">
            <span>Speedaf fee {receipt.delivery_fee_payment_method === 'pay_on_delivery' ? 'on delivery' : 'paid to Speedaf'}</span>
            <span>{money(receipt, passThroughSpeedafFee)}</span>
          </div>
        )}
        {Number(receipt.discount) > 0 && <div className="flex justify-between"><span>Discount</span><span>-{money(receipt, receipt.discount)}</span></div>}
        {Number(receipt.tax) > 0 && <div className="flex justify-between"><span>Tax</span><span>{money(receipt, receipt.tax)}</span></div>}
        <div className="mt-2 flex justify-between border-t border-zinc-300 pt-2 text-base font-bold"><span>Total</span><span>{money(receipt, receipt.total_amount)}</span></div>
        {isDeliveryReceipt ? (
          <div className="mt-3 border-2 border-zinc-900 p-3 text-center">
            <div className="text-xs font-semibold uppercase">Amount to Pay</div>
            <div className="mt-1 text-xl font-bold">{money(receipt, amountToPay)}</div>
            {passThroughSpeedafFee > 0 && (
              <p className="mt-1 text-xs text-zinc-600">
                Shop amount {money(receipt, receipt.total_amount)} + Speedaf fee {money(receipt, passThroughSpeedafFee)}
              </p>
            )}
            {mpesaRows.length > 0 && (
              <div className="mt-3 border-t border-zinc-300 pt-3 text-left text-xs">
                <div className="mb-1 font-bold uppercase">Pay via M-PESA</div>
                {mpesaRows.map(row => (
                  <div key={row.label} className="flex justify-between gap-3">
                    <span>{row.label}</span>
                    <strong>{row.value}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : receipt.receipt_show_payment_details !== false && (
          <>
            <div className="flex justify-between"><span>Paid</span><span>{money(receipt, receipt.paid_amount)}</span></div>
            {balance > 0 && <div className="flex justify-between font-semibold"><span>Balance due</span><span>{money(receipt, balance)}</span></div>}
            <div className="flex justify-between capitalize"><span>Payment</span><span>{(receipt.payment_method || 'credit').replaceAll('_', ' ')} - {receipt.payment_status.replaceAll('_', ' ')}</span></div>
          </>
        )}
      </section>

      {receipt.receipt_show_delivery_details !== false && receipt.delivery_type !== 'walk_in' && (
        <section className="border-t border-dashed border-zinc-400 py-3">
          <div className="flex justify-between capitalize"><span>Delivery</span><span>{receipt.delivery_type === 'courier' ? receipt.courier_name || 'Courier' : 'Rider delivery'}</span></div>
          {receipt.courier_tracking_number && <div className="flex justify-between"><span>Tracking</span><strong>{receipt.courier_tracking_number}</strong></div>}
        </section>
      )}

      <footer className="border-t border-dashed border-zinc-400 pt-4 text-center">
        <p>{receipt.receipt_footer || 'Thank you for shopping with us.'}</p>
        {!isDeliveryReceipt && mpesaRows.length > 0 && (
          <div className="mt-3 border-t border-zinc-200 pt-3 text-left text-xs">
            <div className="mb-1 text-center font-bold uppercase">M-PESA details</div>
            {mpesaRows.map(row => (
              <div key={row.label} className="flex justify-between gap-3">
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
        )}
      </footer>
    </div>
  )
}

export function Receipts() {
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [previewDocument, setPreviewDocument] = useState<{ receipt: Receipt; variant: DocumentVariant } | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const { data: receiptPage, isLoading, error } = useQuery<PaginatedResponse<Receipt>>({
    queryKey: ['receipts', search, dateFrom, dateTo, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      params.set('page', String(page))
      params.set('page_size', String(pageSize))
      return (await axios.get(`/api/receipts?${params.toString()}`)).data
    }
  })
  const receipts = receiptPage?.data || []

  const receiptHtml = (receipt: Receipt, variant: DocumentVariant) => {
    const balance = Math.max(0, Number(receipt.total_amount) - Number(receipt.paid_amount))
    const isDeliveryReceipt = variant === 'delivery'
    const passThroughSpeedafFee = speedafCustomerFee(receipt)
    const amountToPay = isDeliveryReceipt
      ? Number(receipt.total_amount) + (receipt.delivery_fee_payment_method === 'pay_on_delivery' ? passThroughSpeedafFee : 0)
      : balance
    const documentTitle = isDeliveryReceipt ? 'DELIVERY RECEIPT' : receipt.receipt_header || 'SALES RECEIPT'
    const logoUrl = absoluteAssetUrl(receipt.logo_url)
    const mpesaInstructions = mpesaInstructionRows(receipt)
      .map(row => `<div class="line"><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.value)}</strong></div>`)
      .join('')
    const rows = (receipt.items || []).map(item => `
      <div class="item">
        <div class="item-main">
          <strong class="item-name">${escapeHtml(item.product_name)}</strong>
          <strong class="item-total">${escapeHtml(money(receipt, item.total_price))}</strong>
        </div>
        <small>${item.quantity} x ${escapeHtml(money(receipt, item.unit_price))}</small>
      </div>`).join('')
    const paperWidth = receipt.receipt_paper_width || '80mm'
    return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt - ${escapeHtml(receipt.order_number)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        :root{--paper:${escapeHtml(paperWidth)}}
        @page{size:var(--paper) auto;margin:4mm}
        *{box-sizing:border-box}
        html,body{margin:0;min-height:100%;background:#f4f4f5}
        body{color:#111827;font:13px/1.45 Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
        main{width:min(100%,var(--paper));max-width:420px;margin:0 auto;background:#fff;padding:16px 14px;box-shadow:0 10px 28px rgba(0,0,0,.08)}
        header,footer{text-align:center}
        .logo{display:block;max-width:88px;max-height:64px;object-fit:contain;margin:0 auto 8px}
        h1{font-size:17px;line-height:1.2;margin:4px 0;text-transform:uppercase}
        p{margin:2px 0}
        .muted{color:#52525b}
        .rule{border-top:1px dashed #9ca3af;margin:12px 0}
        .notice{border:1px solid #111827;padding:7px;text-align:center;font-weight:700;text-transform:uppercase}
        .soft-notice{border:1px solid #a1a1aa;background:#fafafa;padding:7px;text-align:center;font-weight:700;text-transform:uppercase}
        .line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:start;margin:3px 0}
        .line span:last-child,.line strong:last-child{text-align:right}
        .item{margin:9px 0;break-inside:avoid}
        .item-main{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:start}
        .item-name{font-weight:700;word-break:break-word;overflow-wrap:anywhere}
        .item-total{white-space:nowrap;text-align:right}
        small{display:block;color:#52525b;margin-top:2px}
        .total{font-size:15px;font-weight:700;border-top:1px solid #d4d4d8;padding-top:7px;margin-top:7px}
        .amount-box{border:2px solid #111827;padding:10px;margin-top:10px;text-align:center}
        .amount-box .amount{font-size:18px;font-weight:800}
        .pay-box{border-top:1px solid #d4d4d8;margin-top:9px;padding-top:8px;text-align:left}
        @media screen and (max-width:480px){
          body{background:#fff;font-size:14px}
          main{width:100%;max-width:none;min-height:100vh;padding:22px 20px;box-shadow:none}
        }
        @media print{body{background:#fff;font-size:12px}main{width:var(--paper);max-width:var(--paper);box-shadow:none;padding:0}.no-print{display:none}}
      </style></head><body><main>
      <header>${logoUrl ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="">` : ''}
        <h1>${escapeHtml(receipt.company_name || 'Dlight Giftshop')}</h1>
        ${receipt.company_address ? `<p>${escapeHtml(receipt.company_address)}</p>` : ''}
        <p>${escapeHtml([receipt.company_phone, receipt.company_email].filter(Boolean).join(' | '))}</p>
        ${receipt.kra_pin ? `<p>KRA PIN: ${escapeHtml(receipt.kra_pin)}</p>` : ''}
      </header><div class="rule"></div>
      ${['cancelled', 'returned'].includes(receipt.order_status) ? `<p class="notice">${escapeHtml(receipt.order_status.toUpperCase())} - NOT A VALID SALE</p>` : ''}
      <p style="text-align:center;font-weight:bold">${escapeHtml(documentTitle)}</p>
      ${isDeliveryReceipt ? '<p class="soft-notice">FOR DELIVERY</p>' : '<p class="notice">PAID</p>'}
      <div class="line"><span>${isDeliveryReceipt ? 'Order' : 'Receipt'}</span><strong>${escapeHtml(receipt.order_number)}</strong></div>
      <div class="line"><span>Date</span><span>${escapeHtml(new Date(receipt.created_at).toLocaleString())}</span></div>
      <p><strong>${escapeHtml(receipt.customer_name || 'Walk-in customer')}</strong></p>
      ${receipt.customer_phone ? `<p>${escapeHtml(receipt.customer_phone)}</p>` : ''}
      ${receipt.receipt_show_customer_address !== false && receipt.customer_address ? `<p>${escapeHtml(receipt.customer_address)}</p>` : ''}
      <div class="rule"></div>${rows}<div class="rule"></div>
      <div class="line"><span>Subtotal</span><span>${escapeHtml(money(receipt, receipt.subtotal))}</span></div>
      ${Number(receipt.delivery_income) > 0 ? `<div class="line"><span>Delivery fee</span><span>${escapeHtml(money(receipt, receipt.delivery_income))}</span></div>` : ''}
      ${passThroughSpeedafFee > 0 ? `<div class="line"><span>Speedaf fee ${receipt.delivery_fee_payment_method === 'pay_on_delivery' ? 'on delivery' : 'paid to Speedaf'}</span><span>${escapeHtml(money(receipt, passThroughSpeedafFee))}</span></div>` : ''}
      ${Number(receipt.discount) > 0 ? `<div class="line"><span>Discount</span><span>-${escapeHtml(money(receipt, receipt.discount))}</span></div>` : ''}
      ${Number(receipt.tax) > 0 ? `<div class="line"><span>Tax</span><span>${escapeHtml(money(receipt, receipt.tax))}</span></div>` : ''}
      <div class="line total"><span>Total</span><span>${escapeHtml(money(receipt, receipt.total_amount))}</span></div>
      ${isDeliveryReceipt ? `<div class="amount-box">
        <strong style="font-size:11px">AMOUNT TO PAY</strong>
        <div class="amount">${escapeHtml(money(receipt, amountToPay))}</div>
        ${passThroughSpeedafFee > 0 ? `<p class="muted">Shop amount ${escapeHtml(money(receipt, receipt.total_amount))} + Speedaf fee ${escapeHtml(money(receipt, passThroughSpeedafFee))}</p>` : ''}
        ${mpesaInstructions ? `<div class="pay-box"><strong>PAY VIA M-PESA</strong>${mpesaInstructions}</div>` : ''}
      </div>` : receipt.receipt_show_payment_details !== false ? `<div class="line"><span>Paid</span><span>${escapeHtml(money(receipt, receipt.paid_amount))}</span></div>
        ${balance > 0 ? `<div class="line"><strong>Balance due</strong><strong>${escapeHtml(money(receipt, balance))}</strong></div>` : ''}
        <div class="line"><span>Payment</span><span>${escapeHtml((receipt.payment_method || 'credit').replaceAll('_', ' '))}</span></div>
        ${mpesaInstructions ? `<div class="pay-box"><strong>M-PESA DETAILS</strong>${mpesaInstructions}</div>` : ''}` : ''}
      ${receipt.receipt_show_delivery_details !== false && receipt.delivery_type === 'courier' ? `<div class="rule"></div><div class="line"><span>Courier</span><span>${escapeHtml(receipt.courier_name || 'Courier')}</span></div>
        ${receipt.courier_tracking_number ? `<div class="line"><span>Tracking</span><strong>${escapeHtml(receipt.courier_tracking_number)}</strong></div>` : ''}` : ''}
      <div class="rule"></div><footer><p>${escapeHtml(receipt.receipt_footer || 'Thank you for shopping with us.')}</p></footer>
      </main></body></html>`
  }

  const printReceipt = (receipt: Receipt, variant: DocumentVariant) => {
    const printWindow = window.open('', '_blank')
    if (!printWindow) return
    printWindow.document.write(receiptHtml(receipt, variant))
    printWindow.document.close()
    printWindow.addEventListener('load', () => printWindow.print(), { once: true })
  }

  const downloadReceipt = (receipt: Receipt, variant: DocumentVariant) => {
    const blob = new Blob([receiptHtml(receipt, variant)], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${variant}-receipt-${receipt.order_number}.html`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  if (error) return <div className="flex h-64 items-center justify-center text-muted-foreground">Failed to load receipts</div>

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-bold">Customer Receipts</h1><p className="text-muted-foreground">Print delivery receipts before payment and final sales receipts after confirmation</p></div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative max-w-sm flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} className="w-full rounded-lg border py-2 pl-10 pr-4" placeholder="Search order number" /></div>
        <DateRangeFilter
          dateFrom={dateFrom}
          dateTo={dateTo}
          compact
          onChange={range => { setDateFrom(range.dateFrom); setDateTo(range.dateTo); setPage(1) }}
          onClear={() => { setDateFrom(''); setDateTo(''); setPage(1) }}
        />
      </div>

      {isLoading ? <div className="h-64 animate-pulse rounded bg-muted" /> : receipts.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground">No receipts found</div>
      ) : (
        <div className="mobile-scroll-table overflow-x-auto rounded-lg border">
          <table className="w-full">
            <thead className="bg-muted"><tr><th className="px-4 py-3 text-left">Document</th><th className="px-4 py-3 text-left">Customer</th><th className="px-4 py-3 text-left">Date</th><th className="px-4 py-3 text-left">Total</th><th className="px-4 py-3 text-left">Payment</th><th className="px-4 py-3 text-right">Actions</th></tr></thead>
            <tbody>{receipts.map(receipt => (
              <tr key={receipt.id} className="border-t hover:bg-muted/50">
                <td className="px-4 py-3"><div className="font-medium">{receipt.order_number}</div><div className="text-xs text-muted-foreground">{receipt.delivery_type !== 'walk_in' ? (isFullyPaid(receipt) ? 'Delivery + Sales Receipts' : 'Delivery Receipt') : (isFullyPaid(receipt) ? 'Sales Receipt' : 'Payment pending')}</div></td><td className="px-4 py-3">{receipt.customer_name || 'Walk-in'}</td>
                <td className="px-4 py-3">{new Date(receipt.created_at).toLocaleDateString()}</td><td className="px-4 py-3 font-medium">{money(receipt, receipt.total_amount)}</td>
                <td className="px-4 py-3 capitalize">{(receipt.payment_method || 'credit').replaceAll('_', ' ')}</td>
                <td className="px-4 py-3"><div className="flex justify-end gap-1">
                  {receipt.delivery_type !== 'walk_in' && <button onClick={() => setPreviewDocument({ receipt, variant: 'delivery' })} className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground" title="Delivery Receipt"><FileText className="h-4 w-4" /></button>}
                  {isFullyPaid(receipt) && <button onClick={() => setPreviewDocument({ receipt, variant: 'sales' })} className="rounded p-2 text-primary hover:bg-primary/10" title="Sales Receipt"><ReceiptText className="h-4 w-4" /></button>}
                </div></td>
              </tr>
            ))}</tbody>
          </table>
          {receiptPage && <Pagination meta={receiptPage.pagination} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} />}
        </div>
      )}

      {previewDocument && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-lg bg-muted shadow-xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3"><div><h2 className="font-semibold">{previewDocument.variant === 'delivery' ? 'Delivery Receipt Preview' : 'Sales Receipt Preview'}</h2><p className="text-xs text-muted-foreground">{previewDocument.receipt.order_number}</p></div><button onClick={() => setPreviewDocument(null)} className="rounded p-2 text-muted-foreground hover:bg-muted" title="Close"><X className="h-4 w-4" /></button></div>
            <div className="p-4"><ReceiptPaper receipt={previewDocument.receipt} variant={previewDocument.variant} /></div>
            <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t bg-background p-4">
              <button onClick={() => downloadReceipt(previewDocument.receipt, previewDocument.variant)} className="inline-flex items-center gap-2 rounded-lg border px-4 py-2"><Download className="h-4 w-4" />Download HTML</button>
              <button onClick={() => printReceipt(previewDocument.receipt, previewDocument.variant)} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground"><Printer className="h-4 w-4" />Print / Save PDF</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
