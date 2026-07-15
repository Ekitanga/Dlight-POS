# Dlight POS

Enterprise-grade Retail ERP, POS, Dropshipping & Business Management System for Kenya.

## Production Operations

Use [docs/PRODUCTION_HANDOVER.md](docs/PRODUCTION_HANDOVER.md) for deployment, migrations,
backups, credential reset, daily operation, reconciliation, go-live, and rollback.

Run the pre-opening check each business day:

```powershell
.\scripts\pre-open-check.ps1 -Email "owner@example.com"
```

## Tech Stack

### Frontend
- React 18 + TypeScript
- Tailwind CSS
- React Query
- Zustand

### Backend
- Node.js + Express.js
- PostgreSQL
- JWT Authentication

## Setup

1. Install dependencies:
```bash
npm run install
```

2. Set up environment variables:
```bash
cp .env.example .env
```

3. Run database migrations:
```bash
psql -d dlight_pos -f database/schema.sql
```

4. Start development servers:
```bash
npm run dev
```

## Project Structure

```
packages/
├── backend/     # Express.js API
│   └── src/
│       ├── routes/      # API endpoints
│       ├── middleware/  # Auth, logging, audit
│       └── db/          # Database connection
└── frontend/    # React application
    └── src/
        ├── pages/       # Route pages
        ├── components/  # Reusable components
        └── stores/      # Zustand stores
```

## Features

- Complete POS with barcode scanning
- Order management with status tracking
- Supplier fulfillment & dropshipping support
- Rider & courier delivery tracking
- Customer credit management
- Expense tracking with approval workflow
- Daily reconciliation
- Audit trail for all actions
- RBAC permission system
- Dark/Light mode
