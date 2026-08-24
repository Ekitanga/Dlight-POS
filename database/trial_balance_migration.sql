BEGIN;

CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
    normal_balance VARCHAR(6) NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
    is_control_account BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounting_settings (
    singleton_key BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton_key),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    cutover_date DATE,
    activated_by UUID REFERENCES users(id),
    activated_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK ((enabled = FALSE) OR cutover_date IS NOT NULL)
);

INSERT INTO accounting_settings (singleton_key) VALUES (TRUE)
ON CONFLICT (singleton_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    accounting_date DATE NOT NULL,
    description TEXT NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    source_id UUID NOT NULL,
    source_event VARCHAR(80) NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (source_type, source_id, source_event)
);

CREATE TABLE IF NOT EXISTS journal_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id),
    debit NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    memo TEXT,
    entity_type VARCHAR(50),
    entity_id UUID,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_accounting_date ON journal_entries(accounting_date);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id, journal_entry_id);

INSERT INTO accounts (code, name, account_type, normal_balance, is_control_account) VALUES
  ('1000', 'Cash on Hand', 'asset', 'debit', TRUE),
  ('1010', 'M-Pesa', 'asset', 'debit', TRUE),
  ('1020', 'Bank', 'asset', 'debit', TRUE),
  ('1100', 'Accounts Receivable', 'asset', 'debit', TRUE),
  ('1120', 'Courier COD Receivable', 'asset', 'debit', TRUE),
  ('1200', 'Inventory', 'asset', 'debit', TRUE),
  ('1300', 'Supplier Fulfilment Clearing', 'asset', 'debit', TRUE),
  ('1310', 'Delivery Cost Clearing', 'asset', 'debit', TRUE),
  ('2000', 'Supplier Payables', 'liability', 'credit', TRUE),
  ('2010', 'Rider Payables', 'liability', 'credit', TRUE),
  ('2020', 'Refunds Payable', 'liability', 'credit', TRUE),
  ('2200', 'Customer Deposits', 'liability', 'credit', TRUE),
  ('3000', 'Opening Equity', 'equity', 'credit', FALSE),
  ('4000', 'Product Sales', 'revenue', 'credit', FALSE),
  ('4010', 'Delivery Income', 'revenue', 'credit', FALSE),
  ('4090', 'Sales Returns', 'revenue', 'debit', FALSE),
  ('5000', 'Internal Cost of Goods Sold', 'expense', 'debit', FALSE),
  ('5010', 'Supplier Fulfilment Costs', 'expense', 'debit', FALSE),
  ('5020', 'Delivery Costs', 'expense', 'debit', FALSE),
  ('6000', 'General Operating Expenses', 'expense', 'debit', FALSE),
  ('6100', 'Rent Expense', 'expense', 'debit', FALSE),
  ('6110', 'Salaries Expense', 'expense', 'debit', FALSE),
  ('6120', 'Electricity Expense', 'expense', 'debit', FALSE),
  ('6130', 'Internet Expense', 'expense', 'debit', FALSE),
  ('6140', 'Packaging Expense', 'expense', 'debit', FALSE),
  ('6150', 'Fuel Expense', 'expense', 'debit', FALSE)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  account_type = EXCLUDED.account_type,
  normal_balance = EXCLUDED.normal_balance,
  is_control_account = EXCLUDED.is_control_account,
  updated_at = NOW();

ALTER TABLE customer_credits
  ADD COLUMN IF NOT EXISTS payment_method payment_method,
  ADD COLUMN IF NOT EXISTS reference VARCHAR(255);

CREATE OR REPLACE FUNCTION accounting_payment_account(p_method TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE p_method
    WHEN 'mpesa' THEN '1010'
    WHEN 'bank_transfer' THEN '1020'
    ELSE '1000'
  END
$$;

CREATE OR REPLACE FUNCTION accounting_expense_account(p_category TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE LOWER(TRIM(COALESCE(p_category, '')))
    WHEN 'rent' THEN '6100'
    WHEN 'salaries' THEN '6110'
    WHEN 'electricity' THEN '6120'
    WHEN 'internet' THEN '6130'
    WHEN 'packaging' THEN '6140'
    WHEN 'fuel' THEN '6150'
    ELSE '6000'
  END
$$;

CREATE OR REPLACE FUNCTION post_accounting_journal(
  p_accounting_date DATE,
  p_description TEXT,
  p_source_type TEXT,
  p_source_id UUID,
  p_source_event TEXT,
  p_created_by UUID,
  p_lines JSONB
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id UUID;
  v_debits NUMERIC;
  v_credits NUMERIC;
  v_inserted INTEGER;
  v_expected INTEGER;
  v_cutover DATE;
  v_enabled BOOLEAN;
BEGIN
  SELECT enabled, cutover_date INTO v_enabled, v_cutover
  FROM accounting_settings WHERE singleton_key = TRUE;

  IF NOT COALESCE(v_enabled, FALSE) OR p_accounting_date < v_cutover THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'A journal requires at least two lines';
  END IF;

  SELECT COALESCE(SUM(COALESCE((line->>'debit')::numeric, 0)), 0),
         COALESCE(SUM(COALESCE((line->>'credit')::numeric, 0)), 0)
    INTO v_debits, v_credits
  FROM jsonb_array_elements(p_lines) line;

  IF v_debits <= 0 OR ABS(v_debits - v_credits) >= 0.005 THEN
    RAISE EXCEPTION 'Journal is not balanced: debits %, credits %', v_debits, v_credits;
  END IF;

  INSERT INTO journal_entries
    (accounting_date, description, source_type, source_id, source_event, created_by)
  VALUES
    (p_accounting_date, p_description, p_source_type, p_source_id, p_source_event, p_created_by)
  ON CONFLICT (source_type, source_id, source_event) DO NOTHING
  RETURNING id INTO v_entry_id;

  IF v_entry_id IS NULL THEN
    SELECT id INTO v_entry_id FROM journal_entries
    WHERE source_type = p_source_type AND source_id = p_source_id AND source_event = p_source_event;
    RETURN v_entry_id;
  END IF;

  v_expected := jsonb_array_length(p_lines);
  INSERT INTO journal_lines
    (journal_entry_id, account_id, debit, credit, memo, entity_type, entity_id)
  SELECT v_entry_id, a.id,
         COALESCE((line->>'debit')::numeric, 0),
         COALESCE((line->>'credit')::numeric, 0),
         NULLIF(line->>'memo', ''), NULLIF(line->>'entity_type', ''),
         NULLIF(line->>'entity_id', '')::uuid
  FROM jsonb_array_elements(p_lines) line
  JOIN accounts a ON a.code = line->>'code' AND a.is_active;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted <> v_expected THEN
    RAISE EXCEPTION 'Journal contains an unknown or inactive account';
  END IF;
  RETURN v_entry_id;
END
$$;

CREATE OR REPLACE FUNCTION reverse_accounting_journal(
  p_source_type TEXT,
  p_source_id UUID,
  p_original_event TEXT,
  p_reversal_event TEXT,
  p_accounting_date DATE,
  p_description TEXT,
  p_created_by UUID
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_original UUID;
  v_lines JSONB;
BEGIN
  SELECT id INTO v_original FROM journal_entries
  WHERE source_type = p_source_type AND source_id = p_source_id AND source_event = p_original_event;
  IF v_original IS NULL THEN RETURN NULL; END IF;

  SELECT jsonb_agg(jsonb_build_object(
      'code', a.code, 'debit', jl.credit, 'credit', jl.debit,
      'memo', COALESCE(jl.memo, '') || ' (reversal)',
      'entity_type', jl.entity_type, 'entity_id', jl.entity_id
    ) ORDER BY jl.id)
  INTO v_lines
  FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
  WHERE jl.journal_entry_id = v_original;

  RETURN post_accounting_journal(p_accounting_date, p_description, p_source_type,
    p_source_id, p_reversal_event, p_created_by, v_lines);
END
$$;

CREATE OR REPLACE FUNCTION validate_balanced_journal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_entry UUID := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  v_debits NUMERIC;
  v_credits NUMERIC;
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries WHERE id = v_entry) THEN
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
      INTO v_debits, v_credits FROM journal_lines WHERE journal_entry_id = v_entry;
    IF v_debits <= 0 OR ABS(v_debits - v_credits) >= 0.005 THEN
      RAISE EXCEPTION 'Posted journal % is not balanced', v_entry;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS trg_balanced_journal ON journal_lines;
CREATE CONSTRAINT TRIGGER trg_balanced_journal
AFTER INSERT OR UPDATE OR DELETE ON journal_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_balanced_journal();

CREATE OR REPLACE FUNCTION protect_posted_journal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Posted journals are immutable; create a reversing entry instead';
END
$$;

DROP TRIGGER IF EXISTS trg_protect_journal_entries ON journal_entries;
CREATE TRIGGER trg_protect_journal_entries BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION protect_posted_journal();
DROP TRIGGER IF EXISTS trg_protect_journal_lines ON journal_lines;
CREATE TRIGGER trg_protect_journal_lines BEFORE UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION protect_posted_journal();

CREATE OR REPLACE FUNCTION account_order_payment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_credit_code TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM reverse_accounting_journal('order_payment', OLD.id, 'receipt', 'receipt_reversed',
      CURRENT_DATE, 'Reversed deleted order payment', OLD.created_by);
    RETURN OLD;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = NEW.order_id;
  v_credit_code := CASE
    WHEN v_order.status IN ('delivered', 'collected_paid')
      AND v_order.delivery_type = 'courier' AND v_order.courier_payment_type = 'cod' THEN '1120'
    WHEN v_order.status IN ('delivered', 'collected_paid') THEN '1100'
    ELSE '2200'
  END;
  PERFORM post_accounting_journal(NEW.payment_date, 'Payment received for ' || v_order.order_number,
    'order_payment', NEW.id, 'receipt', NEW.created_by,
    jsonb_build_array(
      jsonb_build_object('code', accounting_payment_account(NEW.payment_method::text), 'debit', NEW.amount,
        'credit', 0, 'entity_type', 'order', 'entity_id', NEW.order_id),
      jsonb_build_object('code', v_credit_code, 'debit', 0, 'credit', NEW.amount,
        'entity_type', 'order', 'entity_id', NEW.order_id)
    ));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_account_order_payment ON order_payments;
CREATE TRIGGER trg_account_order_payment AFTER INSERT OR DELETE ON order_payments
FOR EACH ROW EXECUTE FUNCTION account_order_payment();

CREATE OR REPLACE FUNCTION account_unallocated_customer_payment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_amount NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.type = 'payment' AND OLD.order_id IS NULL THEN
      PERFORM reverse_accounting_journal('customer_credit', OLD.id, 'payment', 'deleted',
        CURRENT_DATE, 'Reversed deleted customer payment', OLD.created_by);
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.type <> 'payment' OR NEW.order_id IS NOT NULL THEN RETURN NEW; END IF;
  v_amount := ABS(NEW.amount);
  PERFORM post_accounting_journal(NEW.created_at::date, 'Unallocated customer payment',
    'customer_credit', NEW.id, 'payment', NEW.created_by,
    jsonb_build_array(
      jsonb_build_object('code', accounting_payment_account(COALESCE(NEW.payment_method::text, 'cash')),
        'debit', v_amount, 'credit', 0, 'entity_type', 'customer', 'entity_id', NEW.customer_id),
      jsonb_build_object('code', '1100', 'debit', 0, 'credit', v_amount,
        'entity_type', 'customer', 'entity_id', NEW.customer_id)
    ));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_account_unallocated_customer_payment ON customer_credits;
CREATE TRIGGER trg_account_unallocated_customer_payment AFTER INSERT OR DELETE ON customer_credits
FOR EACH ROW EXECUTE FUNCTION account_unallocated_customer_payment();

CREATE OR REPLACE FUNCTION account_supplier_payable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_code TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM reverse_accounting_journal('supplier_payable', OLD.id, 'recognized', 'deleted',
      CURRENT_DATE, 'Reversed deleted supplier payable', OLD.created_by);
    RETURN OLD;
  END IF;
  v_code := CASE WHEN NEW.order_id IS NULL THEN '5010' ELSE '1300' END;
  PERFORM post_accounting_journal(NEW.created_at::date, COALESCE(NEW.description, 'Supplier payable'),
    'supplier_payable', NEW.id, 'recognized', NEW.created_by,
    jsonb_build_array(
      jsonb_build_object('code', v_code, 'debit', NEW.amount, 'credit', 0,
        'entity_type', 'supplier', 'entity_id', NEW.supplier_id),
      jsonb_build_object('code', '2000', 'debit', 0, 'credit', NEW.amount,
        'entity_type', 'supplier', 'entity_id', NEW.supplier_id)
    ));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_account_supplier_payable ON supplier_payables;
CREATE TRIGGER trg_account_supplier_payable AFTER INSERT OR DELETE ON supplier_payables
FOR EACH ROW EXECUTE FUNCTION account_supplier_payable();

CREATE OR REPLACE FUNCTION account_supplier_payment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM reverse_accounting_journal('supplier_payment', OLD.id, 'paid', 'deleted',
      CURRENT_DATE, 'Reversed deleted supplier payment', OLD.created_by);
    RETURN OLD;
  END IF;
  PERFORM post_accounting_journal(NEW.created_at::date, 'Supplier payment', 'supplier_payment', NEW.id,
    'paid', NEW.created_by,
    jsonb_build_array(
      jsonb_build_object('code', '2000', 'debit', NEW.amount, 'credit', 0,
        'entity_type', 'supplier', 'entity_id', NEW.supplier_id),
      jsonb_build_object('code', accounting_payment_account(NEW.payment_method::text),
        'debit', 0, 'credit', NEW.amount, 'entity_type', 'supplier', 'entity_id', NEW.supplier_id)
    ));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_account_supplier_payment ON supplier_payments;
CREATE TRIGGER trg_account_supplier_payment AFTER INSERT OR DELETE ON supplier_payments
FOR EACH ROW EXECUTE FUNCTION account_supplier_payment();

CREATE OR REPLACE FUNCTION account_supplier_return()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_order_id UUID;
  v_status order_status;
  v_code TEXT := '5010';
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM reverse_accounting_journal('supplier_return', OLD.id, 'returned', 'deleted',
      CURRENT_DATE, 'Reversed deleted supplier return', OLD.created_by);
    RETURN OLD;
  END IF;
  SELECT sp.order_id INTO v_order_id FROM supplier_payables sp WHERE sp.id = NEW.payable_id;
  IF COALESCE(NEW.reason, '') ILIKE 'Order % liability reversal' THEN
    v_code := '1300';
  ELSIF v_order_id IS NOT NULL THEN
    SELECT status INTO v_status FROM orders WHERE id = v_order_id;
    IF v_status NOT IN ('delivered', 'collected_paid', 'returned') THEN v_code := '1300'; END IF;
  END IF;
  PERFORM post_accounting_journal(NEW.created_at::date, 'Supplier return', 'supplier_return', NEW.id,
    'returned', NEW.created_by,
    jsonb_build_array(
      jsonb_build_object('code', '2000', 'debit', NEW.amount, 'credit', 0,
        'entity_type', 'supplier', 'entity_id', NEW.supplier_id),
      jsonb_build_object('code', v_code, 'debit', 0, 'credit', NEW.amount,
        'entity_type', 'supplier', 'entity_id', NEW.supplier_id)
    ));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_account_supplier_return ON supplier_returns;
CREATE TRIGGER trg_account_supplier_return AFTER INSERT OR DELETE ON supplier_returns
FOR EACH ROW EXECUTE FUNCTION account_supplier_return();

CREATE OR REPLACE FUNCTION account_rider_earning()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_order_status order_status;
  v_code TEXT := '5020';
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'reversed' AND NEW.status = 'reversed' THEN
    PERFORM reverse_accounting_journal('rider_earning', NEW.id, 'recognized', 'reversed',
      CURRENT_DATE, 'Reversed rider earning', NEW.created_by);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM reverse_accounting_journal('rider_earning', OLD.id, 'recognized', 'deleted',
      CURRENT_DATE, 'Reversed deleted rider earning', OLD.created_by);
    RETURN OLD;
  ELSIF TG_OP <> 'INSERT' THEN RETURN NEW;
  END IF;
  IF NEW.order_id IS NOT NULL THEN
    SELECT status INTO v_order_status FROM orders WHERE id = NEW.order_id;
    IF v_order_status NOT IN ('delivered', 'collected_paid') THEN v_code := '1310'; END IF;
  END IF;
  PERFORM post_accounting_journal(NEW.created_at::date, 'Rider earning', 'rider_earning', NEW.id,
    'recognized', NEW.created_by,
    jsonb_build_array(
      jsonb_build_object('code', v_code, 'debit', NEW.amount, 'credit', 0,
        'entity_type', 'rider', 'entity_id', NEW.rider_id),
      jsonb_build_object('code', '2010', 'debit', 0, 'credit', NEW.amount,
        'entity_type', 'rider', 'entity_id', NEW.rider_id)
    ));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_account_rider_earning ON rider_earnings;
CREATE TRIGGER trg_account_rider_earning AFTER INSERT OR UPDATE OF status OR DELETE ON rider_earnings
FOR EACH ROW EXECUTE FUNCTION account_rider_earning();

CREATE OR REPLACE FUNCTION account_rider_payment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM reverse_accounting_journal('rider_payment', OLD.id, 'paid', 'deleted',
      CURRENT_DATE, 'Reversed deleted rider payment', OLD.created_by);
    RETURN OLD;
  END IF;
  PERFORM post_accounting_journal(NEW.created_at::date, 'Rider payment', 'rider_payment', NEW.id,
    'paid', NEW.created_by,
    jsonb_build_array(
      jsonb_build_object('code', '2010', 'debit', NEW.amount, 'credit', 0,
        'entity_type', 'rider', 'entity_id', NEW.rider_id),
      jsonb_build_object('code', accounting_payment_account(NEW.payment_method::text),
        'debit', 0, 'credit', NEW.amount, 'entity_type', 'rider', 'entity_id', NEW.rider_id)
    ));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_account_rider_payment ON rider_payments;
CREATE TRIGGER trg_account_rider_payment AFTER INSERT OR DELETE ON rider_payments
FOR EACH ROW EXECUTE FUNCTION account_rider_payment();

CREATE OR REPLACE FUNCTION account_expense()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_entry RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' AND OLD.frequency = 'one_off' THEN
      PERFORM reverse_accounting_journal('expense', OLD.id, 'recognized', 'deleted',
        CURRENT_DATE, 'Reversed deleted expense', OLD.created_by);
    ELSIF OLD.status = 'approved' THEN
      FOR v_entry IN SELECT source_event, accounting_date FROM journal_entries
        WHERE source_type='recurring_expense' AND source_id=OLD.id AND source_event LIKE 'recognition:%'
      LOOP
        PERFORM reverse_accounting_journal('recurring_expense', OLD.id, v_entry.source_event,
          'reversal:' || v_entry.accounting_date, CURRENT_DATE, 'Reversed deleted recurring expense', OLD.created_by);
      END LOOP;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'approved' AND NEW.status <> 'approved' THEN
    IF OLD.frequency = 'one_off' THEN
      PERFORM reverse_accounting_journal('expense', NEW.id, 'recognized', 'approval_reversed',
        CURRENT_DATE, 'Reversed expense approval', NEW.approved_by);
    ELSE
      FOR v_entry IN SELECT source_event, accounting_date FROM journal_entries
        WHERE source_type='recurring_expense' AND source_id=NEW.id AND source_event LIKE 'recognition:%'
      LOOP
        PERFORM reverse_accounting_journal('recurring_expense', NEW.id, v_entry.source_event,
          'reversal:' || v_entry.accounting_date, CURRENT_DATE, 'Reversed recurring expense approval', NEW.approved_by);
      END LOOP;
    END IF;
    RETURN NEW;
  ELSIF NEW.status <> 'approved' OR NEW.frequency <> 'one_off'
      OR (TG_OP = 'UPDATE' AND OLD.status = 'approved') THEN
    RETURN NEW;
  END IF;
  PERFORM post_accounting_journal(NEW.expense_date, NEW.description, 'expense', NEW.id,
    'recognized', COALESCE(NEW.approved_by, NEW.created_by),
    jsonb_build_array(
      jsonb_build_object('code', accounting_expense_account(NEW.category), 'debit', NEW.amount, 'credit', 0,
        'entity_type', 'expense', 'entity_id', NEW.id),
      jsonb_build_object('code', accounting_payment_account(NEW.payment_method::text),
        'debit', 0, 'credit', NEW.amount, 'entity_type', 'expense', 'entity_id', NEW.id)
    ));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_account_expense ON expenses;
CREATE TRIGGER trg_account_expense AFTER INSERT OR UPDATE OF status OR DELETE ON expenses
FOR EACH ROW EXECUTE FUNCTION account_expense();

CREATE OR REPLACE FUNCTION account_order_refund()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_has_sale BOOLEAN;
  v_sale_reversed BOOLEAN;
  v_debit_code TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'pending' AND NOT EXISTS (
      SELECT 1 FROM journal_entries WHERE source_type='order_refund' AND source_id=OLD.id
        AND source_event IN ('converted_to_sale_reversal', 'cancelled', 'deleted')
    ) THEN
      PERFORM reverse_accounting_journal('order_refund', OLD.id, 'refund_due', 'deleted',
        CURRENT_DATE, 'Reversed deleted refund', OLD.created_by);
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    SELECT EXISTS (SELECT 1 FROM journal_entries
      WHERE source_type='order' AND source_id=NEW.order_id AND source_event='sale_recognized')
      INTO v_has_sale;
    v_debit_code := CASE WHEN v_has_sale THEN '4090' ELSE '2200' END;
    PERFORM post_accounting_journal(NEW.created_at::date, 'Refund due', 'order_refund', NEW.id,
      'refund_due', NEW.created_by,
      jsonb_build_array(
        jsonb_build_object('code', v_debit_code, 'debit', NEW.amount, 'credit', 0,
          'entity_type', 'order', 'entity_id', NEW.order_id),
        jsonb_build_object('code', '2020', 'debit', 0, 'credit', NEW.amount,
          'entity_type', 'order', 'entity_id', NEW.order_id)
      ));
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'cancelled' THEN
    PERFORM reverse_accounting_journal('order_refund', NEW.id, 'refund_due', 'cancelled',
      CURRENT_DATE, 'Cancelled refund liability', NEW.created_by);
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'paid' THEN
    SELECT EXISTS (SELECT 1 FROM journal_entries
      WHERE source_type='order' AND source_id=NEW.order_id AND source_event='sale_reversed')
      INTO v_sale_reversed;
    v_debit_code := CASE WHEN v_sale_reversed THEN '2200' ELSE '2020' END;
    PERFORM post_accounting_journal(COALESCE(NEW.refunded_at::date, CURRENT_DATE), 'Customer refund paid',
      'order_refund', NEW.id, 'paid', NEW.created_by,
      jsonb_build_array(
        jsonb_build_object('code', v_debit_code, 'debit', NEW.amount, 'credit', 0,
          'entity_type', 'order', 'entity_id', NEW.order_id),
        jsonb_build_object('code', accounting_payment_account(COALESCE(NEW.payment_method::text, 'cash')),
          'debit', 0, 'credit', NEW.amount, 'entity_type', 'order', 'entity_id', NEW.order_id)
      ));
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_account_order_refund ON order_refunds;
CREATE TRIGGER trg_account_order_refund AFTER INSERT OR UPDATE OF status OR DELETE ON order_refunds
FOR EACH ROW EXECUTE FUNCTION account_order_refund();

CREATE OR REPLACE FUNCTION account_completed_order()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_payments NUMERIC;
  v_deposit NUMERIC;
  v_receivable NUMERIC;
  v_internal_cost NUMERIC;
  v_supplier_cost NUMERIC;
  v_rider_cost NUMERIC;
  v_receivable_code TEXT;
  v_lines JSONB := '[]'::jsonb;
  v_refund RECORD;
BEGIN
  IF OLD.status IN ('delivered', 'collected_paid') AND NEW.status IN ('returned', 'cancelled') THEN
    FOR v_refund IN SELECT id, created_by FROM order_refunds
      WHERE order_id=NEW.id AND status='pending'
    LOOP
      PERFORM reverse_accounting_journal('order_refund', v_refund.id, 'refund_due',
        'converted_to_sale_reversal', CURRENT_DATE, 'Refund liability converted by full sale reversal',
        COALESCE(NEW.cancelled_by, v_refund.created_by));
    END LOOP;
    PERFORM reverse_accounting_journal('order', NEW.id, 'sale_recognized', 'sale_reversed',
      CURRENT_DATE, 'Reversed sale ' || NEW.order_number, NEW.cancelled_by);
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('delivered', 'collected_paid') OR OLD.status IN ('delivered', 'collected_paid') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_payments FROM order_payments WHERE order_id = NEW.id;
  SELECT COALESCE(SUM(unit_cost * internal_quantity), 0),
         COALESCE(SUM(supplier_cost * supplier_quantity), 0)
    INTO v_internal_cost, v_supplier_cost FROM order_items WHERE order_id = NEW.id;
  SELECT COALESCE(SUM(amount), 0) INTO v_rider_cost
    FROM rider_earnings WHERE order_id = NEW.id AND status <> 'reversed';

  v_deposit := LEAST(v_payments, NEW.total_amount);
  v_receivable := GREATEST(NEW.total_amount - v_deposit, 0);
  v_receivable_code := CASE WHEN NEW.delivery_type = 'courier' AND NEW.courier_payment_type = 'cod'
    THEN '1120' ELSE '1100' END;

  IF v_deposit > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'code', '2200', 'debit', v_deposit, 'credit', 0, 'entity_type', 'order', 'entity_id', NEW.id)); END IF;
  IF v_receivable > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'code', v_receivable_code, 'debit', v_receivable, 'credit', 0, 'entity_type', 'order', 'entity_id', NEW.id)); END IF;
  IF NEW.subtotal > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'code', '4000', 'debit', 0, 'credit', NEW.subtotal, 'entity_type', 'order', 'entity_id', NEW.id)); END IF;
  IF NEW.delivery_income > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'code', '4010', 'debit', 0, 'credit', NEW.delivery_income, 'entity_type', 'order', 'entity_id', NEW.id)); END IF;
  IF v_internal_cost > 0 THEN v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('code', '5000', 'debit', v_internal_cost, 'credit', 0, 'entity_type', 'order', 'entity_id', NEW.id),
    jsonb_build_object('code', '1200', 'debit', 0, 'credit', v_internal_cost, 'entity_type', 'order', 'entity_id', NEW.id)); END IF;
  IF v_supplier_cost > 0 THEN v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('code', '5010', 'debit', v_supplier_cost, 'credit', 0, 'entity_type', 'order', 'entity_id', NEW.id),
    jsonb_build_object('code', '1300', 'debit', 0, 'credit', v_supplier_cost, 'entity_type', 'order', 'entity_id', NEW.id)); END IF;
  IF v_rider_cost > 0 THEN v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('code', '5020', 'debit', v_rider_cost, 'credit', 0, 'entity_type', 'order', 'entity_id', NEW.id),
    jsonb_build_object('code', '1310', 'debit', 0, 'credit', v_rider_cost, 'entity_type', 'order', 'entity_id', NEW.id)); END IF;

  PERFORM post_accounting_journal(CURRENT_DATE, 'Sale recognized for ' || NEW.order_number,
    'order', NEW.id, 'sale_recognized', COALESCE(NEW.commission_completion_by, NEW.created_by), v_lines);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_account_completed_order ON orders;
CREATE TRIGGER trg_account_completed_order AFTER UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION account_completed_order();

CREATE OR REPLACE FUNCTION materialize_recurring_expense_journals(p_through_date DATE, p_user_id UUID)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_expense RECORD;
  v_day DATE;
  v_amount NUMERIC;
  v_count INTEGER := 0;
  v_id UUID;
  v_cutover DATE;
BEGIN
  SELECT cutover_date INTO v_cutover FROM accounting_settings WHERE singleton_key = TRUE AND enabled;
  IF v_cutover IS NULL THEN RETURN 0; END IF;
  FOR v_expense IN SELECT * FROM expenses
    WHERE status = 'approved' AND frequency IN ('daily', 'monthly')
      AND expense_date <= p_through_date
      AND COALESCE(effective_end_date, p_through_date) >= v_cutover + 1
  LOOP
    -- The opening journal is a live cutover snapshot, so activity already
    -- reflected in verified balances on the cutover date must not be posted a
    -- second time. Recurring recognition starts on the following business day.
    FOR v_day IN SELECT generate_series(GREATEST(v_expense.expense_date, v_cutover + 1),
      LEAST(COALESCE(v_expense.effective_end_date, p_through_date), p_through_date), '1 day')::date
    LOOP
      v_amount := CASE WHEN v_expense.frequency = 'daily' THEN v_expense.amount
        ELSE ROUND(v_expense.amount / EXTRACT(DAY FROM (date_trunc('month', v_day)::date + INTERVAL '1 month - 1 day'))::numeric, 2) END;
      v_id := post_accounting_journal(v_day, v_expense.description || ' (' || v_day || ')',
        'recurring_expense', v_expense.id, 'recognition:' || v_day, COALESCE(v_expense.approved_by, p_user_id),
        jsonb_build_array(
          jsonb_build_object('code', accounting_expense_account(v_expense.category), 'debit', v_amount, 'credit', 0,
            'entity_type', 'expense', 'entity_id', v_expense.id),
          jsonb_build_object('code', accounting_payment_account(v_expense.payment_method::text), 'debit', 0, 'credit', v_amount,
            'entity_type', 'expense', 'entity_id', v_expense.id)
        ));
      IF v_id IS NOT NULL THEN v_count := v_count + 1; END IF;
    END LOOP;
  END LOOP;
  RETURN v_count;
END
$$;

COMMIT;
