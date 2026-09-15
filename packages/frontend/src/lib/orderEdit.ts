function comparable(value: unknown): unknown {
  if (value === undefined || value === null || value === '' || Number.isNaN(value)) return null
  if (Array.isArray(value)) return value.map(comparable)
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, comparable(item)]))
  }
  return value
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right))
}

export function orderEditHasChanges<T extends { courier_tracking_number: string }>(current: T, original: T): boolean {
  return (Object.keys(original) as Array<keyof T>).some(key =>
    key === 'courier_tracking_number'
      ? current.courier_tracking_number.trim() !== original.courier_tracking_number.trim()
      : !sameValue(current[key], original[key])
  )
}

export function trackingIsOnlyEdit<T extends { delivery_type: string; courier_tracking_number: string }>(current: T, original: T): boolean {
  if (current.delivery_type !== 'courier') return false
  if (!current.courier_tracking_number.trim() || current.courier_tracking_number.trim() === original.courier_tracking_number.trim()) return false
  return (Object.keys(original) as Array<keyof T>).every(key =>
    key === 'courier_tracking_number' || sameValue(current[key], original[key])
  )
}
