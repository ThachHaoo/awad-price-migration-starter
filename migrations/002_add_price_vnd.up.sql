ALTER TABLE menu_items ADD COLUMN price_vnd INTEGER
  CHECK (price_vnd IS NULL OR (typeof(price_vnd) = 'integer' AND price_vnd > 0));  -- whole dong: 45500 = 45,500 đ
