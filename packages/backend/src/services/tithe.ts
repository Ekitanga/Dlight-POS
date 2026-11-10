import { query } from '../db/index.js'
import { profitSummary, type ProfitSummary } from '../lib/profit.js'

export type TitheBasis = 'net_profit' | 'gross_profit' | 'revenue'
export const TITHE_BASES: TitheBasis[] = ['net_profit', 'gross_profit', 'revenue']
export const TITHE_PAYMENT_METHODS = ['cash', 'mpesa', 'bank_transfer', 'other'] as const
const MAX_MONTHS = 120

export interface TitheSettings {
  enabled: boolean
  rate_percent: number
  basis: TitheBasis
  start_date: string
  recipient_name: string | null
  updated_at: string | null
}

export interface TitheMonth {
  month: string // YYYY-MM
  period_start: string
  period_end: string
  in_progress: boolean
  revenue: number
  gross_profit: number
  net_profit: number
  basis_amount: number
  tithe_due: number
  paid: number
  balance_after: number
}

export function nairobiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function round2(value: number) {
  return Math.round(value * 100) / 100
}

function lastDayOfMonth(year: number, monthIndex: number): string {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10)
}

export async function getTitheSettings(): Promise<TitheSettings> {
  const result = await query(
    `SELECT enabled, rate_percent, basis, start_date, recipient_name, updated_at FROM tithe_settings WHERE id = 1`
  )
  const row = result.rows[0]
  if (!row) {
    return { enabled: false, rate_percent: 10, basis: 'net_profit', start_date: `${nairobiToday().slice(0, 7)}-01`, recipient_name: null, updated_at: null }
  }
  return {
    enabled: row.enabled === true,
    rate_percent: Number(row.rate_percent),
    basis: row.basis,
    start_date: String(row.start_date),
    recipient_name: row.recipient_name,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
  }
}

function basisAmount(basis: TitheBasis, profit: ProfitSummary) {
  if (basis === 'revenue') return profit.revenue
  if (basis === 'gross_profit') return profit.grossProfit
  return profit.netProfit
}

/**
 * Month-by-month tithe owed from the configured start date to today.
 * Each month's tithe = rate x max(0, basis amount). A loss month owes nothing
 * and does not reduce other months. The current month is shown to date and
 * keeps growing until the month ends.
 */
export async function titheSummary(settings: TitheSettings) {
  const today = nairobiToday()
  const startDate = settings.start_date > today ? today : settings.start_date
  const [startYear, startMonth] = startDate.split('-').map(Number)
  const [todayYear, todayMonth] = today.split('-').map(Number)
  const totalMonths = Math.min(MAX_MONTHS, (todayYear - startYear) * 12 + (todayMonth - startMonth) + 1)
  const firstIndex = (todayYear * 12 + todayMonth - 1) - (totalMonths - 1)

  const paymentsResult = await query(
    `SELECT to_char(paid_on, 'YYYY-MM') AS month, SUM(amount) AS paid
     FROM tithe_payments
     WHERE voided_at IS NULL AND paid_on >= $1
     GROUP BY 1`,
    [startDate]
  )
  const paidByMonth = new Map<string, number>(paymentsResult.rows.map(row => [row.month, Number(row.paid)]))

  const months: TitheMonth[] = []
  let runningBalance = 0
  for (let offset = 0; offset < totalMonths; offset += 1) {
    const index = firstIndex + offset
    const year = Math.floor(index / 12)
    const monthIndex = index % 12
    const month = `${year}-${String(monthIndex + 1).padStart(2, '0')}`
    const monthStart = `${month}-01`
    const periodStart = monthStart < startDate ? startDate : monthStart
    const monthEnd = lastDayOfMonth(year, monthIndex)
    const inProgress = monthEnd >= today
    const periodEnd = inProgress ? today : monthEnd

    const profit = await profitSummary({ query }, periodStart, periodEnd)
    const base = round2(basisAmount(settings.basis, profit))
    const due = round2(Math.max(0, base) * settings.rate_percent / 100)
    const paid = round2(paidByMonth.get(month) || 0)
    runningBalance = round2(runningBalance + due - paid)

    months.push({
      month,
      period_start: periodStart,
      period_end: periodEnd,
      in_progress: inProgress,
      revenue: round2(profit.revenue),
      gross_profit: round2(profit.grossProfit),
      net_profit: round2(profit.netProfit),
      basis_amount: base,
      tithe_due: due,
      paid,
      balance_after: runningBalance
    })
  }

  const totalDue = round2(months.reduce((sum, row) => sum + row.tithe_due, 0))
  const currentMonth = months.find(row => row.in_progress) || null
  const totalPaid = round2(months.reduce((sum, row) => sum + row.paid, 0))
  const dueForCompletedMonths = round2(totalDue - (currentMonth?.tithe_due || 0))
  const outstanding = round2(totalDue - totalPaid)

  return {
    as_of: today,
    settings,
    totals: {
      total_due: totalDue,
      total_paid: totalPaid,
      outstanding,
      // What is owed for months that have fully ended, after all payments so far.
      outstanding_completed_months: round2(dueForCompletedMonths - totalPaid),
      current_month_accrued: currentMonth?.tithe_due || 0
    },
    months: months.reverse()
  }
}
