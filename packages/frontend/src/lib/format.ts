export function formatNumber(value: unknown, maximumFractionDigits = 0) {
  return new Intl.NumberFormat('en-KE', {
    maximumFractionDigits,
    minimumFractionDigits: 0
  }).format(Number(value || 0))
}

export function formatMoney(value: unknown, currency = 'KES') {
  return `${currency} ${formatNumber(Math.round(Number(value || 0)))}`
}
