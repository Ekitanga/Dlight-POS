# Dlight Giftshop ERP/POS Production Handover

This runbook is the operating reference for deployment, daily use, backup, reconciliation, rollback, and recovery.

## 1. Deployment Checklist

### Server prerequisites

- Windows Server or Linux host with restricted administrator access.
- Node.js `20.19` or newer and npm.
- PostgreSQL 14 or newer.
- `psql`, `pg_dump`, and `pg_restore` available on `PATH`.
- HTTPS certificate and a reverse proxy such as IIS, Nginx, or Apache.
- A process supervisor such as PM2, NSSM, systemd, or a managed container service.
- A dedicated PostgreSQL role and database. Do not run the application as the PostgreSQL superuser.
- Daily off-machine backup storage.

### Application deployment

1. Copy the reviewed release to the server.
2. Run `npm ci`.
3. Create `.env` from `.env.example` and set production secrets.
4. Back up the database before applying migrations.
5. Apply the database instructions in section 5.
6. Run:

   ```powershell
   npm run lint
   npm run typecheck
   npm run build
   npm test
   ```

7. Serve `packages/frontend/dist` as static files.
8. Run `packages/backend/dist/index.js` under a process supervisor.
9. Proxy `/api` to the backend port, normally `4000`.
10. Allow browser access only through HTTPS.
11. Restrict PostgreSQL to the application host and authorized administrators.
12. Run `npm run test:uat` against the deployed URL in a staging environment.
13. Run `scripts\pre-open-check.ps1`.

Never expose the Vite development server to the public internet.

## 2. Backup and Restore

### Daily backup

The pre-opening script creates a timestamped PostgreSQL custom-format backup:

```powershell
.\scripts\pre-open-check.ps1 -Email "owner@example.com"
```

Manual equivalent:

```powershell
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
pg_dump $env:DATABASE_URL --format=custom --file="database\backups\dlight_pos_$stamp.dump"
pg_restore --list "database\backups\dlight_pos_$stamp.dump"
```

Rules:

- Create a backup before every migration or release.
- Retain at least 30 daily backups and 12 month-end backups.
- Copy backups off the application server daily.
- Test a restore into a separate database at least monthly.
- A backup is not accepted until `pg_restore --list` reads it successfully.

### Restore drill

Do not overwrite the live database during a drill.

```powershell
createdb dlight_pos_restore_test
pg_restore --no-owner --no-privileges --exit-on-error `
  --dbname=dlight_pos_restore_test `
  "database\backups\dlight_pos_YYYYMMDD_HHMMSS.dump"
psql -d dlight_pos_restore_test -c "SELECT COUNT(*) FROM orders;"
```

After verification:

```powershell
dropdb dlight_pos_restore_test
```

### Emergency live restore

1. Stop frontend traffic and the backend service.
2. Save the current logs.
3. Back up the damaged database if it is still readable.
4. Create a new empty recovery database.
5. Restore the selected verified backup into the new database.
6. Point `DATABASE_URL` to the recovered database.
7. Start the backend and run the pre-opening check.
8. Reopen access only after orders, balances, receipts, and dashboard checks pass.

Prefer switching to a newly restored database over using `--clean` against the live database.

## 3. Admin Credential Reset

There is no supported production default password.

### Normal reset

1. Sign in as an owner or administrator.
2. Open **Users**.
3. Edit the administrator.
4. Enter a new unique password and save.
5. Sign out and verify the new password in a private browser window.

Use at least 14 characters and store the password in the business password manager.

### Emergency command-line reset

Run from the project directory:

```powershell
$env:DLIGHT_ADMIN_EMAIL = "owner@example.com"
$secure = Read-Host "New password" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:DLIGHT_NEW_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  node .\scripts\reset-admin-password.mjs
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  Remove-Item Env:DLIGHT_NEW_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:DLIGHT_ADMIN_EMAIL -ErrorAction SilentlyContinue
}
```

The utility only resets an active `admin` or `owner` account and requires a password of at least 14 characters.

## 4. Environment Variable Checklist

Required:

| Variable | Production requirement |
|---|---|
| `DATABASE_URL` | Dedicated restricted PostgreSQL account; TLS where supported |
| `JWT_SECRET` | Random secret, at least 32 bytes |
| `JWT_REFRESH_SECRET` | Different random secret, at least 32 bytes |
| `JWT_EXPIRES_IN` | Recommended `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Recommended `7d` |
| `PORT` | Backend port, normally `4000` |
| `NODE_ENV` | Must be `production` |
| `FRONTEND_URL` | Exact HTTPS frontend origin |

Generate secrets:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Checklist:

- No secret contains `your-secret`, `password`, or a copied example value.
- `.env` is excluded from source control and readable only by the service account.
- Frontend and backend clocks use automatic time synchronization.
- `FRONTEND_URL` exactly matches the browser origin, including scheme and port.
- Database credentials are rotated after staff or hosting changes.

## 5. Database Migration Instructions

### Fresh database

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\schema.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\permissions_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\production_stabilization_permissions.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\order_edit_permission_migration.sql
```

Then create the first owner with the controlled seed process or emergency reset utility. `SEED_ADMIN_PASSWORD` must be at least 12 characters if the seed is used.

### Existing pre-stabilization database

Back up first. Apply each file once, in this order:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\order_first_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\settings_receipt_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\appearance_settings_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\mpesa_account_settings_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\status_values_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\business_dates_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\expense_categories_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\expense_workflow_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\expense_effective_dates_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\customer_fallback_name_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\audit_metadata_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\production_stabilization_phase0.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\production_stabilization_phase1.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\production_stabilization_phase1b.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\permissions_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\production_stabilization_permissions.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\order_edit_permission_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\cod_delivery_fee_split.sql
```

Do not rerun `production_stabilization_phase1.sql` after it succeeds; constraint creation is intentionally one-time.

After migration:

```powershell
npm test
.\scripts\pre-open-check.ps1 -Email "owner@example.com" -SkipBackup
```

## 6. Shop Attendant Daily Guide

### Opening

1. Confirm the owner has run the pre-opening check.
2. Sign in with your own account. Never share accounts.
3. Confirm Dashboard, Orders, Products, Deliveries, Inventory, and Receipts load.

### Create a sale

1. Open **Orders** and select **New Order**.
2. Enter customer name, phone, location, and useful notes.
3. Add each product, quantity, and selling price.
4. Select **Shop Stock** only when the item is physically available.
5. For **Supplier Fulfilled**, select the supplier and enter supplier cost.
6. Choose Walk-In, Rider, or Courier.
7. For Rider, enter both the customer delivery charge and actual rider fee.
8. For Courier, select the courier, tracking number, actual fee, and Prepaid or COD.
9. Select Cash, M-Pesa, Bank, Credit, or Pay On Delivery.
10. Review the order and select **Save Order** once.

### Complete and follow up

- Walk-in: mark the order completed when goods and payment are handed over.
- Rider: dispatch, then mark delivered after confirmation.
- Courier prepaid: dispatch, then mark delivered.
- Speedaf COD: dispatch, mark client collected, then record the Speedaf remittance when received.
- Credit: record customer payment from **Customers** when money is received.
- Print or reprint from **Receipts**.
- Use notes for exceptions; never create a second order to correct a status mistake.
- Ask an owner before cancelling, returning, changing stock, or changing prices.

## 7. Owner/Admin Evening Reconciliation

1. Confirm all delivered orders have the correct final status.
2. Review pending and in-transit orders.
3. Review **Deliveries** and outstanding Speedaf COD.
4. Record every COD remittance with its unique M-Pesa or bank reference.
5. Record customer credit payments.
6. Review supplier and rider balances; record actual payments only once.
7. Enter and approve valid expenses.
8. Open **Reports > Daily Reconciliation**.
9. Count physical cash and obtain the M-Pesa closing balance.
10. Enter Actual Cash and Actual M-Pesa.
11. Investigate every non-zero variance before closing.
12. Review Sales, Profit, Supplier Payables, Rider Earnings, Customer Credit, and COD Ageing.
13. Close reconciliation only after evidence agrees.
14. Confirm the Audit Log contains the day’s critical actions.
15. Create or confirm the end-of-day off-machine backup.

## 8. Known Limitations

- Migrations are SQL files without an automated migration-history table. Record applied filenames and dates externally.
- The repository does not include a packaged Windows service, PM2 configuration, or reverse-proxy configuration.
- Browser printing depends on the workstation printer driver and browser print dialog.
- The mobile acceptance test uses an emulated `390x844` Chrome viewport, not every physical phone model.
- The UAT creates clearly prefixed `UAT` records in the selected database.
- Vite has development-only advisories. Production dependencies have zero known audit findings; never expose the Vite development server publicly.
- Off-machine backup transfer and retention require an external scheduled task or managed backup service.

## 9. Go-Live Checklist

- [ ] Production database backup created and validated.
- [ ] Restore drill completed successfully.
- [ ] Admin cleanup preview reviewed and the correct cleanup mode selected.
- [ ] Test transactions cleared, or full business reset completed, before live sales begin.
- [ ] Production `.env` uses unique secrets and restricted database credentials.
- [ ] Default/example administrator password removed.
- [ ] Owner and attendant accounts tested separately.
- [ ] Attendant permissions reviewed.
- [ ] Products, opening stock, suppliers, riders, and Speedaf configured.
- [ ] Company logo, contacts, M-Pesa details, receipt footer, and printer configured.
- [ ] HTTPS and process supervisor enabled.
- [ ] Firewall exposes only required web ports.
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` pass.
- [ ] Frontend UAT passes in staging.
- [ ] Pre-opening verification passes against production.
- [ ] Test receipt printed on the actual shop printer.
- [ ] Staff complete one supervised walk-in, rider, supplier, COD, and credit workflow.
- [ ] Backup owner and incident contact are assigned.

## 10. Rollback Plan

### Application-only rollback

Use when a release fails but the database schema is unchanged:

1. Stop incoming traffic.
2. Stop the backend service.
3. Restore the previous application release directory.
4. Keep the current database.
5. Start the backend and frontend.
6. Run the pre-opening check and a supervised browser smoke test.

### Application and database rollback

Use when a migration changed data or schema:

1. Stop incoming traffic and all application processes.
2. Preserve logs and back up the current failed database.
3. Restore the last verified pre-migration backup into a new database.
4. Deploy the application version matching that backup.
5. update `DATABASE_URL` to the restored database.
6. Start services.
7. Run backend tests against a copy, then the pre-opening check.
8. Verify recent business records against paper/M-Pesa evidence.
9. Re-enter transactions that occurred after the restored backup.
10. Reopen only after owner approval.

Never attempt to reverse financial migrations manually while attendants continue entering orders.

## 11. Admin Data Cleanup Before Go-Live

Use **Settings > Admin Data Cleanup** only after a verified backup exists.

Recommended mode for most go-lives:

- **Clean Test Transactions** clears test orders, deliveries, payments, supplier/rider ledgers, COD, expenses, reconciliations, refunds, inventory movements, and old audit rows.
- It keeps users, roles, permissions, settings, products, categories, suppliers, riders, couriers, and inventory records.
- Internal stock used by test orders is restored before orders are deleted.
- Customer, supplier, and rider balances are reset to zero.

Use **Full Business Reset** only when starting the business database from scratch. It clears products, customers, suppliers, riders, couriers, inventory, and all transaction records while keeping users, roles, permissions, and settings.

Before running cleanup:

1. Create and validate a PostgreSQL backup.
2. Open **Settings > Admin Data Cleanup** as owner/admin.
3. Select the cleanup mode.
4. Review the preview counts.
5. Type the confirmation phrase exactly.
6. Run cleanup.
7. Confirm the cleanup audit record exists.
8. Refresh Dashboard, Products, Inventory, Orders, Suppliers, Riders, and Receipts.
