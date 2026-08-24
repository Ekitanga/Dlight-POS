\set ON_ERROR_STOP on
BEGIN;

UPDATE accounting_settings
SET enabled = TRUE, cutover_date = CURRENT_DATE
WHERE singleton_key = TRUE;

SELECT post_accounting_journal(
  CURRENT_DATE,
  'Trial balance smoke test',
  'smoke_test',
  '00000000-0000-0000-0000-000000000099',
  'balanced_entry',
  NULL,
  '[
    {"code":"1000","debit":125.50,"credit":0,"memo":"Smoke-test debit"},
    {"code":"3000","debit":0,"credit":125.50,"memo":"Smoke-test credit"}
  ]'::jsonb
) AS journal_id;

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  v_debits NUMERIC;
  v_credits NUMERIC;
BEGIN
  SELECT SUM(jl.debit), SUM(jl.credit)
    INTO v_debits, v_credits
  FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.journal_entry_id
  WHERE je.source_type='smoke_test'
    AND je.source_id='00000000-0000-0000-0000-000000000099';
  IF v_debits <> 125.50 OR v_credits <> 125.50 THEN
    RAISE EXCEPTION 'Unexpected smoke-test totals: debit %, credit %', v_debits, v_credits;
  END IF;
END
$$;

ROLLBACK;
