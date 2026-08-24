BEGIN;

-- A completed sale can be corrected back to an active workflow stage and
-- completed again later. Each completion cycle needs its own immutable journal
-- pair; reusing sale_recognized would return the already-reversed first entry.
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
  v_cycle INTEGER;
  v_recognition_event TEXT;
  v_reversal_event TEXT;
  v_actor UUID;
BEGIN
  v_actor := NULLIF(current_setting('dlight.current_user_id', TRUE), '')::uuid;
  v_actor := COALESCE(v_actor, NEW.cancelled_by, NEW.commission_completion_by, NEW.created_by);

  IF OLD.status IN ('delivered', 'collected_paid') AND NEW.status NOT IN ('delivered', 'collected_paid') THEN
    IF NEW.status IN ('returned', 'cancelled') THEN
      FOR v_refund IN SELECT id, created_by FROM order_refunds
        WHERE order_id=NEW.id AND status='pending'
      LOOP
        PERFORM reverse_accounting_journal('order_refund', v_refund.id, 'refund_due',
          'converted_to_sale_reversal', CURRENT_DATE, 'Refund liability converted by full sale reversal',
          COALESCE(v_actor, v_refund.created_by));
      END LOOP;
    END IF;

    SELECT COUNT(*)::int INTO v_cycle
    FROM journal_entries
    WHERE source_type = 'order' AND source_id = NEW.id
      AND source_event ~ '^sale_recognized(_[0-9]+)?$';

    IF v_cycle > 0 THEN
      v_recognition_event := CASE WHEN v_cycle = 1 THEN 'sale_recognized' ELSE 'sale_recognized_' || v_cycle END;
      v_reversal_event := CASE WHEN v_cycle = 1 THEN 'sale_reversed' ELSE 'sale_reversed_' || v_cycle END;
      PERFORM reverse_accounting_journal('order', NEW.id, v_recognition_event, v_reversal_event,
        CURRENT_DATE, 'Reversed sale ' || NEW.order_number || ' after status correction', v_actor);
    END IF;
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

  SELECT COUNT(*)::int + 1 INTO v_cycle
  FROM journal_entries
  WHERE source_type = 'order' AND source_id = NEW.id
    AND source_event ~ '^sale_recognized(_[0-9]+)?$';
  v_recognition_event := CASE WHEN v_cycle = 1 THEN 'sale_recognized' ELSE 'sale_recognized_' || v_cycle END;

  PERFORM post_accounting_journal(CURRENT_DATE, 'Sale recognized for ' || NEW.order_number,
    'order', NEW.id, v_recognition_event, v_actor, v_lines);
  RETURN NEW;
END
$$;

COMMIT;
