const OPENING_BALANCE_SOURCE_ID = '00000000-0000-0000-0000-000000000001'

export interface LiquidOpeningBalances {
  cash: number
  mpesa: number
  bank: number
}

function amount(value: unknown): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0
}

function openingLine(code: string, value: number, side: 'debit' | 'credit', memo: string) {
  return {
    code,
    debit: side === 'debit' ? value : 0,
    credit: side === 'credit' ? value : 0,
    memo
  }
}

export async function accountingStatus(db: any) {
  const [settings, balances] = await Promise.all([
    db.query(`SELECT enabled, cutover_date, activated_at, activated_by
      FROM accounting_settings WHERE singleton_key = TRUE`),
    db.query(`SELECT
      COALESCE((SELECT SUM(cc.amount)
        FROM customer_credits cc
        LEFT JOIN orders o ON o.id = cc.order_id
        WHERE cc.order_id IS NULL OR o.status IN ('delivered','collected_paid')), 0) AS receivables,
      COALESCE((SELECT SUM(GREATEST(cod_amount-remitted_amount, 0)) FROM cod_collections
        WHERE status NOT IN ('closed','remitted','returned')), 0) AS cod_receivables,
      COALESCE((SELECT SUM(GREATEST(i.quantity, 0) * p.cost_price)
        FROM inventory i JOIN products p ON p.id=i.product_id
        WHERE p.deleted_at IS NULL), 0)
        + COALESCE((SELECT SUM(oi.unit_cost * oi.internal_quantity)
          FROM order_items oi JOIN orders o ON o.id=oi.order_id
          WHERE o.status NOT IN ('delivered','collected_paid','returned','cancelled')), 0) AS inventory,
      COALESCE((SELECT SUM(sp.amount) FROM supplier_payables sp), 0)
        - COALESCE((SELECT SUM(amount) FROM supplier_payments), 0)
        - COALESCE((SELECT SUM(amount) FROM supplier_returns), 0) AS supplier_payables,
      COALESCE((SELECT SUM(GREATEST(sp.amount - sp.paid_amount
        - COALESCE((SELECT SUM(sr.amount) FROM supplier_returns sr WHERE sr.payable_id=sp.id), 0), 0))
        FROM supplier_payables sp JOIN orders o ON o.id=sp.order_id
        WHERE o.status NOT IN ('delivered','collected_paid','returned','cancelled')), 0) AS supplier_clearing,
      COALESCE((SELECT SUM(re.amount) FROM rider_earnings re WHERE re.status <> 'reversed'), 0)
        - COALESCE((SELECT SUM(amount) FROM rider_payments), 0) AS rider_payables,
      COALESCE((SELECT SUM(re.amount) FROM rider_earnings re JOIN orders o ON o.id=re.order_id
        WHERE re.status <> 'reversed' AND o.status NOT IN ('delivered','collected_paid','returned','cancelled')), 0) AS delivery_clearing,
      COALESCE((SELECT SUM(op.amount) FROM order_payments op JOIN orders o ON o.id=op.order_id
        WHERE o.status NOT IN ('delivered','collected_paid','returned','cancelled')), 0) AS customer_deposits,
      COALESCE((SELECT SUM(amount) FROM order_refunds WHERE status='pending'), 0) AS refunds_payable`)
  ])
  const row = balances.rows[0] || {}
  return {
    enabled: Boolean(settings.rows[0]?.enabled),
    cutoverDate: settings.rows[0]?.cutover_date || null,
    activatedAt: settings.rows[0]?.activated_at || null,
    suggestedBalances: {
      receivables: amount(row.receivables),
      codReceivables: amount(row.cod_receivables),
      inventory: amount(row.inventory),
      supplierClearing: Math.max(0, amount(row.supplier_clearing)),
      deliveryClearing: Math.max(0, amount(row.delivery_clearing)),
      supplierPayables: Math.max(0, amount(row.supplier_payables)),
      riderPayables: Math.max(0, amount(row.rider_payables)),
      customerDeposits: Math.max(0, amount(row.customer_deposits)),
      refundsPayable: Math.max(0, amount(row.refunds_payable))
    }
  }
}

export async function activateAccounting(
  client: any,
  cutoverDate: string,
  liquid: LiquidOpeningBalances,
  userId: string
) {
  const locked = await client.query(
    'SELECT enabled FROM accounting_settings WHERE singleton_key=TRUE FOR UPDATE'
  )
  if (locked.rows[0]?.enabled) {
    throw Object.assign(new Error('Accounting has already been activated'), { statusCode: 409 })
  }

  const status = await accountingStatus(client)
  const suggested = status.suggestedBalances
  const lines: Array<Record<string, unknown>> = []
  const add = (code: string, value: number, side: 'debit' | 'credit', memo: string) => {
    if (value > 0) lines.push(openingLine(code, value, side, memo))
  }
  add('1000', liquid.cash, 'debit', 'Verified opening cash')
  add('1010', liquid.mpesa, 'debit', 'Verified opening M-Pesa')
  add('1020', liquid.bank, 'debit', 'Verified opening bank')
  add('1100', suggested.receivables, 'debit', 'Opening customer receivables')
  add('1120', suggested.codReceivables, 'debit', 'Opening courier COD receivables')
  add('1200', suggested.inventory, 'debit', 'Opening inventory valuation')
  add('1300', suggested.supplierClearing, 'debit', 'Opening supplier fulfilment clearing')
  add('1310', suggested.deliveryClearing, 'debit', 'Opening delivery cost clearing')
  add('2000', suggested.supplierPayables, 'credit', 'Opening supplier payables')
  add('2010', suggested.riderPayables, 'credit', 'Opening rider payables')
  add('2020', suggested.refundsPayable, 'credit', 'Opening pending refunds')
  add('2200', suggested.customerDeposits, 'credit', 'Opening customer deposits')

  const debits = lines.reduce((total, line) => total + Number(line.debit || 0), 0)
  const credits = lines.reduce((total, line) => total + Number(line.credit || 0), 0)
  const difference = Math.round((debits - credits) * 100) / 100
  if (difference > 0) add('3000', difference, 'credit', 'Opening retained equity')
  if (difference < 0) add('3000', Math.abs(difference), 'debit', 'Opening accumulated deficit')

  await client.query(
    `UPDATE accounting_settings SET enabled=TRUE, cutover_date=$1, activated_by=$2,
      activated_at=NOW(), updated_at=NOW() WHERE singleton_key=TRUE`,
    [cutoverDate, userId]
  )
  if (lines.length > 0) {
    await client.query(
      `SELECT post_accounting_journal($1,$2,'opening_balance',$3,'activated',$4,$5::jsonb)`,
      [cutoverDate, `Opening balances at ${cutoverDate}`, OPENING_BALANCE_SOURCE_ID, userId, JSON.stringify(lines)]
    )
  }
  return accountingStatus(client)
}

export async function materializeRecurringExpenses(client: any, throughDate: string, userId: string) {
  await client.query('SELECT materialize_recurring_expense_journals($1,$2)', [throughDate, userId])
}

export async function trialBalance(client: any, dateFrom: string, dateTo: string, showZero = false) {
  const result = await client.query(
    `WITH movement AS (
      SELECT a.id, a.code, a.name, a.account_type, a.normal_balance,
        COALESCE(SUM(jl.debit-jl.credit) FILTER (WHERE je.accounting_date < $1), 0) AS opening_net,
        COALESCE(SUM(jl.debit) FILTER (WHERE je.accounting_date BETWEEN $1 AND $2), 0) AS period_debit,
        COALESCE(SUM(jl.credit) FILTER (WHERE je.accounting_date BETWEEN $1 AND $2), 0) AS period_credit,
        COALESCE(SUM(jl.debit-jl.credit) FILTER (WHERE je.accounting_date <= $2), 0) AS closing_net
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id=a.id
      LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id
      WHERE a.is_active
      GROUP BY a.id
    )
    SELECT code, name AS account, account_type,
      CASE WHEN opening_net > 0 THEN opening_net ELSE 0 END AS opening_debit,
      CASE WHEN opening_net < 0 THEN -opening_net ELSE 0 END AS opening_credit,
      period_debit, period_credit,
      CASE WHEN closing_net > 0 THEN closing_net ELSE 0 END AS closing_debit,
      CASE WHEN closing_net < 0 THEN -closing_net ELSE 0 END AS closing_credit
    FROM movement
    WHERE $3::boolean OR ABS(opening_net) >= 0.005 OR period_debit >= 0.005
      OR period_credit >= 0.005 OR ABS(closing_net) >= 0.005
    ORDER BY code`,
    [dateFrom, dateTo, showZero]
  )
  const sum = (key: string) => result.rows.reduce((total: number, row: any) => total + amount(row[key]), 0)
  const totals = {
    openingDebit: sum('opening_debit'),
    openingCredit: sum('opening_credit'),
    periodDebit: sum('period_debit'),
    periodCredit: sum('period_credit'),
    closingDebit: sum('closing_debit'),
    closingCredit: sum('closing_credit')
  }
  const difference = Math.round((totals.closingDebit - totals.closingCredit) * 100) / 100
  return {
    period: { dateFrom, dateTo },
    rows: result.rows,
    totals: { ...totals, difference, isBalanced: Math.abs(difference) < 0.005 }
  }
}
