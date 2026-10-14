-- Run ONLY once v4 is running on EVERY instance. v1-v3 still read or write
-- menu_items.price, so any of them left running breaks the moment it is gone.
-- After this, rolling back the code needs 003 down first.
ALTER TABLE menu_items DROP COLUMN price;
