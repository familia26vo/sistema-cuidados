CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(160) NOT NULL,
  category VARCHAR(80) NOT NULL DEFAULT 'outro',
  specification_type VARCHAR(20) NOT NULL CHECK (specification_type IN ('liquid', 'tablet', 'unit')),
  specification_value NUMERIC(12,2),
  unit_label VARCHAR(30) NOT NULL,
  current_stock NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  critical_limit NUMERIC(12,2) NOT NULL DEFAULT 5 CHECK (critical_limit >= 0),
  average_daily_consumption NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (average_daily_consumption >= 0),
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  movement_type VARCHAR(20) NOT NULL CHECK (movement_type IN ('entry', 'consumption', 'adjustment')),
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  stock_after NUMERIC(12,2) NOT NULL CHECK (stock_after >= 0),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  supplier VARCHAR(160),
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  purchased_at DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  item_name VARCHAR(160) NOT NULL,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED
);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type VARCHAR(120) NOT NULL,
  file_size BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movements_item_date ON stock_movements(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchased_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_purchase ON attachments(purchase_id);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS inventory_items_updated_at ON inventory_items;
CREATE TRIGGER inventory_items_updated_at BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
