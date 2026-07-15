# Production Stabilization Migration Plan

## Safety baseline

- Backup: `database/backups/dlight_pos_pre_stabilization_20260627.dump`
- SHA-256: `A34053A3A70FFE57B2380B2E7B4E25E1AE1661E26F1CD4E6911C0E5E6E7709B2`
- Format: PostgreSQL custom archive
- Restore validation: archive catalogue readable by `pg_restore`

## Migration sequence

1. Capture duplicate and balance discrepancies in repair audit tables.
2. Consolidate duplicate deliveries into one canonical delivery per order.
3. Recalculate stored supplier and rider balances from their ledgers.
4. Add one-record and nonnegative database constraints after cleanup.
5. Centralize order state transitions and disable direct delivery mutation.
6. Add explicit refund, reversal, remittance, and settlement ledger entries.
7. Correct dashboard, profit, COD, and reconciliation queries.
8. Complete frontend operational workflows.
9. Add integration tests and release verification.

## Rollback

For Phase 0, restore the custom archive into a clean database:

```powershell
createdb dlight_pos_restore
pg_restore --dbname=dlight_pos_restore database/backups/dlight_pos_pre_stabilization_20260627.dump
```

Every repair migration stores before/after evidence in dedicated audit tables and
runs in a transaction. Schema constraints are added only after data cleanup.
