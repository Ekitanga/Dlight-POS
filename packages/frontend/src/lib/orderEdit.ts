export function trackingIsOnlyEdit<T extends { delivery_type: string; courier_tracking_number: string }>(current: T, original: T): boolean {
  if (current.delivery_type !== 'courier') return false
  if (!current.courier_tracking_number.trim() || current.courier_tracking_number.trim() === original.courier_tracking_number.trim()) return false
  return (Object.keys(original) as Array<keyof T>).every(key =>
    key === 'courier_tracking_number' || JSON.stringify(current[key]) === JSON.stringify(original[key])
  )
}
