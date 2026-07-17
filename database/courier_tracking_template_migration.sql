ALTER TABLE couriers
  ADD COLUMN IF NOT EXISTS tracking_url_template TEXT;

UPDATE couriers
SET tracking_url_template = 'https://parcelsapp.com/en/tracking/{tracking_number}'
WHERE LOWER(name) LIKE '%speedaf%'
  AND COALESCE(tracking_url_template, '') = '';
