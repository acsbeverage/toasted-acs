require('dotenv').config();
const { query } = require('./index');

async function migrate() {
  console.log('Running migrations...');

  await query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    fname TEXT NOT NULL,
    lname TEXT,
    email TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'rep',
    commission NUMERIC(5,2) DEFAULT 5,
    reset_token TEXT,
    reset_expires BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS customer_users (
    id TEXT PRIMARY KEY,
    fname TEXT,
    lname TEXT,
    email TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    acct_id TEXT,
    role TEXT DEFAULT 'customer',
    reset_token TEXT,
    reset_expires BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT, lic TEXT, abc_num TEXT,
    contact TEXT, contact_first TEXT, contact_last TEXT,
    phone TEXT, email TEXT, address TEXT,
    ship_street TEXT, ship_city TEXT, ship_state TEXT, ship_zip TEXT,
    bill_street TEXT, bill_city TEXT, bill_state TEXT, bill_zip TEXT,
    terms TEXT DEFAULT 'Net 30',
    rep TEXT, qbo_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS products (
    sku TEXT PRIMARY KEY, name TEXT NOT NULL,
    producer TEXT, cat TEXT, btl INTEGER DEFAULT 12,
    stock NUMERIC(10,2) DEFAULT 0, reorder INTEGER DEFAULT 6,
    price_frontline NUMERIC(10,4) DEFAULT 0,
    price_mix12 NUMERIC(10,4) DEFAULT 0,
    price_acs3 NUMERIC(10,4) DEFAULT 0,
    price_brand3 NUMERIC(10,4) DEFAULT 0,
    price_brand5 NUMERIC(10,4) DEFAULT 0,
    da_frontline NUMERIC(10,2) DEFAULT 0,
    da_mix12 NUMERIC(10,2) DEFAULT 0,
    da_acs3 NUMERIC(10,2) DEFAULT 0,
    da_brand3 NUMERIC(10,2) DEFAULT 0,
    da_brand5 NUMERIC(10,2) DEFAULT 0,
    redemption_entry TEXT, bottle_size TEXT, upc TEXT,
    fob_price NUMERIC(10,4) DEFAULT 0,
    laid_in_cost NUMERIC(10,4) DEFAULT 0,
    active TEXT DEFAULT 'Yes', core TEXT DEFAULT 'No',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    acct_id TEXT, rep_id TEXT,
    date DATE NOT NULL, delivery DATE,
    status TEXT DEFAULT 'unconfirmed',
    order_type TEXT DEFAULT 'standard',
    po TEXT, notes TEXT,
    is_sample BOOLEAN DEFAULT FALSE,
    waive_delivery BOOLEAN DEFAULT FALSE,
    waive_broken_case BOOLEAN DEFAULT FALSE,
    waive_crv BOOLEAN DEFAULT FALSE,
    paid BOOLEAN DEFAULT FALSE,
    paid_date DATE, paid_amount NUMERIC(10,2),
    qbo_invoice_id TEXT, qbo_synced_at TIMESTAMPTZ, qbo_payment_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
    sku TEXT, cases INTEGER DEFAULT 0, bottles INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'frontline',
    discount_pct NUMERIC(5,2) DEFAULT 0,
    is_fee BOOLEAN DEFAULT FALSE,
    fee_amt NUMERIC(10,2), fee_count INTEGER,
    is_manual BOOLEAN DEFAULT FALSE,
    rate NUMERIC(10,4), sort_order INTEGER DEFAULT 0
  )`);

  await query(`CREATE TABLE IF NOT EXISTS draft_orders (
    id TEXT PRIMARY KEY,
    acct_id TEXT, rep_id TEXT,
    date DATE, delivery DATE,
    po TEXT, notes TEXT,
    saved_at TIMESTAMPTZ DEFAULT NOW(),
    items JSONB DEFAULT '[]'
  )`);

  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT`);

  await query(`CREATE TABLE IF NOT EXISTS tastings (
    id TEXT PRIMARY KEY,
    acct_id TEXT, rep_id TEXT,
    date DATE NOT NULL,
    notes TEXT,
    items JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS shared_docs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL, category TEXT,
    description TEXT, filename TEXT,
    data_url TEXT, size_label TEXT,
    uploaded_by TEXT,
    uploaded_at DATE DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  console.log('All tables created successfully');
}

migrate().then(() => {
  console.log('Migration complete');
  process.exit(0);
}).catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
