const router = require('express').Router();
const ExcelJS = require('exceljs');
const sgMail = require('@sendgrid/mail');
const { query, getOne, getAll } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const FROM_EMAIL = process.env.FROM_EMAIL || 'accounting@acsbeverage.com';
const FROM_NAME = process.env.FROM_NAME || 'Toasted -- ACS Beverage Co.';

// ─── DATE RANGE HELPERS ───────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().slice(0, 10); }
function plusDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function resolveDateRange(sched) {
  if (sched.dateRange === 'custom') return { from: sched.customFrom, to: sched.customTo };
  const today = todayStr();
  switch (sched.dateRange) {
    case 'rolling7': return { from: plusDays(today, -7), to: today };
    case 'rolling30': return { from: plusDays(today, -30), to: today };
    case 'mtd': return { from: today.slice(0, 8) + '01', to: today };
    case 'lastMonth': {
      const d = new Date(today); d.setDate(1); d.setDate(d.getDate() - 1);
      const lastMonthEnd = d.toISOString().slice(0, 10);
      const lastMonthStart = lastMonthEnd.slice(0, 8) + '01';
      return { from: lastMonthStart, to: lastMonthEnd };
    }
    case 'ytd': return { from: today.slice(0, 4) + '-01-01', to: today };
    case 'all': return { from: null, to: null };
    default: return { from: plusDays(today, -30), to: today };
  }
}
// Next send date after "today" matching the schedule's frequency/day settings -- mirrors the
// frontend's calcNextSend so schedules created or edited from either side stay consistent.
function calcNextSend(freq, dayOfWeek, dayOfMonth, time) {
  const now = new Date();
  const [hh, mm] = (time || '08:00').split(':').map(Number);
  let next = new Date(now);
  if (freq === 'monthly') {
    next.setDate(dayOfMonth || 1);
    next.setHours(hh || 8, mm || 0, 0, 0);
    if (next <= now) next.setMonth(next.getMonth() + 1);
  } else {
    const targetDow = dayOfWeek ?? 1;
    next.setHours(hh || 8, mm || 0, 0, 0);
    let daysUntil = (targetDow - next.getDay() + 7) % 7;
    if (daysUntil === 0 && next <= now) daysUntil = freq === 'biweekly' ? 14 : 7;
    next.setDate(next.getDate() + daysUntil);
  }
  return next.toISOString().slice(0, 10);
}

// ─── REPORT DATA GENERATION (server-side, direct from the database) ──────
// Each of these returns { headers: [...], rows: [[...], ...] } ready for the Excel writer.
// Standard pricing tier display names -- account-specific custom pricing lanes use their own
// tier name directly (falls through to the raw value), matching how the frontend does this.
const TIER_LABELS = {
  frontline: 'Frontline', mix12: '12 Btl Mix', acs3: '3 Case ACS',
  brand3: '3 Case Brand Family', brand5: '5 Case Brand Family',
};
const STANDARD_PRICE_COL = {
  frontline: 'price_frontline', mix12: 'price_mix12', acs3: 'price_acs3',
  brand3: 'price_brand3', brand5: 'price_brand5',
};
const STANDARD_DA_COL = {
  frontline: 'da_frontline', mix12: 'da_mix12', acs3: 'da_acs3',
  brand3: 'da_brand3', brand5: 'da_brand5',
};
// Shared SQL for custom-lane price/DA lookups. Mirrors the frontend's laneApplies(): a lane
// with no account_ids/corp_groups applies to everyone; otherwise only if this order's account,
// or its corp group, is listed. Requires oi (order_items), o (orders), a (accounts, LEFT JOINed)
// to be aliased exactly this way in the enclosing query.
function customLaneSubq(col) {
  return `(SELECT ptp.${col} FROM product_tier_prices ptp
     WHERE ptp.sku = oi.sku AND ptp.tier_name = oi.tier
       AND (
         (cardinality(ptp.account_ids)=0 AND cardinality(ptp.corp_groups)=0)
         OR o.acct_id = ANY(ptp.account_ids)
         OR (a.corp_group IS NOT NULL AND a.corp_group = ANY(ptp.corp_groups))
       )
     ORDER BY (cardinality(ptp.account_ids)>0 OR cardinality(ptp.corp_groups)>0) DESC LIMIT 1)`;
}
// Per-bottle price for a product order-item row, matching the frontend's itemUnitPrice(): a
// manual/imported line uses its own preserved rate; otherwise the standard tier price column,
// or a matching custom pricing lane. Row must carry is_manual, rate, tier, the five
// price_<tier> columns, and a custom_price column (via customLaneSubq('price')).
function resolvePriceBtl(r) {
  if (r.is_manual && r.rate !== null && r.rate !== undefined) return parseFloat(r.rate);
  if (STANDARD_PRICE_COL[r.tier]) return parseFloat(r[STANDARD_PRICE_COL[r.tier]] || 0);
  return parseFloat(r.custom_price || 0);
}
// Per-bottle DA (bill-back) for a product order-item row: a matching custom lane's da_amount,
// otherwise the standard per-tier DA column. Row must carry tier, the five da_<tier> columns,
// and a custom_da column (via customLaneSubq('da_amount')).
function resolveDaBtl(r) {
  if (r.custom_da !== null && r.custom_da !== undefined) return parseFloat(r.custom_da);
  return parseFloat(r[STANDARD_DA_COL[r.tier]] || 0);
}
// Discount-adjusted line total, matching itemLineTotal() for a non-fee product line.
function lineTotal(qtyBottles, priceBtl, discountPct) {
  const disc = Math.min(Math.max(parseFloat(discountPct) || 0, 0), 100);
  return qtyBottles * priceBtl * (1 - disc / 100);
}

async function buildRA5(from, to, producers) {
  // One row per order line item, matching the real RA5 export -- not an aggregated summary.
  // Custom-lane price/DA lookups mirror the frontend's laneApplies() scoping: a lane with no
  // account_ids/corp_groups applies to everyone; otherwise it applies only if this specific
  // account, or this account's corp group, is listed. Scoped matches are preferred over an
  // unscoped fallback with the same tier name via the ORDER BY tiebreak.
  const rows = await getAll(
    `SELECT p.name as wine_name, p.sku as wine_code, p.vintage, p.producer, p.cat, p.btl, p.bottle_size,
            p.fob_price, p.comm_frontline,
            p.price_frontline, p.price_mix12, p.price_acs3, p.price_brand3, p.price_brand5,
            p.da_frontline, p.da_mix12, p.da_acs3, p.da_brand3, p.da_brand5,
            a.name as account_name, a.lic as abc_number, a.ship_street, a.ship_city, a.ship_state, a.ship_zip, a.id as account_id, a.corp_group,
            u.fname as rep_fname, u.lname as rep_lname,
            o.id as invoice_number, o.po as po_number, o.date, o.is_sample, o.notes as order_notes,
            oi.cases, oi.bottles, oi.rate, oi.tier, oi.notes as line_notes, oi.discount_pct, oi.is_manual,
            ${customLaneSubq('price')} as custom_price,
            ${customLaneSubq('da_amount')} as custom_da
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     JOIN products p ON oi.sku = p.sku
     LEFT JOIN accounts a ON o.acct_id = a.id
     LEFT JOIN users u ON o.rep_id = u.id
     WHERE o.status='delivered' AND oi.is_fee=FALSE
       AND ($1::date IS NULL OR o.date >= $1) AND ($2::date IS NULL OR o.date <= $2)
       AND ($3::text[] IS NULL OR p.producer = ANY($3))
     ORDER BY p.name, o.date`,
    [from || null, to || null, (producers && producers.length) ? producers : null]
  );

  const headers = [
    'Wine Name', 'Wine Code', 'Vintage', 'Producer', 'Account', 'Sales Rep', 'Date',
    'Quantity', 'Unit Price', 'Total', 'Notes', 'Invoice Number', 'PO Number',
    'Warehouse', 'Sample Order', 'Bill Back Amount', 'Bill Back Total',
    'Price Label', 'ABC Number',
    'Shipping Street', 'Shipping City', 'Shipping State', 'Shipping Zip Code',
    'FOB Price', 'Account ID', 'Bottle Size', 'Pack Size', 'Wine Category',
  ];
  const out = rows.map(r => {
    const qty = (r.cases || 0) + (r.bottles || 0) / (r.btl || 1); // case-equivalent, matching the fractional format the real report uses
    const priceBtl = resolvePriceBtl(r);
    const unitPrice = priceBtl * (r.btl || 1); // per-case price
    const disc = Math.min(Math.max(parseFloat(r.discount_pct) || 0, 0), 100);
    const total = qty * unitPrice * (1 - disc / 100); // matches itemLineTotal's discount handling
    const priceLabel = TIER_LABELS[r.tier] || r.tier || '';
    // DA (Bill Back): prefer a matching custom pricing lane's rate, otherwise fall back to
    // the standard per-tier DA column on the product itself.
    const daPerBottle = resolveDaBtl(r);
    const billBackAmount = daPerBottle * (r.btl || 1); // per case, matching Unit Price's convention
    const billBackTotal = billBackAmount * qty;
    return [
      r.wine_name, r.wine_code, r.vintage || '', r.producer,
      r.account_name || '', r.rep_fname ? (r.rep_fname + ' ' + (r.rep_lname || '')) : '',
      r.date ? r.date.toISOString().slice(0, 10) : '',
      Number(qty.toFixed(4)), Number(unitPrice.toFixed(2)), Number(total.toFixed(2)),
      r.line_notes || r.order_notes || '', r.invoice_number, r.po_number || '',
      'ACS Warehouse', r.is_sample ? 'Yes' : 'No',
      Number(billBackAmount.toFixed(2)), Number(billBackTotal.toFixed(2)),
      priceLabel, r.abc_number || '',
      r.ship_street || '', r.ship_city || '', r.ship_state || '', r.ship_zip || '',
      parseFloat(r.fob_price || 0), r.account_id || '', r.bottle_size || '', r.btl, r.cat || '',
    ];
  });
  return { headers, rows: out };
}

async function buildRBInventory(sched) {
  const producers = sched.producers || [];
  const rows = await getAll(
    `SELECT sku, name, vintage, cat, producer, stock
     FROM products
     WHERE COALESCE(warehouse,'main')<>'acs_logistics'
       AND ($1::text[] IS NULL OR producer = ANY($1))
     ORDER BY producer, name`,
    [producers.length ? producers : null]
  );
  const invHeaders = [
    'Code', 'Name', 'Vintage', 'Product Type', 'Producer', 'Warehouse', 'BIN location',
    'On Hand', 'On Hold', 'On Future', 'Pending Sync', 'Available', 'On Order', 'On Transfer',
  ];
  const invRows = rows.map(p => {
    const onHand = Number(parseFloat(p.stock).toFixed(2));
    return [
      p.sku, p.name, p.vintage || '', p.cat || '', p.producer, 'ACS Warehouse', '',
      onHand, 0, 0, 0, onHand, 0, 0, // Toasted has no hold/future/pending-sync/on-order/transfer tracking -- always 0
    ];
  });

  const reportName = sched.type === 'RB1' ? 'InventoryBySupplier' : 'InventoryByProducer';
  const filterRows = [
    ['Producers', producers.length ? producers.join(', ') : 'All'],
    ['Warehouses', 'ACS Warehouse'],
    ['Wine Status', 'All Wines'],
    ['Include active prices?', 'No'],
    ['Include "Delivery Fee" and "Duty" columns?', 'No'],
    ['Include non-inventory items?', 'No'],
    ['Include pre-sale allocations?', 'No'],
    ['Use simplified version?', 'No'],
    ['Include disabled warehouses?', 'No'],
    ['Report At', new Date().toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })],
    ['Report Name', reportName],
    ['Organization', 'ACS Beverage Co.'],
  ];

  return {
    sheets: [
      { name: 'Inventory', headers: invHeaders, rows: invRows },
      { name: 'Filters', headers: ['Filters', ''], rows: filterRows },
    ],
    rows: invRows, // kept for the row-count shown in the confirmation email
  };
}

// Computes the true order total (sum of all line items, fees included) for a set of order ids,
// using the same per-line pricing resolution as RA5 (manual rate / standard tier / custom lane)
// and the same fixed-fee handling as itemLineTotal() on the frontend. Returns a Map keyed by
// order id. Used by RA2 (per-line "Invoice Balance Due") and RI2 (open AR).
async function computeOrderTotals(orderIds) {
  if (!orderIds.length) return new Map();
  const items = await getAll(
    `SELECT oi.order_id, oi.sku, oi.cases, oi.bottles, oi.tier, oi.discount_pct, oi.is_manual, oi.rate,
            oi.is_fee, oi.fee_amt, oi.fee_count,
            p.btl, p.price_frontline, p.price_mix12, p.price_acs3, p.price_brand3, p.price_brand5,
            o.acct_id, a.corp_group,
            ${customLaneSubq('price')} as custom_price
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     LEFT JOIN products p ON oi.sku = p.sku
     LEFT JOIN accounts a ON o.acct_id = a.id
     WHERE oi.order_id = ANY($1)`,
    [orderIds]
  );
  const totals = new Map();
  for (const it of items) {
    let amt = 0;
    if (it.is_fee) {
      if (it.sku === '__DELIVERY__') amt = parseFloat(it.fee_amt ?? 6.00);
      else if (it.sku === '__BROKEN_CASE__') amt = parseFloat(it.fee_amt ?? 1.50) * (it.fee_count || 1);
      else amt = parseFloat(it.fee_amt || 0); // __CRV__ and any other fee line: fee_amt is already the total
    } else if (it.btl) { // skip lines whose product no longer exists
      const qtyBottles = (it.cases || 0) * it.btl + (it.bottles || 0);
      amt = lineTotal(qtyBottles, resolvePriceBtl(it), it.discount_pct);
    }
    totals.set(it.order_id, (totals.get(it.order_id) || 0) + amt);
  }
  return totals;
}

// ─── RA2 -- Invoice Line Item (Detailed Sales) ────────────────────────────
async function buildRA2(from, to, producers) {
  const orders = await getAll(
    `SELECT o.id, o.date, o.delivery, o.paid_date, o.notes as order_notes, o.po, o.acct_id, o.is_sample,
            a.corp_group, a.name as acct_name, a.ship_street, a.ship_street2, a.ship_city, a.ship_state, a.ship_zip,
            a.region, a.kind_primary, a.delivery_notes,
            u.fname as rep_fname, u.lname as rep_lname
     FROM orders o
     LEFT JOIN accounts a ON o.acct_id = a.id
     LEFT JOIN users u ON o.rep_id = u.id
     WHERE o.status IN ('delivered','confirmed')
       AND ($1::date IS NULL OR o.date >= $1) AND ($2::date IS NULL OR o.date <= $2)
     ORDER BY o.date`,
    [from || null, to || null]
  );
  if (!orders.length) return { headers: [], rows: [] };
  const orderIds = orders.map(o => o.id);
  const ordersById = new Map(orders.map(o => [o.id, o]));

  const items = await getAll(
    `SELECT oi.order_id, oi.sku, oi.cases, oi.bottles, oi.tier, oi.discount_pct, oi.is_manual, oi.rate, oi.notes as line_notes,
            p.name as product_name, p.producer, p.btl, p.bottle_size, p.cat,
            p.price_frontline, p.price_mix12, p.price_acs3, p.price_brand3, p.price_brand5,
            o.acct_id, a.corp_group, ${customLaneSubq('price')} as custom_price
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     JOIN products p ON oi.sku = p.sku
     LEFT JOIN accounts a ON o.acct_id = a.id
     WHERE oi.order_id = ANY($1) AND oi.is_fee = FALSE
       AND ($2::text[] IS NULL OR p.producer = ANY($2))
     ORDER BY o.date`,
    [orderIds, (producers && producers.length) ? producers : null]
  );

  const orderTotals = await computeOrderTotals(orderIds);

  const headers = [
    'Invoice #', 'Order Date', 'Delivery Date', 'Paid Date', 'Corp Group', 'Account',
    'Street 1', 'Street 2', 'City', 'State', 'Zip', 'Sales Rep', 'Region',
    'Wine Code', 'Wine', 'Producer', 'Quantity', 'Cases', 'Bottles',
    'Price Label', 'Unit Price', 'Sub-Total', 'Discount', 'Line Item Total', 'Invoice Balance Due',
    'Notes', 'Delivery Instructions', 'Sample Order?', 'Total Liters', 'Total Gallons',
    'PO Number', 'All Account Sales Reps', 'Private Note', 'Premise', 'Bottle Size', 'Unit Set', 'Product Type',
  ];
  const rows = items.map(it => {
    const o = ordersById.get(it.order_id) || {};
    const priceBtl = resolvePriceBtl(it);
    const totalBtl = (it.cases || 0) * (it.btl || 1) + (it.bottles || 0);
    const subTotal = priceBtl * totalBtl;
    const total = lineTotal(totalBtl, priceBtl, it.discount_pct);
    const totalLiters = totalBtl * bottleSizeToLiters(it.bottle_size);
    const totalGallons = totalLiters * 0.264172;
    const qty = (it.cases || 0) + (it.bottles > 0 ? it.bottles / (it.btl || 1) : 0);
    const repName = o.rep_fname ? (o.rep_fname + ' ' + (o.rep_lname || '')) : '';
    const balanceDue = orderTotals.get(it.order_id) || 0;
    return [
      it.order_id,
      o.date ? o.date.toISOString().slice(0, 10) : '',
      o.delivery ? o.delivery.toISOString().slice(0, 10) : '',
      o.paid_date ? o.paid_date.toISOString().slice(0, 10) : '',
      o.corp_group || '', o.acct_name || '',
      o.ship_street || '', o.ship_street2 || '', o.ship_city || '', o.ship_state || '', o.ship_zip || '',
      repName, o.region || '',
      it.sku, it.product_name, it.producer || '',
      Number(qty.toFixed(4)), it.cases || 0, it.bottles || 0,
      TIER_LABELS[it.tier] || it.tier || '', Number(priceBtl.toFixed(2)), Number(subTotal.toFixed(2)),
      parseFloat(it.discount_pct) || 0, Number(total.toFixed(2)), Number(balanceDue.toFixed(2)),
      it.line_notes || o.order_notes || '',
      (o.order_notes && o.order_notes.trim()) ? o.order_notes.trim() : (o.delivery_notes || ''),
      o.is_sample ? 'Yes' : '',
      Number(totalLiters.toFixed(2)), Number(totalGallons.toFixed(2)),
      o.po || '', repName, '',
      o.kind_primary || '', it.bottle_size || '', it.btl, it.cat || '',
    ];
  });
  return { headers, rows };
}

// ─── RA40 -- CRV Redemption Entry Sales ───────────────────────────────────
const CRV_RATE_BY_ENTRY = {
  'CA CRV (24oz and over)': 0.10,
  'CA CRV CAN (under 24oz)': 0.05,
  'CA CRV (under 24oz)': 0.05,
};
const CRV_CODE_MAP = {
  'CA CRV (24oz and over)': 'CACRV24oz+',
  'CA CRV (under 24oz)': 'CACRV24-',
  'CA CRV CAN (under 24oz)': 'CA CRV CAN (<24oz)',
};
async function buildRA40(from, to, producers) {
  const rows = await getAll(
    `SELECT p.redemption_entry, oi.cases, oi.bottles, p.btl
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     JOIN products p ON oi.sku = p.sku
     WHERE o.status IN ('delivered','confirmed') AND oi.is_fee = FALSE
       AND ($1::date IS NULL OR o.date >= $1) AND ($2::date IS NULL OR o.date <= $2)
       AND ($3::text[] IS NULL OR p.producer = ANY($3))`,
    [from || null, to || null, (producers && producers.length) ? producers : null]
  );
  const byType = {};
  let totalSales = 0, totalQty = 0;
  for (const r of rows) {
    const rate = CRV_RATE_BY_ENTRY[r.redemption_entry];
    if (!rate) continue; // not a CRV-eligible product
    const btl = (r.cases || 0) * (r.btl || 1) + (r.bottles || 0);
    const crv = btl * rate;
    if (!byType[r.redemption_entry]) byType[r.redemption_entry] = { sales: 0, qty: 0 };
    byType[r.redemption_entry].sales += crv;
    byType[r.redemption_entry].qty += btl;
    totalSales += crv; totalQty += btl;
  }
  const headers = ['Supplier', 'Code', 'Total Sales', 'Total Quantity'];
  const companyName = 'ACS Beverage Co. LLC';
  const out = [[companyName, '', Number(totalSales.toFixed(2)), totalQty]];
  Object.entries(byType)
    .sort((a, b) => b[1].sales - a[1].sales)
    .forEach(([entry, v]) => out.push(['', CRV_CODE_MAP[entry] || entry, Number(v.sales.toFixed(2)), v.qty]));
  out.push(['Total', '', Number(totalSales.toFixed(2)), totalQty]);
  return { headers, rows: out };
}

// ─── RC12 -- Samples ───────────────────────────────────────────────────────
async function buildRC12(from, to, producers) {
  const rows = await getAll(
    `SELECT o.id as invoice, o.date, a.name as acct_name,
            u.fname as rep_fname, u.lname as rep_lname,
            oi.sku, oi.cases, oi.bottles, oi.notes as line_notes, o.notes as order_notes,
            p.name as product_name, p.producer, p.btl,
            p.price_frontline, p.da_frontline, p.fob_price, p.laid_in_cost
     FROM orders o
     LEFT JOIN accounts a ON o.acct_id = a.id
     LEFT JOIN users u ON o.rep_id = u.id
     JOIN order_items oi ON oi.order_id = o.id
     JOIN products p ON oi.sku = p.sku
     WHERE oi.is_fee = FALSE
       AND (o.is_sample = TRUE OR o.order_type = 'sample'
            OR COALESCE(a.is_sample_account, FALSE) = TRUE OR a.name ~* '^samples?\\y')
       AND ($1::date IS NULL OR o.date >= $1) AND ($2::date IS NULL OR o.date <= $2)
       AND ($3::text[] IS NULL OR p.producer = ANY($3))
     ORDER BY a.name, o.date`,
    [from || null, to || null, (producers && producers.length) ? producers : null]
  );
  const headers = [
    'Invoice', 'Date', 'Account', 'Sales Rep', 'Wine Code', 'Product', 'Supplier',
    'Qty (cs)', 'Qty (btl)', 'Default Price', 'FOB Price', 'Laid-In Cost',
    'Sample Bill Back', 'Total Bill Back', 'Total Sample Price', 'Total FOB Price', 'Notes',
  ];
  const out = rows.map(r => {
    const qtyCases = (r.cases || 0) + (r.bottles > 0 ? r.bottles / (r.btl || 12) : 0);
    const qtyBottles = (r.cases || 0) * (r.btl || 12) + (r.bottles || 0);
    const defaultPrice = parseFloat(r.price_frontline || 0) * (r.btl || 1);
    const fobPrice = parseFloat(r.fob_price || 0);
    const laidInCost = parseFloat(r.laid_in_cost || 0);
    const sampleBillBack = parseFloat(r.da_frontline || 0) * (r.btl || 1);
    const totalSampleBillBack = sampleBillBack * qtyCases;
    const totalSamplePrice = defaultPrice * qtyCases;
    const totalFobPrice = fobPrice * (r.btl || 1) * qtyCases;
    const repName = r.rep_fname ? (r.rep_fname + ' ' + (r.rep_lname || '')) : '';
    return [
      r.invoice, r.date ? r.date.toISOString().slice(0, 10) : '', r.acct_name || '', repName,
      r.sku, r.product_name, r.producer || '',
      Number(qtyCases.toFixed(2)), qtyBottles,
      Number(defaultPrice.toFixed(2)), Number(fobPrice.toFixed(2)), Number(laidInCost.toFixed(2)),
      Number(sampleBillBack.toFixed(2)), Number(totalSampleBillBack.toFixed(2)),
      Number(totalSamplePrice.toFixed(2)), Number(totalFobPrice.toFixed(2)),
      r.line_notes || r.order_notes || '',
    ];
  });
  return { headers, rows: out };
}

// ─── RI2 -- Open / Past Due Invoices ──────────────────────────────────────
async function buildRI2() {
  const orders = await getAll(
    `SELECT o.id, o.date, o.delivery, o.acct_id, o.partial_paid_amount,
            a.name as acct_name, a.terms,
            u.fname as rep_fname, u.lname as rep_lname
     FROM orders o
     LEFT JOIN accounts a ON o.acct_id = a.id
     LEFT JOIN users u ON o.rep_id = u.id
     WHERE o.status='delivered' AND o.paid=FALSE`
  );
  if (!orders.length) return { headers: [], rows: [] };
  const orderIds = orders.map(o => o.id);
  const orderTotals = await computeOrderTotals(orderIds);
  const today_ = todayStr();

  const withDue = orders.map(o => {
    const terms = o.terms || 'Net 30';
    const days = parseInt(terms.replace(/\D/g, '')) || 30;
    const baseDate = (o.delivery || o.date).toISOString().slice(0, 10);
    const dueDate = plusDays(baseDate, days);
    const total = orderTotals.get(o.id) || 0;
    const received = parseFloat(o.partial_paid_amount) || 0;
    return { o, terms, dueDate, total, received, balanceDue: total - received };
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const headers = ['Invoice', 'Invoice Date', 'Account', 'Rep', 'Terms', 'Due Date', 'Days', 'Total Due', 'Received', 'Balance Due', 'Status'];
  const rows = withDue.map(({ o, terms, dueDate, total, received, balanceDue }) => {
    const pastDue = dueDate < today_;
    const daysOut = Math.round((new Date(dueDate) - new Date(today_)) / 86400000);
    const status = received > 0 ? 'PARTIAL' : (pastDue ? 'PAST DUE' : 'OPEN');
    const repName = o.rep_fname ? (o.rep_fname + ' ' + (o.rep_lname || '')) : '';
    return [
      o.id, o.date.toISOString().slice(0, 10), o.acct_name || '', repName, terms, dueDate,
      daysOut, Number(total.toFixed(2)), Number(received.toFixed(2)), Number(balanceDue.toFixed(2)), status,
    ];
  });
  return { headers, rows };
}

// ─── FINTECH -- Export Orders to Fintech ──────────────────────────────────
// Ported from doExportFintech() on the frontend, using that function's default settings
// (delivery-date mode, confirmed/delivered orders only, Fintech provider, cases mode,
// rounded, account name as Vendor_store_id) since there's no UI for a scheduled run to
// pick options from.
// CAVEAT: unlike RA40 (which derives CRV straight from each product's redemption_entry and
// is fully accurate), the stored __CRV__ fee line only keeps a per-bottle rate, not which
// specific CRV entry produced it -- the frontend sets a "label" on that fee item, but
// order_items has no column for it, so it's never actually persisted. Rates of 0.05 apply to
// two different entries ("CA CRV (under 24oz)" and "CA CRV CAN (under 24oz)"), which can't be
// told apart from the stored row alone, so a 0.05 line is labeled CACRV24- here as a
// best-effort default -- exactly matching manual export in the 0.10 case, and correct for the
// common (bottle, not can) case at 0.05.
async function buildFintech(from, to) {
  const items = await getAll(
    `SELECT o.id, o.date, o.delivery, o.po, o.acct_id, a.name as acct_name, a.terms,
            oi.sku, oi.cases, oi.bottles, oi.tier, oi.discount_pct, oi.is_manual, oi.rate, oi.sort_order,
            oi.is_fee, oi.fee_amt, oi.fee_count,
            p.name as product_name, p.btl,
            p.price_frontline, p.price_mix12, p.price_acs3, p.price_brand3, p.price_brand5,
            a.corp_group,
            ${customLaneSubq('price')} as custom_price
     FROM orders o
     LEFT JOIN accounts a ON o.acct_id = a.id
     JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN products p ON oi.sku = p.sku
     WHERE o.status IN ('confirmed','delivered')
       AND LOWER(COALESCE(a.payment_provider,'')) = 'fintech'
       AND ($1::date IS NULL OR o.delivery >= $1) AND ($2::date IS NULL OR o.delivery <= $2)
     ORDER BY o.id, oi.sort_order`,
    [from || null, to || null]
  );
  if (!items.length) return { headers: [], rows: [] };

  const fmtDateMDY = d => {
    if (!d) return '';
    const iso = (d instanceof Date) ? d.toISOString().slice(0, 10) : d;
    const [y, m, dd] = iso.split('-');
    return `${m}/${dd}/${y}`;
  };

  const byOrder = new Map();
  for (const it of items) {
    if (!byOrder.has(it.id)) byOrder.set(it.id, { order: it, lines: [] });
    byOrder.get(it.id).lines.push(it);
  }

  const headers = ['invoice_number', 'Vendor_store_id', 'invoice_date', 'invoice_due_date', 'po_number', 'quantity_shipped', 'Quantity_uom', 'item_number', 'product_description', 'unit_price', 'extended_price'];
  const rows = [];
  for (const { order: o, lines } of byOrder.values()) {
    const invoiceDate = fmtDateMDY(o.delivery || o.date);
    const days = parseInt((o.terms || 'Net 30').replace(/\D/g, '')) || 30;
    const dueIso = plusDays((o.date instanceof Date ? o.date.toISOString().slice(0, 10) : o.date), days);
    const invoiceDueDate = fmtDateMDY(dueIso);
    const po = o.po || '';
    const vendorStoreId = o.acct_name || '';

    for (const item of lines) {
      if (item.sku === '__DELIVERY__') {
        const amt = parseFloat(item.fee_amt ?? 6.00);
        rows.push([o.id, vendorStoreId, invoiceDate, invoiceDueDate, po, 1, 'CA', 'DF1', 'Delivery Fee', Number(amt.toFixed(1)), amt.toFixed(1)]);
        continue;
      }
      if (item.sku === '__BROKEN_CASE__') {
        const count = item.fee_count || 1;
        const rate = parseFloat(item.fee_amt ?? 1.50);
        rows.push([o.id, vendorStoreId, invoiceDate, invoiceDueDate, po, count, 'CA', 'BF', 'Broken Case Fee', Number(rate.toFixed(1)), (rate * count).toFixed(1)]);
        continue;
      }
      if (item.sku === '__CRV__') {
        const rate = parseFloat(item.rate || 0);
        const btl = item.bottles || 0;
        const amt = parseFloat(item.fee_amt || 0);
        const code = rate >= 0.10 ? 'CACRV24oz+' : 'CACRV24-'; // see CAVEAT above
        rows.push([o.id, vendorStoreId, invoiceDate, invoiceDueDate, po, btl, 'CA', code, 'CA CRV', rate.toFixed(2), amt.toFixed(2)]);
        continue;
      }
      // Product line item -- cases mode (default)
      if (!item.btl) continue; // product no longer exists
      const priceBtl = resolvePriceBtl(item);
      const rawQty = (item.cases || 0) + (item.bottles / (item.btl || 12));
      const qty = Math.round(rawQty * 100) / 100;
      const unitPrice = priceBtl * (item.btl || 12);
      const totalBtl = (item.cases || 0) * (item.btl || 12) + (item.bottles || 0);
      const lt = lineTotal(totalBtl, priceBtl, item.discount_pct);
      rows.push([o.id, vendorStoreId, invoiceDate, invoiceDueDate, po, qty, 'CA', item.sku, item.product_name || item.sku, unitPrice.toFixed(2), lt.toFixed(2)]);
    }
  }
  return { headers, rows };
}

async function buildReportData(sched) {
  const { from, to } = resolveDateRange(sched);
  if (sched.type === 'RA5') return buildRA5(from, to, sched.producers || []);
  if (sched.type === 'RA2') return buildRA2(from, to, sched.producers || []);
  if (sched.type === 'RA40') return buildRA40(from, to, sched.producers || []);
  if (sched.type === 'RC12') return buildRC12(from, to, sched.producers || []);
  if (sched.type === 'RI2') return buildRI2();
  if (sched.type === 'FINTECH') return buildFintech(from, to);
  // RB1/RB2 are current-state snapshots -- no date range to resolve, run fresh every time
  if (sched.type === 'RB1' || sched.type === 'RB2') return buildRBInventory(sched);
  return null; // Not yet supported for automated sending
}

// ─── EXCEL GENERATION ──────────────────────────────────────────────────────
async function buildExcelBuffer(reportName, data) {
  const wb = new ExcelJS.Workbook();
  const sheets = data.sheets || [{ name: reportName.slice(0, 31), headers: data.headers, rows: data.rows }];
  sheets.forEach(sheet => {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31)); // Excel sheet name limit
    ws.addRow(sheet.headers).font = { bold: true };
    sheet.rows.forEach(r => ws.addRow(r));
    ws.columns.forEach(col => { col.width = 18; });
  });
  return wb.xlsx.writeBuffer();
}

// ─── SEND (used by both "Send now" and the automated scheduler) ──────────
async function sendScheduleNow(sched) {
  const data = await buildReportData(sched);
  if (!data) return { ok: false, error: `Automatic sending isn't set up yet for ${sched.type}` };
  if (!data.rows.length) return { ok: false, error: 'No data found for the selected range/producers' };
  if (!sched.recipients || !sched.recipients.length) return { ok: false, error: 'No recipients configured' };

  const typeLabel = {
    RA2: 'Invoice Line Item', RA5: 'Depletion by Producer', RA40: 'CRV Redemption Entry Sales',
    RB1: 'Inventory by Supplier', RB2: 'Inventory by Producer', RC12: 'Samples',
    RI2: 'Open/Past Due Invoices', FINTECH: 'Fintech Export',
  };
  const reportName = typeLabel[sched.type] || sched.type;
  const buffer = await buildExcelBuffer(reportName, data);
  const base64 = buffer.toString('base64');
  const filename = `${sched.type}_${todayStr()}.xlsx`;

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const to = sched.recipients.map(r => r.email).filter(Boolean);
  await sgMail.send({
    to, from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: `${reportName} -- ${todayStr()} -- ACS Beverage Co.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px">
      <p>Hi,</p>
      <p>Please find the attached ${reportName} report, generated ${todayStr()}.</p>
      <p>${data.rows.length} row${data.rows.length !== 1 ? 's' : ''} included.</p>
      <p style="margin-top:20px;color:#888;font-size:12px">This report was sent automatically by Toasted.</p>
    </div>`,
    attachments: [{
      content: base64,
      filename,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment',
    }],
  });

  return { ok: true, recipientCount: to.length, rowCount: data.rows.length };
}

// ─── CRUD ROUTES ────────────────────────────────────────────────────────
function mapRow(r) {
  return {
    id: r.id, name: r.name, type: r.type,
    dateRange: r.date_range, customFrom: r.custom_from, customTo: r.custom_to,
    freq: r.freq, dayOfWeek: r.day_of_week, dayOfMonth: r.day_of_month, time: r.send_time,
    recipients: r.recipients || [], producers: r.producers || [],
    active: r.active, lastSent: r.last_sent, nextSend: r.next_send,
  };
}

router.get('/', requireAdmin, async (req, res) => {
  try {
    const rows = await getAll('SELECT * FROM report_schedules ORDER BY created_at DESC');
    res.json({ ok: true, schedules: rows.map(mapRow) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const s = req.body;
    const id = s.id || 'sch_' + Date.now();
    const nextSend = calcNextSend(s.freq, s.dayOfWeek, s.dayOfMonth, s.time);
    await query(
      `INSERT INTO report_schedules (id,name,type,date_range,custom_from,custom_to,freq,day_of_week,day_of_month,send_time,recipients,producers,active,last_sent,next_send)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         name=$2,type=$3,date_range=$4,custom_from=$5,custom_to=$6,freq=$7,day_of_week=$8,
         day_of_month=$9,send_time=$10,recipients=$11,producers=$12,active=$13,next_send=$15`,
      [id, s.name, s.type, s.dateRange || 'rolling30', s.customFrom || null, s.customTo || null,
       s.freq || 'weekly', s.dayOfWeek ?? 1, s.dayOfMonth ?? 1, s.time || '08:00',
       JSON.stringify(s.recipients || []), JSON.stringify(s.producers || []),
       s.active !== false, s.lastSent || null, nextSend]
    );
    res.json({ ok: true, id, nextSend });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { active } = req.body;
    const sched = await getOne('SELECT * FROM report_schedules WHERE id=$1', [req.params.id]);
    if (!sched) return res.status(404).json({ ok: false, error: 'Schedule not found' });
    const newActive = active !== undefined ? active : sched.active;
    const nextSend = newActive ? calcNextSend(sched.freq, sched.day_of_week, sched.day_of_month, sched.send_time) : sched.next_send;
    await query('UPDATE report_schedules SET active=$1, next_send=$2 WHERE id=$3', [newActive, nextSend, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM report_schedules WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manual "Send now" -- generates and actually emails the report immediately, with the real
// .xlsx attached, using the exact same logic the automated scheduler uses.
router.post('/:id/run', requireAdmin, async (req, res) => {
  try {
    const row = await getOne('SELECT * FROM report_schedules WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Schedule not found' });
    const sched = mapRow(row);
    const result = await sendScheduleNow(sched);
    if (!result.ok) return res.status(400).json(result);
    const nextSend = calcNextSend(sched.freq, sched.dayOfWeek, sched.dayOfMonth, sched.time);
    await query('UPDATE report_schedules SET last_sent=$1, next_send=$2 WHERE id=$3', [todayStr(), nextSend, req.params.id]);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Send report schedule error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── AUTOMATED SCHEDULER (called periodically by node-cron in server.js) ─
async function runDueSchedules() {
  try {
    const due = await getAll(
      `SELECT * FROM report_schedules WHERE active=TRUE AND next_send <= $1`,
      [todayStr()]
    );
    for (const row of due) {
      const sched = mapRow(row);
      try {
        const result = await sendScheduleNow(sched);
        const nextSend = calcNextSend(sched.freq, sched.dayOfWeek, sched.dayOfMonth, sched.time);
        if (result.ok) {
          await query('UPDATE report_schedules SET last_sent=$1, next_send=$2 WHERE id=$3', [todayStr(), nextSend, sched.id]);
          console.log(`Scheduled report sent: ${sched.name} (${sched.type}) -- ${result.recipientCount} recipient(s)`);
        } else {
          // Push next_send forward anyway so a persistently-failing schedule (e.g. no data
          // this period) doesn't retry every single cron tick until someone notices.
          await query('UPDATE report_schedules SET next_send=$1 WHERE id=$2', [nextSend, sched.id]);
          console.error(`Scheduled report skipped: ${sched.name} (${sched.type}) -- ${result.error}`);
        }
      } catch (err) {
        console.error(`Scheduled report failed: ${sched.name} (${sched.type}) --`, err.message);
      }
    }
  } catch (err) {
    console.error('runDueSchedules error:', err.message);
  }
}

module.exports = { router, runDueSchedules };
