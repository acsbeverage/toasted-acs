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

  await query(`CREATE TABLE IF NOT EXISTS account_code_sequence (id INTEGER PRIMARY KEY DEFAULT 1, next_seq INTEGER DEFAULT 100001)`);
  await query(`INSERT INTO account_code_sequence (id, next_seq) VALUES (1, 100001) ON CONFLICT (id) DO NOTHING`);

  await query(`CREATE TABLE IF NOT EXISTS order_code_sequence (id INTEGER PRIMARY KEY DEFAULT 1, next_seq INTEGER DEFAULT 1)`);
  await query(`INSERT INTO order_code_sequence (id, next_seq) VALUES (1, 1) ON CONFLICT (id) DO NOTHING`);

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

  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS comm_frontline NUMERIC(5,2)`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS comm_mix12 NUMERIC(5,2)`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS comm_acs3 NUMERIC(5,2)`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS comm_brand3 NUMERIC(5,2)`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS comm_brand5 NUMERIC(5,2)`);

  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS corp_group TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS qbo_id TEXT`);

  // Address detail
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ship_street2 TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ship_county TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bill_street2 TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bill_county TEXT`);
  // General
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_type TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS allowed_ship_days TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tasting_hours TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS delivery_notes TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS website TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS preferred_payment_method_name TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS show_product_upc BOOLEAN DEFAULT FALSE`);
  // Sales / prospect tracking
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avg_monthly_sales_estimate NUMERIC(10,2)`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS override_avg_monthly_sales BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_prospective BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_sample_account BOOLEAN DEFAULT FALSE`);
  // Tax & legal
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS alternate_license TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS alternate_license_expiry TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS external_identifier_1 TEXT`);
  // Invoicing / delivery
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS prefers_master_invoice BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS allow_orders BOOLEAN DEFAULT TRUE`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cod_email_notifications BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS billing_invoice_title TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS past_due BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS notify_invoice_contacts_ar BOOLEAN DEFAULT TRUE`);

  await query(`CREATE TABLE IF NOT EXISTS account_contacts (
    id SERIAL PRIMARY KEY,
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT, title TEXT, email TEXT, phone TEXT, notes TEXT,
    is_primary BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_account_contacts_acct ON account_contacts(account_id)`);

  await query(`CREATE TABLE IF NOT EXISTS account_attachments (
    id SERIAL PRIMARY KEY,
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    filename TEXT, mime_type TEXT, file_data TEXT, file_size INTEGER,
    uploaded_by TEXT, uploaded_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_account_attachments_acct ON account_attachments(account_id)`);

  await query(`CREATE TABLE IF NOT EXISTS scheduled_invoice_emails (
    id SERIAL PRIMARY KEY,
    order_id TEXT, account_id TEXT,
    recipients TEXT[], subject TEXT, body TEXT,
    pdf_data TEXT, pdf_filename TEXT,
    scheduled_for DATE,
    sent BOOLEAN DEFAULT FALSE, sent_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_invoice_emails_pending ON scheduled_invoice_emails(scheduled_for) WHERE sent=FALSE`);

  await query(`CREATE TABLE IF NOT EXISTS qbo_connection (
    id INTEGER PRIMARY KEY DEFAULT 1,
    access_token TEXT,
    refresh_token TEXT,
    realm_id TEXT,
    company_name TEXT,
    environment TEXT DEFAULT 'sandbox',
    token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
  )`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS labels_printed BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS partial_paid_amount NUMERIC(10,2)`);

  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS vintage TEXT`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS warehouse TEXT DEFAULT 'main'`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS restricted BOOLEAN DEFAULT FALSE`);

  await query(`CREATE TABLE IF NOT EXISTS product_tier_prices (
    id SERIAL PRIMARY KEY,
    sku TEXT NOT NULL REFERENCES products(sku) ON DELETE CASCADE,
    tier_name TEXT NOT NULL,
    price NUMERIC(10,4) DEFAULT 0,
    da_amount NUMERIC(10,4) DEFAULT 0,
    rep_visible BOOLEAN DEFAULT FALSE,
    sort_order INTEGER DEFAULT 100,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(sku, tier_name)
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ptp_sku ON product_tier_prices(sku)`);
  await query(`ALTER TABLE product_tier_prices ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE`);
  await query(`ALTER TABLE product_tier_prices DROP CONSTRAINT IF EXISTS product_tier_prices_sku_tier_name_key`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ptp_account ON product_tier_prices(account_id)`);
  await query(`ALTER TABLE product_tier_prices ADD COLUMN IF NOT EXISTS account_ids TEXT[] DEFAULT '{}'`);
  await query(`ALTER TABLE product_tier_prices ADD COLUMN IF NOT EXISTS corp_groups TEXT[] DEFAULT '{}'`);
  await query(`UPDATE product_tier_prices SET account_ids = ARRAY[account_id] WHERE account_id IS NOT NULL AND (account_ids IS NULL OR account_ids = '{}')`);

  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pricing_admin BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS region TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kind_primary TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kind_secondary TEXT`);

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

  await query(`CREATE TABLE IF NOT EXISTS po_suppliers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    payment_terms TEXT DEFAULT 'Net 30',
    contact_name TEXT, contact_email TEXT, contact_phone TEXT,
    address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS po_products (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES po_suppliers(id) ON DELETE CASCADE,
    brand_name TEXT, vintage TEXT, type TEXT DEFAULT 'Spirits',
    bottle_size TEXT DEFAULT '750ml', bottles_per_case INTEGER DEFAULT 6,
    description TEXT NOT NULL,
    case_price NUMERIC(10,2) DEFAULT 0, bottle_price NUMERIC(10,2) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id SERIAL PRIMARY KEY,
    po_number TEXT UNIQUE,
    po_date DATE DEFAULT CURRENT_DATE,
    payment_terms TEXT,
    supplier_id INTEGER REFERENCES po_suppliers(id),
    delivery_address TEXT,
    total_bottles INTEGER DEFAULT 0,
    total_cases NUMERIC(10,2) DEFAULT 0,
    grand_total NUMERIC(10,2) DEFAULT 0,
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS po_line_items (
    id SERIAL PRIMARY KEY,
    po_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id INTEGER,
    brand_name TEXT, vintage TEXT, type TEXT, bottle_size TEXT, bottles_per_case INTEGER,
    description TEXT,
    quantity_bottles INTEGER DEFAULT 0, quantity_cases NUMERIC(10,2) DEFAULT 0,
    case_price NUMERIC(10,2), bottle_price NUMERIC(10,2),
    line_total NUMERIC(10,2) DEFAULT 0,
    is_no_charge BOOLEAN DEFAULT FALSE,
    sort_order INTEGER DEFAULT 0
  )`);

  await query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS email_status TEXT DEFAULT 'pending'`);
  await query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ`);

  await query(`CREATE TABLE IF NOT EXISTS po_sequence (id INTEGER PRIMARY KEY DEFAULT 1, next_seq INTEGER DEFAULT 1)`);
  await query(`INSERT INTO po_sequence (id, next_seq) VALUES (1, 1) ON CONFLICT (id) DO NOTHING`);

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
