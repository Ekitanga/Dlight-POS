# Railway Deployment Guide

This project can run as one Railway web service plus one Railway PostgreSQL database.

## 1. Create Services

1. Push this repository to GitHub.
2. In Railway, create a new project from the GitHub repository.
3. Add a PostgreSQL database to the same Railway project.
4. Deploy the web service from the repository root. Railway should use the included `Dockerfile`.

## 2. Web Service Variables

Set these on the web service:

```text
NODE_ENV=production
PORT=4000
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=<generate a long random secret>
JWT_REFRESH_SECRET=<generate a different long random secret>
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
FRONTEND_URL=<your Railway public app URL>
```

Generate secrets locally:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 3. Database Setup

After PostgreSQL is available, apply migrations once from your local machine or Railway shell:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\schema.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\order_first_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\settings_receipt_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\status_values_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\production_stabilization_phase0.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\production_stabilization_phase1.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\production_stabilization_phase1b.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\permissions_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\production_stabilization_permissions.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\appearance_settings_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\business_dates_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\expense_categories_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\expense_workflow_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\expense_effective_dates_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\mpesa_account_settings_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\order_destination_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\order_edit_permission_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\customer_fallback_name_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\cod_delivery_fee_split.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\speedaf_delivery_fee_migration.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database\audit_metadata_migration.sql
```

For a brand-new database, `database/schema.sql` may already include many later structures. If a migration says a column already exists, stop and check the schema before rerunning.

## 4. Health Check

Open:

```text
https://<your-app>.up.railway.app/health
```

Expected response:

```json
{"status":"ok","timestamp":"..."}
```

## 5. Backup Note

The Docker image installs `postgresql-client`, so the Settings backup feature can run `pg_dump` and `pg_restore`.
