-- Month-end commission closure and carry-forward controls.
-- A closed period is immutable. Any remaining balance is offset in the closed
-- month and carried into the following open month as a separately traceable
-- credit or recovery deduction.

BEGIN;

INSERT INTO permissions (name, description, module, action) VALUES
  ('commission_close', 'Close commission periods and view closure history', 'commission', 'close')
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  module = EXCLUDED.module,
  action = EXCLUDED.action;

-- On a repeat deployment, the previous version of these guards may compare
-- raw dates. Remove them inside this migration transaction before canonical
-- month-start repair, then install the hardened versions below. The table lock
-- held by DROP TRIGGER prevents a writer from slipping between the repair and
-- replacement trigger at COMMIT.
DROP TRIGGER IF EXISTS trg_guard_closed_commission_period_transaction ON commission_transactions;
DROP TRIGGER IF EXISTS trg_guard_closed_commission_period_payment ON commission_payments;

ALTER TABLE commission_transactions
  ADD COLUMN IF NOT EXISTS carry_forward_direction VARCHAR(20);

-- commission_month is an accounting period key, not an event date. Older
-- imports occasionally stored another day in the same month; canonicalise
-- them before a close can use the key as an immutability boundary.
UPDATE commission_transactions
SET commission_month = date_trunc('month', commission_month)::date
WHERE commission_month IS DISTINCT FROM date_trunc('month', commission_month)::date;

-- Payments use the same accounting-period key. In particular, a legacy
-- unlinked payment must remain part of its month-end balance rather than be
-- silently omitted because it was recorded on (for example) the 31st.
UPDATE commission_payments
SET period_start = date_trunc('month', period_start)::date
WHERE period_start IS DISTINCT FROM date_trunc('month', period_start)::date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_transactions_carry_forward_direction') THEN
    ALTER TABLE commission_transactions
      ADD CONSTRAINT commission_transactions_carry_forward_direction
      CHECK (
        transaction_type <> 'carry_forward'
        OR carry_forward_direction IN ('credit', 'deduction')
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_transactions_commission_month_start') THEN
    ALTER TABLE commission_transactions
      ADD CONSTRAINT commission_transactions_commission_month_start
      CHECK (commission_month = date_trunc('month', commission_month)::date) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_payments_period_start_month_start') THEN
    ALTER TABLE commission_payments
      ADD CONSTRAINT commission_payments_period_start_month_start
      CHECK (period_start = date_trunc('month', period_start)::date) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS commission_period_closures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start DATE NOT NULL UNIQUE,
  period_end DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'closing' CHECK (status IN ('closing', 'closed')),
  reason TEXT NOT NULL,
  closed_by UUID REFERENCES users(id),
  closed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (period_start = date_trunc('month', period_start)::date),
  CHECK (period_end = (date_trunc('month', period_start) + INTERVAL '1 month - 1 day')::date)
);

CREATE TABLE IF NOT EXISTS commission_period_closure_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  closure_id UUID NOT NULL REFERENCES commission_period_closures(id),
  salesperson_id UUID NOT NULL REFERENCES users(id),
  programme_id UUID REFERENCES commission_programmes(id),
  approved_credits NUMERIC(12,2) NOT NULL DEFAULT 0,
  approved_deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  closing_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  source_offset_transaction_id UUID REFERENCES commission_transactions(id),
  carry_forward_transaction_id UUID REFERENCES commission_transactions(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (closure_id, salesperson_id),
  UNIQUE (source_offset_transaction_id),
  UNIQUE (carry_forward_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_commission_period_closures_period
  ON commission_period_closures(period_start DESC);
CREATE INDEX IF NOT EXISTS idx_commission_period_closure_balances_salesperson
  ON commission_period_closure_balances(salesperson_id, closure_id);

-- One source offset and one following-month carry-forward per salesperson and
-- closure. This also protects a retried application from creating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_closure_carry_forward
  ON commission_transactions(reference_id, salesperson_id, commission_month, carry_forward_direction)
  WHERE transaction_type = 'carry_forward'
    AND reference_type = 'commission_period_closure'
    AND reference_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_closed_commission_period_transaction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_month DATE;
  new_month DATE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_month := date_trunc('month', OLD.commission_month)::date;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_month := date_trunc('month', NEW.commission_month)::date;
  END IF;

  IF old_month IS NOT NULL AND EXISTS (
    SELECT 1 FROM commission_period_closures
    WHERE period_start = old_month AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Commission period % is closed and its ledger cannot be changed', old_month
      USING ERRCODE = '55000';
  END IF;

  IF new_month IS NOT NULL AND new_month IS DISTINCT FROM old_month AND EXISTS (
    SELECT 1 FROM commission_period_closures
    WHERE period_start = new_month AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Commission period % is closed and its ledger cannot be changed', new_month
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_closed_commission_period_transaction
BEFORE INSERT OR UPDATE OR DELETE ON commission_transactions
FOR EACH ROW EXECUTE FUNCTION guard_closed_commission_period_transaction();

CREATE OR REPLACE FUNCTION guard_closed_commission_period_payment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_month DATE;
  new_month DATE;
  old_period_start DATE;
  new_period_start DATE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_period_start := date_trunc('month', OLD.period_start)::date;
    IF OLD.commission_transaction_id IS NOT NULL THEN
      SELECT date_trunc('month', commission_month)::date INTO old_month
      FROM commission_transactions WHERE id = OLD.commission_transaction_id;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_period_start := date_trunc('month', NEW.period_start)::date;
    IF NEW.commission_transaction_id IS NOT NULL THEN
      SELECT date_trunc('month', commission_month)::date INTO new_month
      FROM commission_transactions WHERE id = NEW.commission_transaction_id;
    END IF;
  END IF;

  IF old_month IS NOT NULL AND EXISTS (
    SELECT 1 FROM commission_period_closures
    WHERE period_start = old_month AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Commission period % is closed and its payments cannot be changed', old_month
      USING ERRCODE = '55000';
  END IF;

  IF new_month IS NOT NULL AND new_month IS DISTINCT FROM old_month AND EXISTS (
    SELECT 1 FROM commission_period_closures
    WHERE period_start = new_month AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Commission period % is closed and its payments cannot be changed', new_month
      USING ERRCODE = '55000';
  END IF;

  IF old_period_start IS NOT NULL AND old_period_start IS DISTINCT FROM old_month AND EXISTS (
    SELECT 1 FROM commission_period_closures
    WHERE period_start = old_period_start AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Commission period % is closed and its payments cannot be changed', old_period_start
      USING ERRCODE = '55000';
  END IF;

  IF new_period_start IS NOT NULL
     AND new_period_start IS DISTINCT FROM old_month
     AND new_period_start IS DISTINCT FROM new_month
     AND EXISTS (
       SELECT 1 FROM commission_period_closures
       WHERE period_start = new_period_start AND status = 'closed'
     ) THEN
    RAISE EXCEPTION 'Commission period % is closed and its payments cannot be changed', new_period_start
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_closed_commission_period_payment
BEFORE INSERT OR UPDATE OR DELETE ON commission_payments
FOR EACH ROW EXECUTE FUNCTION guard_closed_commission_period_payment();

-- Once marked closed, the closure header cannot be silently edited or removed.
CREATE OR REPLACE FUNCTION guard_closed_commission_period_closure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'Closed commission period % cannot be changed or deleted', OLD.period_start
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_closed_commission_period_closure ON commission_period_closures;
CREATE TRIGGER trg_guard_closed_commission_period_closure
BEFORE UPDATE OR DELETE ON commission_period_closures
FOR EACH ROW EXECUTE FUNCTION guard_closed_commission_period_closure();

CREATE OR REPLACE FUNCTION guard_closed_commission_period_closure_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  relevant_closure UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    relevant_closure := OLD.closure_id;
  ELSE
    relevant_closure := NEW.closure_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM commission_period_closures
    WHERE id = relevant_closure AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Balances for closed commission period % cannot be changed', relevant_closure
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_closed_commission_period_closure_balance ON commission_period_closure_balances;
CREATE TRIGGER trg_guard_closed_commission_period_closure_balance
BEFORE INSERT OR UPDATE OR DELETE ON commission_period_closure_balances
FOR EACH ROW EXECUTE FUNCTION guard_closed_commission_period_closure_balance();

COMMIT;
