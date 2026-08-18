-- Retire only the system-created disabled placeholder when management has
-- already recorded a genuine activation with an earlier effective date.
-- Deliberate suspensions and disablements are intentionally left unchanged.

UPDATE commission_programmes placeholder
SET effective_to = placeholder.effective_from,
    updated_at = NOW()
WHERE placeholder.status = 'disabled'
  AND placeholder.created_by IS NULL
  AND placeholder.reason = 'Initial KSh 50 commission configuration; activate only after management review.'
  AND (placeholder.effective_to IS NULL OR placeholder.effective_to > placeholder.effective_from)
  AND EXISTS (
    SELECT 1
    FROM commission_programmes activation
    WHERE activation.id <> placeholder.id
      AND activation.status = 'active'
      AND activation.effective_from < placeholder.effective_from
  );
