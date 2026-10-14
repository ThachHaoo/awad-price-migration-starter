-- Brings price back, filled from price_vnd (thousands of dong, as before).
-- After this down, run ONLY v3 or v4. Both read price_vnd. v1 and v2 read
-- price, and price goes stale again as soon as v4 writes (v4 never writes it);
-- rows with price_vnd NULL also come back with price NULL.
ALTER TABLE menu_items ADD COLUMN price REAL CHECK (price > 0);
UPDATE menu_items SET price = price_vnd / 1000.0;
