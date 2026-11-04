-- 0002: forms library on disk + packet templates that link to forms and remember who added each item.
ALTER TABLE forms ADD COLUMN bytes INTEGER;
ALTER TABLE forms ADD COLUMN pages INTEGER;
ALTER TABLE forms ADD COLUMN fillable INTEGER;                 -- 1 = has AcroForm fields
ALTER TABLE forms ADD COLUMN revision TEXT;                    -- "March 3, 2026" as printed on the UAR form name
ALTER TABLE forms ADD COLUMN missing INTEGER NOT NULL DEFAULT 0; -- file no longer on disk

ALTER TABLE packet_items ADD COLUMN form_id INTEGER REFERENCES forms(id);
ALTER TABLE packet_items ADD COLUMN source TEXT NOT NULL DEFAULT 'exhibit_b'; -- exhibit_b | cory | ai
ALTER TABLE packet_items ADD COLUMN reason TEXT;

ALTER TABLE transaction_packet_items ADD COLUMN form_id INTEGER REFERENCES forms(id);
