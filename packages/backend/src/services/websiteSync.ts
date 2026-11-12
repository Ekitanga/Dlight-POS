import crypto from 'node:crypto'
import { query, transaction } from '../db/index.js'
import { emitNotification } from '../utils/notifications.js'
import { logAudit } from '../utils/audit.js'

/*
 * Imports NEW products from the Dlight website (WooCommerce Store API).
 *
 * Owner rules (2026-11-12):
 *  - Never change existing POS products (no price/name/cost/stock edits, no removals).
 *  - Clearly new products are added: supplier-fulfilled, stock 0, cost 0, website price.
 *  - Colour versions of a watch model the POS holds as one product are skipped.
 *  - Anything uncertain goes to a review list for an owner/admin.
 */

type Executor = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> }

export interface WebsiteProduct {
  id: number
  name: string
  price: number | null
  categories: string[]
  permalink: string | null
}

interface PosProduct {
  id: string
  name: string
  category: string | null
  archived: boolean
}

export type Decision =
  | { status: 'existing'; reason: string; matchedProductId: string }
  | { status: 'skipped_variant'; reason: string; matchedProductId: string }
  | { status: 'review'; reason: string; matchedProductId: string | null }
  | { status: 'add'; reason: string; category: 'Watches' | 'Perfumes' }

const MAX_PAGES = 50
const WATCH_BRANDS = ['casio', 'curren', 'naviforce', 'fossil', 'seiko', 'skmei', 'poedagar', 'hannah martin', 'megir', 'minifocus']
const COLOURS = new Set([
  'black', 'white', 'silver', 'gold', 'golden', 'rose', 'blue', 'green', 'red', 'brown', 'grey', 'gray',
  'pink', 'purple', 'yellow', 'orange', 'navy', 'tan', 'beige', 'bronze', 'champagne', 'army', 'dark',
  'light', 'olive', 'coffee', 'camouflage', 'camo', 'cream', 'ivory', 'teal', 'maroon', 'burgundy',
  'turquoise', 'khaki', 'copper', 'gunmetal', 'twotone'
])
const EDITIONS = new Set([
  'intense', 'elixir', 'extrait', 'absolu', 'absolue', 'privee', 'reserve', 'extreme', 'sport', 'noir', 'oud'
])
const STOP = new Set([
  'perfume', 'perfumes', 'eau', 'de', 'du', 'parfum', 'toilette', 'edp', 'edt', 'for', 'men', 'mens', 'women',
  'womens', 'man', 'woman', 'unisex', 'fragrance', 'cologne', 'the', 'and', 'with', 'a', 'of', 'in', 'watch',
  'watches', 'ladies', 'gents', 'gent', 'ml', '100ml', 'spray', 'tester', 'original', 'by', 'intense'
])

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', eacute: 'é', egrave: 'è', ocirc: 'ô', iuml: 'ï'
}

export function decodeHtml(text: string): string {
  let value = String(text || '')
  for (let pass = 0; pass < 2; pass += 1) {
    value = value
      .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
  }
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

function clean(text: string): string {
  return decodeHtml(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’ʼ'`]/g, '')
}

function tokens(text: string): string[] {
  return clean(text).match(/[a-z0-9]+/g) || []
}

export function nameKey(text: string): string {
  return tokens(text).join('')
}

function modelCodes(text: string): Set<string> {
  const codes = new Set<string>()
  for (const raw of clean(text).match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || []) {
    const code = raw.replace(/-/g, '')
    if (!/\d/.test(code)) continue
    if (/^\d+(ml|mm|atm|m|g)?$/.test(code) && code.length < 4) continue
    if (/^\d+(ml|mm|atm)$/.test(code)) continue
    codes.add(code)
  }
  return codes
}

function colours(text: string): Set<string> {
  return new Set(tokens(text).filter(token => COLOURS.has(token)))
}

function bigramSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const counts = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2)
    counts.set(gram, (counts.get(gram) || 0) + 1)
  }
  let overlap = 0
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2)
    const count = counts.get(gram) || 0
    if (count > 0) {
      overlap += 1
      counts.set(gram, count - 1)
    }
  }
  return (2 * overlap) / (a.length + b.length - 2)
}

function intersects<T>(a: Set<T>, b: Set<T>) {
  for (const item of a) if (b.has(item)) return true
  return false
}

function setsEqual<T>(a: Set<T>, b: Set<T>) {
  return a.size === b.size && [...a].every(item => b.has(item))
}

export function websiteCategory(product: WebsiteProduct): 'Watches' | 'Perfumes' | null {
  const cats = product.categories.join(' ').toLowerCase()
  const name = clean(product.name)
  if (cats.includes('watch') || name.includes('watch') || WATCH_BRANDS.some(brand => cats.includes(brand))) return 'Watches'
  if (cats.includes('perfum') || name.includes('perfum') || name.includes('parfum') || name.includes('toilette') || /\bedp\b/.test(name)) return 'Perfumes'
  return null
}

function posCategory(product: PosProduct): 'Watches' | 'Perfumes' | null {
  if (product.category === 'Watches' || product.category === 'Perfumes') return product.category
  const name = clean(product.name)
  if (name.includes('watch')) return 'Watches'
  if (name.includes('perfum') || name.includes('parfum')) return 'Perfumes'
  return null
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface PreparedPos extends PosProduct {
  key: string
  cls: 'Watches' | 'Perfumes' | null
  tokens: Set<string>
  core: Set<string>
  codes: Set<string>
  colours: Set<string>
}

export function preparePosProducts(products: PosProduct[]): PreparedPos[] {
  return products.map(product => {
    const tokenSet = new Set(tokens(product.name))
    return {
      ...product,
      key: nameKey(product.name),
      cls: posCategory(product),
      tokens: tokenSet,
      core: new Set([...tokenSet].filter(token => !STOP.has(token))),
      codes: modelCodes(product.name),
      colours: colours(product.name)
    }
  })
}

export function classifyWebsiteProduct(site: WebsiteProduct, posProducts: PreparedPos[]): Decision {
  const cls = websiteCategory(site)
  const key = nameKey(site.name)
  const exact = posProducts.filter(product => product.key === key)
  if (exact.length) {
    const target = exact.find(product => !product.archived) || exact[0]
    return { status: 'existing', reason: target.archived ? 'Same name as an archived POS product' : 'Same name as a POS product', matchedProductId: target.id }
  }
  if (!cls) return { status: 'review', reason: 'Not clearly a watch or a perfume', matchedProductId: null }
  if (!site.price || site.price <= 0) return { status: 'review', reason: 'Website product has no price', matchedProductId: null }

  const siteTokens = new Set(tokens(site.name))
  const siteCore = new Set([...siteTokens].filter(token => !STOP.has(token)))
  const siteCodes = modelCodes(site.name)
  const siteColours = colours(site.name)

  // A model number that is a prefix of a POS model number (e.g. Casio 1B vs 1BUDF) is
  // normally the same watch sold under a regional code - never auto-add those.
  for (const product of posProducts) {
    for (const code of siteCodes) {
      if (code.length < 5) continue
      for (const other of product.codes) {
        if (other !== code && Math.min(other.length, code.length) >= 5 && (other.startsWith(code) || code.startsWith(other))) {
          return { status: 'review', reason: `Model number is very close to "${product.name}"`, matchedProductId: product.id }
        }
      }
    }
  }

  let best: PreparedPos | null = null
  let bestValue = 0
  let bestJaccard = 0
  let bestSimilarity = 0
  for (const product of posProducts) {
    if (product.cls && product.cls !== cls) continue
    if (siteCodes.size && product.codes.size && !intersects(siteCodes, product.codes)) continue
    const union = new Set([...siteCore, ...product.core])
    const shared = [...siteCore].filter(token => product.core.has(token)).length
    const jaccard = shared / Math.max(1, union.size)
    const similarity = bigramSimilarity(key, product.key)
    const value = Math.max(jaccard, similarity * 0.95) + (intersects(siteCodes, product.codes) ? 0.15 : 0)
    if (value > bestValue) {
      best = product
      bestValue = value
      bestJaccard = jaccard
      bestSimilarity = similarity
    }
  }

  if (best && siteCodes.size && intersects(siteCodes, best.codes)) {
    if (cls === 'Watches' && best.colours.size === 0) {
      return { status: 'skipped_variant', reason: `Colour version of "${best.name}", which the POS holds as one product`, matchedProductId: best.id }
    }
    const colourDifference = [...siteColours].some(c => !best!.colours.has(c)) || [...best.colours].some(c => !siteColours.has(c))
    if (setsEqual(siteCodes, best.codes) && !colourDifference && bestJaccard >= 0.5) {
      return { status: 'existing', reason: `Same model as "${best.name}"`, matchedProductId: best.id }
    }
    return { status: 'review', reason: `Same model number as "${best.name}" but described differently - new colour or same watch?`, matchedProductId: best.id }
  }

  if (best && bestJaccard >= 0.85 && bestSimilarity >= 0.85) {
    // "Intense", "Elixir", "Extrait"... mark a different version of a perfume, not a rewording.
    const editionDifference = [...siteTokens, ...best.tokens].some(token => EDITIONS.has(token) && siteTokens.has(token) !== best!.tokens.has(token))
    if (editionDifference) {
      return { status: 'review', reason: `Looks like a different version of "${best.name}"`, matchedProductId: best.id }
    }
    return { status: 'existing', reason: `Near-identical to "${best.name}"`, matchedProductId: best.id }
  }
  if (best && (bestJaccard >= 0.6 || bestSimilarity >= 0.8)) {
    return { status: 'review', reason: `Similar to "${best.name}" - same product or a different one?`, matchedProductId: best.id }
  }
  return { status: 'add', reason: 'Not in the POS', category: cls }
}

// ---------------------------------------------------------------------------
// Website fetch
// ---------------------------------------------------------------------------

function parseStoreProduct(raw: any): WebsiteProduct | null {
  if (!raw || typeof raw.id !== 'number' || !raw.name) return null
  const prices = raw.prices || {}
  const minor = Number(prices.currency_minor_unit ?? 2)
  const price = prices.price !== undefined && prices.price !== '' ? Number(prices.price) / 10 ** minor : null
  return {
    id: raw.id,
    name: decodeHtml(raw.name).slice(0, 255),
    price: price !== null && Number.isFinite(price) ? Math.round(price * 100) / 100 : null,
    categories: Array.isArray(raw.categories) ? raw.categories.map((c: any) => decodeHtml(c?.name || '')) : [],
    permalink: typeof raw.permalink === 'string' ? raw.permalink : null
  }
}

export async function fetchWebsiteProducts(sourceUrl: string): Promise<WebsiteProduct[]> {
  const base = sourceUrl.replace(/\/+$/, '')
  const products: WebsiteProduct[] = []
  let totalPages = 1
  for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page += 1) {
    const response = await fetch(`${base}/wp-json/wc/store/v1/products?per_page=100&page=${page}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'DlightPOS-ProductSync/1.0' },
      signal: AbortSignal.timeout(60_000)
    })
    if (!response.ok) throw new Error(`Website returned HTTP ${response.status} for page ${page}`)
    totalPages = Number(response.headers.get('x-wp-totalpages') || 1)
    const body = await response.json()
    if (!Array.isArray(body)) throw new Error('Website returned an unexpected product list')
    for (const raw of body) {
      const parsed = parseStoreProduct(raw)
      if (parsed) products.push(parsed)
    }
  }
  return products
}

// ---------------------------------------------------------------------------
// Product creation (insert only)
// ---------------------------------------------------------------------------

function generatedSku(category: string, name: string) {
  const prefix = category.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'ITEM'
  const digest = crypto.createHash('sha1').update(name.trim().toLowerCase()).digest('hex').slice(0, 8).toUpperCase()
  return `${prefix}-${digest}`
}

/** Creates a POS product for a website item. Refuses if a product with the same name already exists. */
export async function createProductFromWebsite(client: Executor, item: { name: string; price: number; category: 'Watches' | 'Perfumes' }) {
  const clash = await client.query(
    `SELECT id FROM products WHERE regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = regexp_replace(lower($1), '[^a-z0-9]', '', 'g') LIMIT 1`,
    [item.name]
  )
  if (clash.rows[0]) return { created: false as const, productId: clash.rows[0].id as string }

  const category = await client.query('SELECT id FROM categories WHERE name = $1', [item.category])
  if (!category.rows[0]) throw new Error(`Category ${item.category} is missing`)

  const base = generatedSku(item.category, item.name)
  let sku = base
  for (let suffix = 2; ; suffix += 1) {
    const taken = await client.query('SELECT 1 FROM products WHERE sku = $1', [sku])
    if (!taken.rows[0]) break
    sku = `${base}-${suffix}`
  }

  const product = await client.query(
    `INSERT INTO products (name, sku, category_id, cost_price, selling_price, reorder_level, is_dropship, is_active)
     VALUES ($1, $2, $3, 0, $4, 0, TRUE, TRUE) RETURNING id`,
    [item.name, sku, category.rows[0].id, item.price]
  )
  await client.query('INSERT INTO inventory (product_id, quantity) VALUES ($1, 0)', [product.rows[0].id])
  return { created: true as const, productId: product.rows[0].id as string }
}

// ---------------------------------------------------------------------------
// Sync run
// ---------------------------------------------------------------------------

let running = false

export function isSyncRunning() {
  return running
}

export interface SyncSummary {
  runId: string
  fetched: number
  newSeen: number
  added: number
  existing: number
  skippedVariant: number
  review: number
  addedProducts: Array<{ id: string; name: string }>
}

export async function runWebsiteSync(trigger: 'scheduled' | 'manual', userId: string | null = null): Promise<SyncSummary> {
  if (running) throw Object.assign(new Error('A website check is already running'), { statusCode: 409 })
  running = true
  let runId = ''
  try {
    const run = await query(
      `INSERT INTO website_sync_runs (trigger, started_by) VALUES ($1, $2) RETURNING id`,
      [trigger, userId]
    )
    runId = run.rows[0].id as string
    const settings = (await query('SELECT source_url FROM website_sync_settings WHERE id = 1')).rows[0]
    const websiteProducts = await fetchWebsiteProducts(settings?.source_url || 'https://dlightgiftshop.com')

    const summary = await transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('website-product-sync'))")
      const known = await client.query('SELECT website_product_id FROM website_products')
      const knownIds = new Set(known.rows.map((row: any) => Number(row.website_product_id)))

      await client.query(
        'UPDATE website_products SET last_seen_at = NOW() WHERE website_product_id = ANY($1::bigint[])',
        [websiteProducts.filter(p => knownIds.has(p.id)).map(p => p.id)]
      )

      const fresh = websiteProducts.filter(product => !knownIds.has(product.id))
      const result: SyncSummary = { runId, fetched: websiteProducts.length, newSeen: fresh.length, added: 0, existing: 0, skippedVariant: 0, review: 0, addedProducts: [] }
      if (fresh.length === 0) return result

      const posRows = await client.query(
        `SELECT p.id, p.name, c.name AS category, p.deleted_at IS NOT NULL AS archived
         FROM products p LEFT JOIN categories c ON c.id = p.category_id`
      )
      let posProducts = preparePosProducts(posRows.rows)

      for (const site of fresh) {
        const decision = classifyWebsiteProduct(site, posProducts)
        let status: string = decision.status
        let productId: string | null = null
        let matchedProductId: string | null = 'matchedProductId' in decision ? decision.matchedProductId : null
        let reason = decision.reason

        if (decision.status === 'add') {
          const created = await createProductFromWebsite(client, { name: site.name, price: site.price!, category: decision.category })
          if (created.created) {
            status = 'imported'
            productId = created.productId
            result.added += 1
            result.addedProducts.push({ id: created.productId, name: site.name })
            // Later website products in this same run must see the new product.
            posProducts = posProducts.concat(preparePosProducts([{ id: created.productId, name: site.name, category: decision.category, archived: false }]))
          } else {
            status = 'existing'
            matchedProductId = created.productId
            reason = 'Same name as a POS product'
          }
        }
        if (status === 'existing') result.existing += 1
        if (status === 'skipped_variant') result.skippedVariant += 1
        if (status === 'review') result.review += 1

        await client.query(
          `INSERT INTO website_products (website_product_id, name, price, category, permalink, status, reason, product_id, matched_product_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (website_product_id) DO NOTHING`,
          [site.id, site.name, site.price, websiteCategory(site), site.permalink, status, reason, productId, matchedProductId]
        )
      }

      if (result.added > 0) {
        await logAudit({
          client,
          userId,
          action: 'products_imported_from_website',
          entityType: 'product',
          newValues: { product_ids: result.addedProducts.map(p => p.id), count: result.added },
          metadata: { source: settings?.source_url, trigger, run_id: runId }
        })
      }
      return result
    })

    await query(
      `UPDATE website_sync_runs SET status = 'success', finished_at = NOW(), fetched = $2, new_seen = $3, added = $4,
         existing = $5, skipped_variant = $6, review = $7 WHERE id = $1`,
      [runId, summary.fetched, summary.newSeen, summary.added, summary.existing, summary.skippedVariant, summary.review]
    )

    if (summary.added > 0 || summary.review > 0) {
      const parts = []
      if (summary.added > 0) parts.push(`${summary.added} new product${summary.added === 1 ? '' : 's'} added from the website`)
      if (summary.review > 0) parts.push(`${summary.review} need${summary.review === 1 ? 's' : ''} your review in Settings`)
      await emitNotification({ title: 'Website products updated', message: parts.join('; '), type: 'system', entityType: 'website_sync' }).catch(() => {})
    }
    return summary
  } catch (error) {
    if (runId) {
      await query(
        `UPDATE website_sync_runs SET status = 'failed', finished_at = NOW(), error = $2 WHERE id = $1`,
        [runId, String((error as Error)?.message || error).slice(0, 1000)]
      ).catch(() => {})
    }
    throw error
  } finally {
    running = false
  }
}

// ---------------------------------------------------------------------------
// Daily scheduler
// ---------------------------------------------------------------------------

function nairobiNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).map(part => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
}

/** Is a scheduled check due now? Once per Nairobi day after run_hour, up to 3 attempts if it fails. */
async function scheduledRunDue(): Promise<boolean> {
  const settings = (await query('SELECT enabled, run_hour FROM website_sync_settings WHERE id = 1')).rows[0]
  if (!settings?.enabled) return false
  const now = nairobiNow()
  if (now.hour < Number(settings.run_hour)) return false
  const today = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'success')::int AS successes,
            COUNT(*)::int AS attempts,
            MAX(started_at) AS last_attempt
     FROM website_sync_runs
     WHERE trigger = 'scheduled' AND (started_at AT TIME ZONE 'Africa/Nairobi')::date = $1::date`,
    [now.date]
  )
  const row = today.rows[0]
  if (row.successes > 0 || row.attempts >= 3) return false
  return !row.last_attempt || Date.now() - new Date(row.last_attempt).getTime() > 60 * 60_000
}

export function startWebsiteSyncScheduler() {
  if (String(process.env.WEBSITE_SYNC_DISABLED || '').toLowerCase() === 'true') return
  const tick = async () => {
    if (running) return
    try {
      if (!(await scheduledRunDue())) return
      const summary = await runWebsiteSync('scheduled')
      console.log('Website product sync completed', { fetched: summary.fetched, newSeen: summary.newSeen, added: summary.added, review: summary.review })
    } catch (error) {
      // A missing table (migration not applied yet) or website outage must not crash the app.
      console.error('Website product sync failed', (error as Error)?.message || error)
    }
  }
  const initial = setTimeout(tick, 60_000)
  const recurring = setInterval(tick, 10 * 60_000)
  initial.unref()
  recurring.unref()
}
