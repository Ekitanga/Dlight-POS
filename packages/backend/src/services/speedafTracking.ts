import { createHash } from 'node:crypto'
import { query, transaction } from '../db/index.js'
import { logAudit } from '../utils/audit.js'

const PARCELS_API_URL = 'https://parcelsapp.com/api/v4'
const DELIVERED_COLLECTED_MARKER = 'parceldeliveredcollectedandreceived'

type TrackingSource = 'manual' | 'scheduled'

interface ProviderEvent {
  state?: string
  status?: string
  message?: string
  date?: string
  location?: string
  [key: string]: unknown
}

interface ProviderResult {
  tracking_number?: string
  state?: string
  status?: string
  error?: string
  shipment?: {
    status?: string
    state?: string
    states?: ProviderEvent[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface ProviderResponse {
  request_id?: string
  done?: boolean
  results?: ProviderResult[]
  rejected?: Array<{ tracking_number?: string; error?: string }>
}

interface SyncOptions {
  orderId?: string
  userId?: string | null
  source: TrackingSource
  provider?: (trackingNumbers: string[]) => Promise<ProviderResult[]>
}

interface DeliveryRecord {
  id: string
  order_id: string
  order_number: string
  order_status: string
  courier_tracking_number: string
}

function normalized(value: unknown) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function isSpeedafDeliveredCollectedEvent(value: unknown) {
  return normalized(value).includes(DELIVERED_COLLECTED_MARKER)
}

function eventMessage(event: ProviderEvent) {
  return String(event.state || event.message || event.status || '').trim()
}

function eventDate(event: ProviderEvent) {
  const value = String(event.date || '').trim()
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function sleep(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function providerRequest(path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) {
  const apiKey = String(process.env.PARCELS_API_KEY || '').trim()
  if (!apiKey) {
    throw Object.assign(new Error('Speedaf tracking is not configured. Add the ParcelsApp API key on the server.'), { statusCode: 503 })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(`${PARCELS_API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init?.headers || {})
      }
    })
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const message = String(payload.message || payload.error || `Tracking provider returned ${response.status}`)
      throw Object.assign(new Error(message), { statusCode: response.status >= 500 ? 502 : 400 })
    }
    return payload as ProviderResponse
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Speedaf tracking request timed out'), { statusCode: 504 })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchProviderTracking(trackingNumbers: string[]) {
  let response = await providerRequest('/trackings', {
    method: 'POST',
    body: JSON.stringify({
      language: 'en',
      shipments: trackingNumbers.map(tracking_number => ({ tracking_number, destination_country: 'KE' }))
    })
  })

  for (let attempt = 0; !response.done && response.request_id && attempt < 7; attempt += 1) {
    await sleep(1_500)
    response = await providerRequest(`/trackings/${encodeURIComponent(response.request_id)}`)
  }
  if (!response.done) {
    throw Object.assign(new Error('Tracking provider is still processing the request. Try again shortly.'), { statusCode: 503 })
  }

  const rejected = new Map((response.rejected || []).map(item => [String(item.tracking_number || '').trim(), item.error]))
  return trackingNumbers.map(trackingNumber => {
    const result = (response.results || []).find(item => String(item.tracking_number || '').trim() === trackingNumber)
    return result || { tracking_number: trackingNumber, error: rejected.get(trackingNumber) || 'No tracking result returned' }
  })
}

function trackingEvents(result: ProviderResult) {
  const states = Array.isArray(result.shipment?.states) ? result.shipment!.states! : []
  if (states.length) {
    return [...states].sort((left, right) => {
      const leftDate = eventDate(left)
      const rightDate = eventDate(right)
      return (rightDate ? new Date(rightDate).getTime() : 0) - (leftDate ? new Date(leftDate).getTime() : 0)
    })
  }
  const fallback = String(result.shipment?.state || result.shipment?.status || result.state || result.status || '').trim()
  return fallback ? [{ state: fallback }] : []
}

function eventKey(deliveryId: string, trackingNumber: string, event: ProviderEvent) {
  return createHash('sha256')
    .update(JSON.stringify([deliveryId, trackingNumber, eventMessage(event), event.date || '', event.location || '']))
    .digest('hex')
}

async function recordResult(
  delivery: DeliveryRecord,
  result: ProviderResult,
  { userId, source }: Pick<SyncOptions, 'userId' | 'source'>
) {
  const events = trackingEvents(result)
  const matched = events.find(event => isSpeedafDeliveredCollectedEvent(eventMessage(event)))
  const latest = matched || events[0]
  const message = latest ? eventMessage(latest) : ''
  const providerStatus = String(result.shipment?.status || result.status || result.state || '').trim() || null
  const occurredAt = latest ? eventDate(latest) : null
  const providerError = String(result.error || '').trim()

  if (providerError) {
    await query(
      `UPDATE deliveries SET tracking_provider = 'parcelsapp', tracking_checked_at = NOW(), tracking_sync_error = $2 WHERE id = $1`,
      [delivery.id, providerError]
    )
    return { transitioned: false, error: providerError }
  }

  return transaction(async client => {
    let matchedEventId: string | null = null
    for (const event of events) {
      const inserted = await client.query(
        `INSERT INTO courier_tracking_events
          (delivery_id, order_id, provider, tracking_number, provider_status, message, location, event_at, external_event_key, raw_payload)
         VALUES ($1, $2, 'parcelsapp', $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (external_event_key) DO UPDATE SET observed_at = NOW()
         RETURNING id`,
        [delivery.id, delivery.order_id, delivery.courier_tracking_number, providerStatus,
          eventMessage(event) || providerStatus || 'Tracking update', event.location || null, eventDate(event),
          eventKey(delivery.id, delivery.courier_tracking_number, event), event]
      )
      if (event === matched) matchedEventId = inserted.rows[0]?.id || null
    }

    await client.query(
      `UPDATE deliveries
       SET tracking_provider = 'parcelsapp', tracking_provider_status = $2, tracking_message = $3,
           tracking_event_at = $4, tracking_checked_at = NOW(), tracking_sync_error = NULL
       WHERE id = $1`,
      [delivery.id, providerStatus, message || providerStatus, occurredAt]
    )

    if (!matched) return { transitioned: false, error: null }

    const locked = await client.query(
      `SELECT o.status, o.delivery_type, o.courier_payment_type, cr.name AS courier_name
       FROM orders o
       JOIN deliveries d ON d.order_id = o.id
       LEFT JOIN couriers cr ON cr.id = d.courier_id
       WHERE o.id = $1 AND d.id = $2 FOR UPDATE OF o, d`,
      [delivery.order_id, delivery.id]
    )
    const order = locked.rows[0]
    if (!order || !String(order.courier_name || '').toLowerCase().includes('speedaf') ||
      order.delivery_type !== 'courier' || order.courier_payment_type !== 'cod' ||
      !['confirmed', 'packed', 'in_transit', 'dispatched'].includes(order.status)) {
      return { transitioned: false, error: null }
    }

    await client.query(
      `UPDATE orders SET status = 'delivered', updated_at = NOW() WHERE id = $1`,
      [delivery.order_id]
    )
    await client.query(
      `UPDATE deliveries
       SET delivery_status = 'delivered', delivered_at = COALESCE(delivered_at, $2::timestamp, NOW()),
           tracking_auto_updated_at = NOW()
       WHERE id = $1`,
      [delivery.id, occurredAt]
    )
    await client.query(
      `UPDATE cod_collections
       SET status = CASE WHEN status IN ('remitted', 'closed') THEN status ELSE 'delivered_awaiting_remittance' END,
           delivered_at = COALESCE(delivered_at, $2::timestamp, NOW())
       WHERE order_id = $1`,
      [delivery.order_id, occurredAt]
    )
    if (matchedEventId) {
      await client.query('UPDATE courier_tracking_events SET triggered_transition = TRUE WHERE id = $1', [matchedEventId])
    }
    await logAudit({
      client,
      userId: userId || null,
      action: 'speedaf_tracking_auto_delivered',
      entityType: 'order',
      entityId: delivery.order_id,
      oldValues: { status: order.status },
      newValues: { status: 'delivered', workflow_status: 'pending_payment' },
      metadata: {
        source,
        provider: 'parcelsapp',
        tracking_number: delivery.courier_tracking_number,
        matched_event: message,
        event_at: occurredAt
      }
    })
    return { transitioned: true, error: null }
  })
}

export async function syncSpeedafTracking(options: SyncOptions) {
  const params: unknown[] = []
  let orderFilter = ''
  if (options.orderId) {
    params.push(options.orderId)
    orderFilter = `AND o.id = $${params.length}`
  }
  const limit = Math.min(100, Math.max(1, Number(process.env.SPEEDAF_TRACKING_BATCH_SIZE || 50)))
  params.push(limit)
  const deliveries = (await query(
    `SELECT d.id, d.order_id, o.order_number, o.status AS order_status, d.courier_tracking_number
     FROM deliveries d
     JOIN orders o ON o.id = d.order_id
     JOIN couriers cr ON cr.id = d.courier_id
     WHERE LOWER(cr.name) LIKE '%speedaf%'
       AND o.delivery_type = 'courier' AND o.courier_payment_type = 'cod'
       AND NULLIF(TRIM(d.courier_tracking_number), '') IS NOT NULL
       AND o.status IN ('confirmed', 'packed', 'in_transit', 'dispatched', 'delivered')
       ${orderFilter}
     ORDER BY COALESCE(d.tracking_checked_at, TIMESTAMP '1970-01-01') ASC
     LIMIT $${params.length}`,
    params
  )).rows as DeliveryRecord[]

  if (options.orderId && deliveries.length === 0) {
    throw Object.assign(new Error('This order is not an active Speedaf COD delivery with a tracking number.'), { statusCode: 400 })
  }
  if (!deliveries.length) return { checked: 0, movedToPendingPayment: 0, errors: 0 }

  const trackingNumbers = deliveries.map(item => String(item.courier_tracking_number).trim())
  const providerResults = await (options.provider || fetchProviderTracking)(trackingNumbers)
  let movedToPendingPayment = 0
  let errors = 0
  for (const delivery of deliveries) {
    const trackingNumber = String(delivery.courier_tracking_number).trim()
    const result = providerResults.find(item => String(item.tracking_number || '').trim() === trackingNumber) || {
      tracking_number: trackingNumber,
      error: 'No tracking result returned'
    }
    const recorded = await recordResult(delivery, result, options)
    if (recorded.transitioned) movedToPendingPayment += 1
    if (recorded.error) errors += 1
  }
  return { checked: deliveries.length, movedToPendingPayment, errors }
}

let schedulerRunning = false

export function startSpeedafTrackingScheduler() {
  if (String(process.env.SPEEDAF_TRACKING_SYNC_ENABLED || '').toLowerCase() !== 'true') return
  if (!String(process.env.PARCELS_API_KEY || '').trim()) {
    console.warn('Speedaf tracking schedule is enabled but PARCELS_API_KEY is missing')
    return
  }
  const intervalMinutes = Math.max(5, Number(process.env.SPEEDAF_TRACKING_SYNC_INTERVAL_MINUTES || 30))
  const run = async () => {
    if (schedulerRunning) return
    schedulerRunning = true
    try {
      const result = await syncSpeedafTracking({ source: 'scheduled' })
      if (result.checked) console.log('Speedaf tracking sync completed', result)
    } catch (error) {
      console.error('Speedaf tracking sync failed', error)
    } finally {
      schedulerRunning = false
    }
  }
  const initial = setTimeout(run, 15_000)
  const recurring = setInterval(run, intervalMinutes * 60_000)
  initial.unref()
  recurring.unref()
}
