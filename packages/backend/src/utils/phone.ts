export function normalizeKenyanPhone(value: unknown): string | null {
  const digits = String(value || '').replace(/\D/g, '')
  if (!digits) return null
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`
  if (/^254[17]\d{8}$/.test(digits)) return digits
  return digits
}

export function displayKenyanPhone(value: unknown): string {
  const normalized = normalizeKenyanPhone(value)
  const digits = String(normalized || value || '').replace(/\D/g, '')
  if (/^254[17]\d{8}$/.test(digits)) return `0${digits.slice(3)}`
  if (/^0[17]\d{8}$/.test(digits)) return digits
  return digits
}

export function maskedPhoneLabel(value: unknown): string {
  const displayPhone = displayKenyanPhone(value)
  if (!displayPhone) return ''
  if (displayPhone.length <= 6) return displayPhone
  return `${displayPhone.slice(0, 2)}****${displayPhone.slice(-4)}`
}

export function fallbackCustomerName(value: unknown): string {
  const maskedPhone = maskedPhoneLabel(value)
  return maskedPhone ? `Customer ${maskedPhone}` : 'Walk-in Customer'
}
