import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config()

const { Pool } = pg
const batch = process.env.DLIGHT_DUMMY_BATCH || process.argv[2]

if (!batch) {
  console.error('DLIGHT_DUMMY_BATCH is required. Example: $env:DLIGHT_DUMMY_BATCH="DUMMY-20260717103000"; npm run cleanup:dummy')
  process.exit(1)
}

const marker = `[DUMMY_BATCH:${batch}]`

function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Set it in .env or in your shell before running this script.')
  }

  const databaseUrl = new URL(process.env.DATABASE_URL)
  const sslMode = databaseUrl.searchParams.get('sslmode') || process.env.PGSSLMODE
  const databaseSsl = process.env.DATABASE_SSL
  const useSsl =
    databaseSsl === 'true' ||
    (process.env.NODE_ENV === 'production' &&
      databaseSsl !== 'false' &&
      sslMode !== 'disable' &&
      databaseUrl.hostname !== 'db')

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  })
}

async function deleteRows(client, label, sql, params = []) {
  const result = await client.query(sql, params)
  return { label, count: result.rowCount }
}

async function main() {
  const pool = createPool()
  const client = await pool.connect()
  const deleted = []

  try {
    await client.query('BEGIN')

    const orders = (
      await client.query(
        `
          SELECT id, order_number
          FROM orders
          WHERE notes LIKE $1
          ORDER BY created_at
        `,
        [`%${marker}%`]
      )
    ).rows
    const orderIds = orders.map((order) => order.id)

    if (orderIds.length) {
      const inventoryToRestore = (
        await client.query(
          `
            SELECT product_id, SUM(internal_quantity)::int AS quantity
            FROM order_items
            WHERE order_id = ANY($1::uuid[]) AND internal_quantity > 0
            GROUP BY product_id
          `,
          [orderIds]
        )
      ).rows

      for (const row of inventoryToRestore) {
        await client.query(
          `
            UPDATE inventory
            SET quantity = quantity + $1, last_updated = NOW()
            WHERE product_id = $2
          `,
          [row.quantity, row.product_id]
        )
      }

      const supplierBalances = (
        await client.query(
          `
            SELECT supplier_id, SUM(amount - paid_amount) AS amount
            FROM supplier_payables
            WHERE (description LIKE $1 OR order_id = ANY($2::uuid[]))
              AND status <> 'cancelled'
            GROUP BY supplier_id
          `,
          [`%${marker}%`, orderIds]
        )
      ).rows

      for (const row of supplierBalances) {
        await client.query(
          `
            UPDATE suppliers
            SET balance = GREATEST(0, balance - $1), updated_at = NOW()
            WHERE id = $2
          `,
          [row.amount, row.supplier_id]
        )
      }

      const riderBalances = (
        await client.query(
          `
            SELECT rider_id, SUM(amount) AS amount
            FROM rider_earnings
            WHERE order_id = ANY($1::uuid[]) AND status <> 'reversed'
            GROUP BY rider_id
          `,
          [orderIds]
        )
      ).rows

      for (const row of riderBalances) {
        await client.query(
          `
            UPDATE riders
            SET balance = GREATEST(0, balance - $1), updated_at = NOW()
            WHERE id = $2
          `,
          [row.amount, row.rider_id]
        )
      }

      const customerBalances = (
        await client.query(
          `
            SELECT customer_id, SUM(amount) AS amount
            FROM customer_credits
            WHERE order_id = ANY($1::uuid[]) AND type = 'sale'
            GROUP BY customer_id
          `,
          [orderIds]
        )
      ).rows

      for (const row of customerBalances) {
        await client.query(
          `
            UPDATE customers
            SET balance = GREATEST(0, balance - $1), updated_at = NOW()
            WHERE id = $2
          `,
          [row.amount, row.customer_id]
        )
      }

      deleted.push(
        await deleteRows(
          client,
          'cod_remittances',
          `DELETE FROM cod_remittances WHERE order_id = ANY($1::uuid[])`,
          [orderIds]
        )
      )
      deleted.push(
        await deleteRows(
          client,
          'cod_collections',
          `DELETE FROM cod_collections WHERE order_id = ANY($1::uuid[]) OR notes LIKE $2`,
          [orderIds, `%${marker}%`]
        )
      )
      deleted.push(
        await deleteRows(
          client,
          'order_refunds',
          `DELETE FROM order_refunds WHERE order_id = ANY($1::uuid[]) OR reason LIKE $2`,
          [orderIds, `%${marker}%`]
        )
      )
      deleted.push(
        await deleteRows(
          client,
          'supplier_payments',
          `
            DELETE FROM supplier_payments
            WHERE notes LIKE $1
               OR payable_id IN (
                 SELECT id FROM supplier_payables
                 WHERE description LIKE $1 OR order_id = ANY($2::uuid[])
               )
          `,
          [`%${marker}%`, orderIds]
        )
      )
      deleted.push(
        await deleteRows(
          client,
          'supplier_returns',
          `
            DELETE FROM supplier_returns
            WHERE reason LIKE $1
               OR payable_id IN (
                 SELECT id FROM supplier_payables
                 WHERE description LIKE $1 OR order_id = ANY($2::uuid[])
               )
          `,
          [`%${marker}%`, orderIds]
        )
      )
      deleted.push(
        await deleteRows(
          client,
          'rider_earnings',
          `DELETE FROM rider_earnings WHERE order_id = ANY($1::uuid[]) OR notes LIKE $2`,
          [orderIds, `%${marker}%`]
        )
      )
      deleted.push(
        await deleteRows(
          client,
          'customer_credits',
          `DELETE FROM customer_credits WHERE order_id = ANY($1::uuid[])`,
          [orderIds]
        )
      )
      deleted.push(
        await deleteRows(
          client,
          'supplier_payables',
          `DELETE FROM supplier_payables WHERE order_id = ANY($1::uuid[]) OR description LIKE $2`,
          [orderIds, `%${marker}%`]
        )
      )
      deleted.push(
        await deleteRows(
          client,
          'deliveries',
          `DELETE FROM deliveries WHERE order_id = ANY($1::uuid[]) OR notes LIKE $2`,
          [orderIds, `%${marker}%`]
        )
      )
      deleted.push(
        await deleteRows(
          client,
          'order_payments',
          `DELETE FROM order_payments WHERE order_id = ANY($1::uuid[]) OR reference LIKE $2`,
          [orderIds, `%${marker}%`]
        )
      )
      deleted.push(
        await deleteRows(
          client,
          'inventory_movements',
          `DELETE FROM inventory_movements WHERE reference_id = ANY($1::uuid[]) OR notes LIKE $2`,
          [orderIds, `%${marker}%`]
        )
      )
      deleted.push(
        await deleteRows(client, 'orders', `DELETE FROM orders WHERE id = ANY($1::uuid[])`, [orderIds])
      )
    }

    deleted.push(
      await deleteRows(
        client,
        'expenses',
        `DELETE FROM expenses WHERE reference_notes LIKE $1 OR description LIKE 'DUMMY %Simulation'`,
        [`%${marker}%`]
      )
    )
    deleted.push(
      await deleteRows(client, 'customers', `DELETE FROM customers WHERE notes LIKE $1`, [`%${marker}%`])
    )
    deleted.push(
      await deleteRows(
        client,
        'audit_logs',
        `
          DELETE FROM audit_logs
          WHERE metadata ->> 'dummy_batch' = $1
             OR new_values::text LIKE $2
             OR old_values::text LIKE $2
        `,
        [batch, `%${marker}%`]
      )
    )

    await client.query('COMMIT')

    console.log(`Dummy cleanup completed for batch: ${batch}`)
    console.log(`Orders removed: ${orders.map((order) => order.order_number).join(', ') || 'none'}`)
    console.table(deleted)
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Dummy cleanup failed:', error.message)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

main()
