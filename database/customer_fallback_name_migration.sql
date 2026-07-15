UPDATE customers
SET name = 'Customer ' ||
  CASE
    WHEN normalized_phone ~ '^254[17][0-9]{8}$' THEN
      '0' || SUBSTRING(normalized_phone FROM 4 FOR 2) || '****' || RIGHT(normalized_phone, 4)
    WHEN regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') ~ '^0[17][0-9]{8}$' THEN
      LEFT(regexp_replace(phone, '[^0-9]', '', 'g'), 2) || '****' || RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 4)
    ELSE
      LEFT(regexp_replace(COALESCE(phone, normalized_phone, ''), '[^0-9]', '', 'g'), 2) || '****' || RIGHT(regexp_replace(COALESCE(phone, normalized_phone, ''), '[^0-9]', '', 'g'), 4)
  END,
  updated_at = NOW()
WHERE name ~ '^Customer ending [0-9]{4}$'
  AND COALESCE(normalized_phone, phone, '') <> '';
