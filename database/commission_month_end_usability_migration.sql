-- Minimal commission month-end usability controls:
-- payroll settlement recording, auditable settlement voids, and a guarded
-- reopened state used only by the administrative undo workflow.

BEGIN;

ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'payroll';

ALTER TABLE commission_payments
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

ALTER TABLE commission_payments
  DROP CONSTRAINT IF EXISTS commission_payments_status_check;
ALTER TABLE commission_payments
  ADD CONSTRAINT commission_payments_status_check
  CHECK (status IN ('pending', 'partial', 'paid', 'voided'));

ALTER TABLE commission_period_closures
  ADD COLUMN IF NOT EXISTS reopened_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS reopen_reason TEXT;

ALTER TABLE commission_period_closures
  DROP CONSTRAINT IF EXISTS commission_period_closures_status_check;
ALTER TABLE commission_period_closures
  ADD CONSTRAINT commission_period_closures_status_check
  CHECK (status IN ('closing', 'closed', 'reopened'));

-- Closed periods remain immutable to ordinary SQL. The application can move
-- exactly one named closure to "reopened" after its dependency checks pass by
-- setting this transaction-local key to that closure UUID.
CREATE OR REPLACE FUNCTION guard_closed_commission_period_closure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authorized_closure TEXT;
BEGIN
  IF OLD.status = 'closed' THEN
    authorized_closure := current_setting('dlight.commission_reopen_closure', TRUE);
    IF TG_OP = 'UPDATE'
       AND NEW.status = 'reopened'
       AND authorized_closure = OLD.id::text THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Closed commission period % cannot be changed or deleted', OLD.period_start
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
