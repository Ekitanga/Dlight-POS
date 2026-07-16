import { transaction } from './db/index.js'
import bcrypt from 'bcryptjs'

async function seed() {
  const adminPassword = process.env.SEED_ADMIN_PASSWORD
  if (!adminPassword || adminPassword.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be set to at least 12 characters')
  }
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@dlight.com'
  const adminName = process.env.SEED_ADMIN_NAME || 'Admin'
  const passwordHash = await bcrypt.hash(adminPassword, 12)
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($2, $1, $3, 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [passwordHash, adminEmail, adminName]
    )

    await client.query(`
      INSERT INTO permissions (name, description, module, action) VALUES
        ('view_orders', 'View all orders', 'orders', 'view'),
        ('create_orders', 'Create new orders', 'orders', 'create'),
        ('edit_orders', 'Edit existing orders', 'orders', 'edit'),
        ('cancel_orders', 'Cancel orders', 'orders', 'cancel'),
        ('view_products', 'View all products', 'products', 'view'),
        ('create_products', 'Create new products', 'products', 'create'),
        ('edit_products', 'Edit existing products', 'products', 'edit'),
        ('delete_products', 'Delete products', 'products', 'delete'),
        ('adjust_inventory', 'Adjust inventory levels', 'inventory', 'adjust'),
        ('view_reports', 'View business reports', 'reports', 'view'),
        ('export_reports', 'Export reports', 'reports', 'export')
      ON CONFLICT (name) DO NOTHING
    `)

    await client.query(`
      INSERT INTO categories (name)
      SELECT seed.name FROM (VALUES
        ('Perfumes'), ('Watches'), ('Wallets'), ('Gifts'), ('Accessories')
      ) AS seed(name)
      WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE LOWER(c.name) = LOWER(seed.name))
    `)

    await client.query(`
      INSERT INTO couriers (name)
      SELECT seed.name FROM (VALUES ('Speedaf'), ('Fargo'), ('G4S')) AS seed(name)
      WHERE NOT EXISTS (SELECT 1 FROM couriers c WHERE LOWER(c.name) = LOWER(seed.name))
    `)

    await client.query(`
      INSERT INTO settings (company_name, currency, tax_rate)
      SELECT 'Dlight POS', 'KES', 0
      WHERE NOT EXISTS (SELECT 1 FROM settings)
    `)

    console.log('Seed complete')
  })
}

seed().catch(console.error)
