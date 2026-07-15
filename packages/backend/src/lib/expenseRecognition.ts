export function recognizedExpensesSql(dateFromSql: string, dateToSql: string): string {
  return `(
    SELECT COALESCE(SUM(
      CASE
        WHEN e.frequency = 'one_off' THEN e.amount
        WHEN e.frequency = 'daily' THEN e.amount
        WHEN e.frequency = 'monthly' THEN
          e.amount / EXTRACT(DAY FROM (date_trunc('month', days.day)::date + INTERVAL '1 month - 1 day'))::numeric
        ELSE 0
      END
    ), 0)
    FROM generate_series(${dateFromSql}::date, ${dateToSql}::date, INTERVAL '1 day') AS days(day)
    JOIN expenses e ON e.status = 'approved'
      AND e.expense_date <= days.day::date
      AND (e.effective_end_date IS NULL OR e.effective_end_date >= days.day::date)
      AND (
        e.frequency IN ('daily', 'monthly')
        OR (e.frequency = 'one_off' AND e.expense_date = days.day::date)
      )
  )`
}
