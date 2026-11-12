import { Router } from 'express'
import { query, transaction } from '../db/index.js'
import { logAudit } from '../utils/audit.js'
import { createProductFromWebsite, isSyncRunning, runWebsiteSync, websiteCategory } from '../services/websiteSync.js'

// Mounted behind authMiddleware + requireAdmin (owners and administrators only).
const router = Router()

function errorStatus(error: unknown) {
  return (error as any)?.statusCode || 500
}

router.get('/status', async (_req, res) => {
  try {
    const settings = (await query('SELECT enabled, source_url, run_hour, updated_at FROM website_sync_settings WHERE id = 1')).rows[0]
    const runs = await query(
      `SELECT r.id, r.trigger, r.started_at, r.finished_at, r.status, r.fetched, r.new_seen, r.added, r.existing,
              r.skipped_variant, r.review, r.error, u.full_name AS started_by_name
       FROM website_sync_runs r LEFT JOIN users u ON u.id = r.started_by
       ORDER BY r.started_at DESC LIMIT 10`
    )
    const counts = await query('SELECT status, COUNT(*)::int AS count FROM website_products GROUP BY status')
    const review = await query(
      `SELECT w.website_product_id, w.name, w.price, w.category, w.permalink, w.reason, w.first_seen_at,
              m.name AS matched_product_name, m.selling_price AS matched_product_price
       FROM website_products w LEFT JOIN products m ON m.id = w.matched_product_id
       WHERE w.status = 'review'
       ORDER BY w.first_seen_at DESC LIMIT 200`
    )
    const recentlyAdded = await query(
      `SELECT w.website_product_id, w.name, w.price, w.category, w.permalink, COALESCE(w.decided_at, w.first_seen_at) AS added_at
       FROM website_products w
       WHERE w.status = 'imported' AND w.first_seen_at > NOW() - INTERVAL '60 days'
       ORDER BY COALESCE(w.decided_at, w.first_seen_at) DESC LIMIT 50`
    )
    res.json({
      settings: settings || { enabled: false, source_url: 'https://dlightgiftshop.com', run_hour: 6 },
      running: isSyncRunning(),
      runs: runs.rows,
      counts: Object.fromEntries(counts.rows.map((row: any) => [row.status, row.count])),
      review: review.rows,
      recently_added: recentlyAdded.rows
    })
  } catch (error) {
    console.error('Website sync status error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/settings', async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: { message: 'Choose whether the website check is on or off' } })
  }
  try {
    const result = await query(
      `UPDATE website_sync_settings SET enabled = $1, updated_by = $2, updated_at = NOW() WHERE id = 1
       RETURNING enabled, source_url, run_hour, updated_at`,
      [req.body.enabled, req.user?.userId]
    )
    await logAudit({ req, action: 'website_sync_settings_updated', entityType: 'setting', newValues: { enabled: req.body.enabled } })
    res.json(result.rows[0])
  } catch (error) {
    console.error('Website sync settings error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/run', async (req, res) => {
  try {
    const summary = await runWebsiteSync('manual', req.user?.userId || null)
    res.json(summary)
  } catch (error) {
    const status = errorStatus(error)
    if (status === 500) console.error('Website sync run error:', error)
    res.status(status).json({ error: { message: status === 500 ? `Website check failed: ${(error as Error).message}` : (error as Error).message } })
  }
})

async function decide(req: any, res: any, action: 'add' | 'skip') {
  const websiteProductId = Number(req.params.id)
  if (!Number.isInteger(websiteProductId) || websiteProductId <= 0) {
    return res.status(404).json({ error: { message: 'Website product not found' } })
  }
  try {
    const result = await transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('website-product-sync'))")
      const item = (await client.query('SELECT * FROM website_products WHERE website_product_id = $1 FOR UPDATE', [websiteProductId])).rows[0]
      if (!item) throw Object.assign(new Error('Website product not found'), { statusCode: 404 })
      if (item.status !== 'review') throw Object.assign(new Error('This product has already been decided'), { statusCode: 409 })

      if (action === 'skip') {
        await client.query(
          `UPDATE website_products SET status = 'skipped', decided_by = $2, decided_at = NOW() WHERE website_product_id = $1`,
          [websiteProductId, req.user?.userId]
        )
        await logAudit({ req, client, action: 'website_product_skipped', entityType: 'website_product', newValues: { website_product_id: websiteProductId, name: item.name } })
        return { status: 'skipped' }
      }

      const category = item.category || websiteCategory({ id: websiteProductId, name: item.name, price: Number(item.price), categories: [], permalink: item.permalink })
      if (category !== 'Watches' && category !== 'Perfumes') {
        throw Object.assign(new Error('Only watches and perfumes can be added automatically. Add this one manually in Products.'), { statusCode: 400 })
      }
      if (!item.price || Number(item.price) <= 0) {
        throw Object.assign(new Error('This website product has no price. Add it manually in Products.'), { statusCode: 400 })
      }
      const created = await createProductFromWebsite(client, { name: item.name, price: Number(item.price), category })
      if (!created.created) {
        throw Object.assign(new Error('A product with this name already exists in the POS'), { statusCode: 409 })
      }
      await client.query(
        `UPDATE website_products SET status = 'imported', product_id = $2, decided_by = $3, decided_at = NOW() WHERE website_product_id = $1`,
        [websiteProductId, created.productId, req.user?.userId]
      )
      await logAudit({
        req,
        client,
        action: 'products_imported_from_website',
        entityType: 'product',
        entityId: created.productId,
        newValues: { product_ids: [created.productId], count: 1 },
        metadata: { website_product_id: websiteProductId, approved_from_review: true }
      })
      return { status: 'imported', product_id: created.productId }
    })
    res.json(result)
  } catch (error) {
    const status = errorStatus(error)
    if (status === 500) console.error('Website product decision error:', error)
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
}

router.post('/items/:id/add', (req, res) => decide(req, res, 'add'))
router.post('/items/:id/skip', (req, res) => decide(req, res, 'skip'))

export { router as websiteSyncRoutes }
