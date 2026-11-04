const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, getOne, getAll } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const sgMail = require('@sendgrid/mail');

const FROM_EMAIL = process.env.FROM_EMAIL || 'accounting@acsbeverage.com';
const FROM_NAME  = process.env.FROM_NAME  || 'Toasted -- ACS Beverage Co.';
const NEW_ACCOUNT_NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || 'kevin@acsbeverage.com,jessica@acsbeverage.com')
  .split(',').map(e => e.trim()).filter(Boolean);

router.get('/accounts', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const isCustomer = req.user.role === 'customer';
    let rows;
    if (isAdmin) {
      rows = await getAll('SELECT * FROM accounts ORDER BY name');
    } else if (isCustomer) {
      const cust = await getOne('SELECT acct_id FROM customer_users WHERE id=$1', [req.user.id]);
      rows = cust ? await getAll('SELECT * FROM accounts WHERE id=$1', [cust.acct_id]) : [];
    } else {
      rows = await getAll('SELECT * FROM accounts WHERE rep=$1 ORDER BY name', [req.user.id]);
    }
    res.json({ ok: true, accounts: rows.map(r => ({
      id: r.id, name: r.name, code: r.code, lic: r.lic, abcNum: r.abc_num,
      contact: r.contact, contactFirst: r.contact_first, contactLast: r.contact_last,
      phone: r.phone, email: r.email, address: r.address,
      shipStreet: r.ship_street, shipCity: r.ship_city, shipState: r.ship_state, shipZip: r.ship_zip,
      billStreet: r.bill_street, billCity: r.bill_city, billState: r.bill_state, billZip: r.bill_zip,
      terms: r.terms, rep: r.rep, qboId: r.qbo_id, isActive: r.is_active !== false, waiveDeliveryAlways: r.waive_delivery_always === true, paymentProvider: r.payment_provider||'',
onlinePayments: r.online_payments||'No',
redemption: r.redemption||'No',
taxId: r.tax_id||'',
resaleNum: r.resale_num||'',
warehouseCode: r.warehouse_code||'',
licExpiry: r.lic_expiry||'',
abcDetail: r.abc_detail||'',
creditLimit: parseFloat(r.credit_limit)||0,
creditBalance: parseFloat(r.credit_balance)||0,
avgDaysToPay: parseFloat(r.avg_days_to_pay)||0,
commissionPct: parseFloat(r.commission_pct)||0,
region: r.region||'',
kindPrimary: r.kind_primary||'',
kindSecondary: r.kind_secondary||'',
corpGroup: r.corp_group||'',
shipStreet2: r.ship_street2||'', shipCounty: r.ship_county||'',
billStreet2: r.bill_street2||'', billCounty: r.bill_county||'',
accountType: r.account_type||'',
allowedShipDays: r.allowed_ship_days||'',
tastingHours: r.tasting_hours||'',
deliveryNotes: r.delivery_notes||'',
website: r.website||'',
preferredPaymentMethodName: r.preferred_payment_method_name||'',
showProductUpc: !!r.show_product_upc,
avgMonthlySalesEstimate: parseFloat(r.avg_monthly_sales_estimate)||0,
overrideAvgMonthlySales: !!r.override_avg_monthly_sales,
isProspective: !!r.is_prospective,
isSampleAccount: !!r.is_sample_account,
alternateLicense: r.alternate_license||'',
alternateLicenseExpiry: r.alternate_license_expiry||'',
externalIdentifier1: r.external_identifier_1||'',
prefersMasterInvoice: !!r.prefers_master_invoice,
allowOrders: r.allow_orders!==false,
codEmailNotifications: !!r.cod_email_notifications,
billingInvoiceTitle: r.billing_invoice_title||'',
pastDue: !!r.past_due,
notifyInvoiceContactsAR: r.notify_invoice_contacts_ar!==false,
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});
router.post('/accounts', requireAdmin, async (req, res) => {
  try {
    const { id, name, code, lic, contact, contactFirst, contactLast, phone, email, address,
            shipStreet, shipCity, shipState, shipZip, billStreet, billCity, billState, billZip,
            terms, rep, corpGroup, region, kindPrimary, kindSecondary,
            shipStreet2, shipCounty, billStreet2, billCounty,
            accountType, allowedShipDays, tastingHours, deliveryNotes, website,
            preferredPaymentMethodName, showProductUpc,
            avgMonthlySalesEstimate, overrideAvgMonthlySales, isProspective, isSampleAccount,
            taxId, abcDetail, licExpiry, resaleNum, alternateLicense, alternateLicenseExpiry,
            externalIdentifier1, redemption, warehouseCode,
            paymentProvider, onlinePayments, prefersMasterInvoice, allowOrders,
            codEmailNotifications, billingInvoiceTitle, creditLimit, commissionPct,
            pastDue, notifyInvoiceContactsAR } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'Account name required' });
    const acctId = id || ('a' + Date.now());

    let acctCode = code ? String(code).trim() : '';
    if (acctCode) {
      const clash = await getOne('SELECT id FROM accounts WHERE code=$1', [acctCode]);
      if (clash) return res.status(400).json({ ok: false, error: 'That account number is already in use' });
    } else {
      const seqRow = await getOne('UPDATE account_code_sequence SET next_seq = next_seq + 1 WHERE id=1 RETURNING next_seq - 1 as claimed');
      acctCode = String(seqRow.claimed);
    }

    await query(
      `INSERT INTO accounts (id,name,code,lic,contact,contact_first,contact_last,phone,email,address,
        ship_street,ship_city,ship_state,ship_zip,bill_street,bill_city,bill_state,bill_zip,terms,rep,
        corp_group,region,kind_primary,kind_secondary,
        ship_street2,ship_county,bill_street2,bill_county,
        account_type,allowed_ship_days,tasting_hours,delivery_notes,website,
        preferred_payment_method_name,show_product_upc,
        avg_monthly_sales_estimate,override_avg_monthly_sales,is_prospective,is_sample_account,
        tax_id,abc_detail,lic_expiry,resale_num,alternate_license,alternate_license_expiry,
        external_identifier_1,redemption,warehouse_code,
        payment_provider,online_payments,prefers_master_invoice,allow_orders,
        cod_email_notifications,billing_invoice_title,credit_limit,commission_pct,
        past_due,notify_invoice_contacts_ar)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
        $41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57,$58)`,
      [acctId, name, acctCode, lic||'', contact||'', contactFirst||'', contactLast||'', phone||'', email||'', address||'',
       shipStreet||'', shipCity||'', shipState||'', shipZip||'', billStreet||'', billCity||'', billState||'', billZip||'',
       terms||'Net 30', rep||null,
       corpGroup||'', region||'', kindPrimary||'', kindSecondary||'',
       shipStreet2||'', shipCounty||'', billStreet2||'', billCounty||'',
       accountType||'', allowedShipDays||'', tastingHours||'', deliveryNotes||'', website||'',
       preferredPaymentMethodName||'', !!showProductUpc,
       avgMonthlySalesEstimate||0, !!overrideAvgMonthlySales, !!isProspective, !!isSampleAccount,
       taxId||'', abcDetail||'', licExpiry||'', resaleNum||'', alternateLicense||'', alternateLicenseExpiry||'',
       externalIdentifier1||'', redemption||'No', warehouseCode||'',
       paymentProvider||'', onlinePayments||'No', !!prefersMasterInvoice, allowOrders!==false,
       !!codEmailNotifications, billingInvoiceTitle||'', creditLimit||0, commissionPct||0,
       !!pastDue, notifyInvoiceContactsAR!==false]
    );
    res.json({ ok: true, id: acctId, code: acctCode });
    sendNewAccountNotification(acctId, name, acctCode, rep, req.user).catch(err => console.error('New account notification error:', err.message));
  } catch (err) {
    console.error('Create account error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

async function sendNewAccountNotification(acctId, acctName, acctCode, repId, createdByUser) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('New account notification (no SendGrid):', acctName);
    return;
  }
  const to = [...NEW_ACCOUNT_NOTIFY_EMAILS];
  let repLine = 'Unassigned';
  if (repId) {
    const rep = await getOne('SELECT fname, lname, email FROM users WHERE id=$1', [repId]);
    if (rep) {
      repLine = rep.fname + ' ' + (rep.lname || '');
      if (rep.email && !to.map(e => e.toLowerCase()).includes(rep.email.toLowerCase())) {
        to.push(rep.email);
      }
    }
  }
  const createdByLabel = createdByUser ? (createdByUser.fname + ' ' + (createdByUser.lname || '')) : 'Someone';

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px">
      <h2 style="color:#B8792C;margin-bottom:4px">New Account Created</h2>
      <p style="color:#555;margin-top:0">Created by ${createdByLabel}</p>
      <table style="width:100%;border-collapse:collapse;margin-top:12px">
        <tr><td style="padding:6px 0;color:#888">Account Name</td><td style="padding:6px 0;font-weight:600">${acctName}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Account #</td><td style="padding:6px 0">${acctCode}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Assigned Rep</td><td style="padding:6px 0">${repLine}</td></tr>
      </table>
      <p style="margin-top:20px"><a href="https://toasted.acsbeverageco.com/#accounts/${acctId}" style="background:#B8792C;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">View Account in Toasted</a></p>
    </div>`;
  await sgMail.send({
    to, from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'New Account Created: ' + acctName,
    html,
  });
}

router.post('/accounts/bulk-corp-group', requireAdmin, async (req, res) => {
  try {
    const { accountIds, corpGroup } = req.body;
    if (!Array.isArray(accountIds) || !accountIds.length) return res.status(400).json({ ok: false, error: 'No accounts selected' });
    const result = await query('UPDATE accounts SET corp_group=$1 WHERE id = ANY($2)', [corpGroup || '', accountIds]);
    res.json({ ok: true, updated: result.rowCount });
  } catch (err) {
    console.error('Bulk corp group error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Change the same settings on many accounts at once (chains / corp groups). Only the fields listed here can be
// changed this way -- addresses, delivery notes, ship days and AP/invoice contacts are deliberately NOT included.
const BULK_ACCOUNT_FIELDS = {
  rep: ['rep', 'str'], terms: ['terms', 'str'], waiveDeliveryAlways: ['waive_delivery_always', 'bool'],
  commissionPct: ['commission_pct', 'num'], creditLimit: ['credit_limit', 'num'],
  region: ['region', 'str'], accountType: ['account_type', 'str'],
  paymentProvider: ['payment_provider', 'str'], preferredPaymentMethodName: ['preferred_payment_method_name', 'str'],
  onlinePayments: ['online_payments', 'yesno'], redemption: ['redemption', 'yesno'],
  prefersMasterInvoice: ['prefers_master_invoice', 'bool'], allowOrders: ['allow_orders', 'bool'],
  showProductUpc: ['show_product_upc', 'bool'], pastDue: ['past_due', 'bool'],
  codEmailNotifications: ['cod_email_notifications', 'bool'],
};
router.post('/accounts/bulk-update', requireAdmin, async (req, res) => {
  try {
    const { accountIds, changes } = req.body;
    if (!Array.isArray(accountIds) || !accountIds.length) return res.status(400).json({ ok: false, error: 'No accounts selected' });
    if (!changes || typeof changes !== 'object') return res.status(400).json({ ok: false, error: 'No changes given' });
    const sets = [], vals = [accountIds];
    for (const key of Object.keys(changes)) {
      const def = BULK_ACCOUNT_FIELDS[key];
      if (!def) return res.status(400).json({ ok: false, error: 'This field can not be changed in bulk: ' + key });
      let v = changes[key];
      if (def[1] === 'bool') v = (v === true || v === 'true');
      else if (def[1] === 'num') { v = parseFloat(v); if (!Number.isFinite(v)) return res.status(400).json({ ok: false, error: 'Invalid number for ' + key }); }
      else if (def[1] === 'yesno') v = (v === 'Yes' || v === true) ? 'Yes' : 'No';
      else v = String(v == null ? '' : v);
      if (key === 'rep') {
        const u = await getOne('SELECT id FROM users WHERE id=$1', [v]);
        if (!u) return res.status(400).json({ ok: false, error: 'Rep not found' });
      }
      vals.push(v);
      sets.push(`${def[0]}=$${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'No changes given' });
    const result = await query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ANY($1)`, vals);
    res.json({ ok: true, updated: result.rowCount });
  } catch (err) {
    console.error('Bulk account update error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/accounts/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body;
    if (b.code !== undefined) {
      const trimmed = String(b.code).trim();
      if (trimmed) {
        const clash = await getOne('SELECT id FROM accounts WHERE code=$1 AND id<>$2', [trimmed, req.params.id]);
        if (clash) return res.status(400).json({ ok: false, error: 'That account number is already in use' });
      }
    }

    // Maps request field name -> DB column name. Only fields actually present in the request get updated.
    const fieldMap = {
      name:'name', code:'code', contact:'contact', contactFirst:'contact_first', contactLast:'contact_last',
      phone:'phone', email:'email', address:'address', terms:'terms', rep:'rep',
      shipStreet:'ship_street', shipCity:'ship_city', shipState:'ship_state', shipZip:'ship_zip',
      billStreet:'bill_street', billCity:'bill_city', billState:'bill_state', billZip:'bill_zip',
      paymentProvider:'payment_provider', onlinePayments:'online_payments', redemption:'redemption',
      taxId:'tax_id', resaleNum:'resale_num', warehouseCode:'warehouse_code',
      licExpiry:'lic_expiry', abcDetail:'abc_detail', creditLimit:'credit_limit', creditBalance:'credit_balance',
      avgDaysToPay:'avg_days_to_pay', commissionPct:'commission_pct',
      region:'region', kindPrimary:'kind_primary', kindSecondary:'kind_secondary', corpGroup:'corp_group',
      shipStreet2:'ship_street2', shipCounty:'ship_county', billStreet2:'bill_street2', billCounty:'bill_county',
      accountType:'account_type', allowedShipDays:'allowed_ship_days', tastingHours:'tasting_hours',
      deliveryNotes:'delivery_notes', website:'website',
      preferredPaymentMethodName:'preferred_payment_method_name', showProductUpc:'show_product_upc',
      avgMonthlySalesEstimate:'avg_monthly_sales_estimate', overrideAvgMonthlySales:'override_avg_monthly_sales',
      isProspective:'is_prospective', isSampleAccount:'is_sample_account',
      alternateLicense:'alternate_license', alternateLicenseExpiry:'alternate_license_expiry',
      externalIdentifier1:'external_identifier_1',
      prefersMasterInvoice:'prefers_master_invoice', allowOrders:'allow_orders',
      codEmailNotifications:'cod_email_notifications', billingInvoiceTitle:'billing_invoice_title',
      pastDue:'past_due', notifyInvoiceContactsAR:'notify_invoice_contacts_ar',
      lic:'lic', abcNum:'abc_num', waiveDeliveryAlways:'waive_delivery_always',
    };

    const updates = [], values = [];
    let idx = 1;
    Object.keys(fieldMap).forEach(key => {
      if (b[key] !== undefined) { updates.push(`${fieldMap[key]}=$${idx++}`); values.push(b[key]); }
    });
    if (updates.length === 0) return res.json({ ok: true }); // nothing to update
    values.push(req.params.id);
    await query(`UPDATE accounts SET ${updates.join(', ')} WHERE id=$${idx}`, values);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update account error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/accounts/:id', requireAdmin, async (req, res) => {
  try {
    // Soft-delete, not a real DELETE -- a genuine delete would either fail outright (any
    // order, draft, or tasting ever placed for this account references it) or, if forced
    // through, permanently destroy real order and payment history. This hides the account
    // from active use everywhere while preserving everything underneath it.
    const existing = await getOne('SELECT id FROM accounts WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ ok: false, error: 'Account not found' });
    await query('UPDATE accounts SET is_active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});


// -- PRODUCT TAXONOMY (categories & spirit types) --------------------------------
// -- CUSTOMER PORTAL PROMO BANNER -------------------------------------------------
router.get('/portal-banner-diagnose', async (req, res) => {
  try {
    if (req.query.secret !== 'toasted2026-diagnose') return res.status(403).json({ ok: false });
    const row = await getOne('SELECT id, is_active, link_url, alt_text, updated_at, LENGTH(image_data) as image_data_length FROM portal_banner WHERE id=1');
    res.json({ ok: true, row: row || null, rowExists: !!row });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.get('/portal-banner', requireAuth, async (req, res) => {
  try {
    const row = await getOne('SELECT image_data, link_url, alt_text, is_active FROM portal_banner WHERE id=1');
    res.json({ ok: true, banner: (row && row.is_active && row.image_data) ? row : null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/portal-banner', requireAdmin, async (req, res) => {
  try {
    const { imageData, linkUrl, altText } = req.body;
    if (!imageData) return res.status(400).json({ ok: false, error: 'Image required' });
    await query(
      `INSERT INTO portal_banner (id,image_data,link_url,alt_text,is_active,updated_at) VALUES (1,$1,$2,$3,TRUE,NOW())
       ON CONFLICT (id) DO UPDATE SET image_data=$1, link_url=$2, alt_text=$3, is_active=TRUE, updated_at=NOW()`,
      [imageData, linkUrl || null, altText || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/portal-banner', requireAdmin, async (req, res) => {
  try {
    await query('UPDATE portal_banner SET is_active=FALSE WHERE id=1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/product-taxonomy', requireAuth, async (req, res) => {
  try {
    const rows = await getAll('SELECT id, kind, name FROM product_taxonomy ORDER BY kind, sort_order, name');
    res.json({
      ok: true,
      categories: rows.filter(r => r.kind === 'category').map(r => ({ id: r.id, name: r.name })),
      spiritTypes: rows.filter(r => r.kind === 'spirit_type').map(r => ({ id: r.id, name: r.name })),
      packSizes: rows.filter(r => r.kind === 'pack_size').map(r => ({ id: r.id, name: r.name })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/product-taxonomy', requireAdmin, async (req, res) => {
  try {
    const { kind, name } = req.body;
    if (!['category', 'spirit_type', 'pack_size'].includes(kind)) return res.status(400).json({ ok: false, error: 'Invalid kind' });
    const trimmed = (name || '').trim();
    if (!trimmed) return res.status(400).json({ ok: false, error: 'Name required' });
    // Pack Size stores the bottles-per-case count -- keep it a clean positive integer so it
    // sorts and parses reliably everywhere it's used (the product form's Unit Set dropdown,
    // combo/order math, etc).
    if (kind === 'pack_size' && (!/^\d+$/.test(trimmed) || parseInt(trimmed) <= 0)) {
      return res.status(400).json({ ok: false, error: 'Pack size must be a whole number greater than 0' });
    }
    const maxSort = await getOne('SELECT COALESCE(MAX(sort_order),-1) as m FROM product_taxonomy WHERE kind=$1', [kind]);
    const row = await getOne(
      `INSERT INTO product_taxonomy (kind,name,sort_order) VALUES ($1,$2,$3)
       ON CONFLICT (kind,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [kind, trimmed, (maxSort?.m ?? -1) + 1]
    );
    res.json({ ok: true, id: row.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/product-taxonomy/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM product_taxonomy WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -- ORDER COMBOS (bundled promotional pricing) -----------------------------------
// Each combo's `items` array holds { sku, cases, isBonus }. Pricing is never stored
// here -- it's always recomputed live from each item's own current 5-Case Brand
// Family price (see computeComboPricing below and orders.js at submit time), so a
// later price change to a product flows through to the combo automatically.
router.get('/combos', requireAuth, async (req, res) => {
  try {
    const rows = await getAll(`SELECT * FROM order_combos WHERE is_active=TRUE ORDER BY id`);
    res.json({ ok: true, combos: rows.map(r => ({
      id: r.id, name: r.name, items: r.items || [], isActive: r.is_active,
    })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/combos/all', requireAdmin, async (req, res) => {
  try {
    const rows = await getAll(`SELECT * FROM order_combos ORDER BY id`);
    res.json({ ok: true, combos: rows.map(r => ({
      id: r.id, name: r.name, items: r.items || [], isActive: r.is_active,
    })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// order_items.cases is a whole-number database column, so a combo item's case count must be
// a positive integer -- a fractional value (e.g. from a stray decimal typed into the admin UI,
// or any other client) would otherwise sit quietly in the combo's stored definition and crash
// EVERY order that later applies it with a database type error, which is exactly what happened
// here. Validated on both create and edit -- PATCH previously did no validation on items at all.
function validateComboItems(items) {
  if (!Array.isArray(items) || !items.length) return 'At least one item is required';
  for (const it of items) {
    if (!it.sku) return 'Each item needs a SKU';
    // A combo item is some number of whole cases, some number of loose bottles, or both --
    // but never fractional, and never empty. `bottles` is optional on older combos (undefined
    // counts as 0), so every combo saved before bottles were supported stays valid as-is.
    const cs = it.cases === undefined ? 0 : it.cases;
    const bt = it.bottles === undefined ? 0 : it.bottles;
    if (!Number.isInteger(cs) || cs < 0) {
      return `"${it.sku}" needs a whole-number case count of 0 or more (got ${it.cases})`;
    }
    if (!Number.isInteger(bt) || bt < 0) {
      return `"${it.sku}" needs a whole-number bottle count of 0 or more (got ${it.bottles})`;
    }
    if (cs + bt <= 0) {
      return `"${it.sku}" needs at least 1 case or 1 bottle`;
    }
  }
  return null;
}

router.post('/combos', requireAdmin, async (req, res) => {
  try {
    const { name, items } = req.body;
    const trimmed = (name || '').trim();
    if (!trimmed) return res.status(400).json({ ok: false, error: 'Combo name is required' });
    const itemsErr = validateComboItems(items);
    if (itemsErr) return res.status(400).json({ ok: false, error: itemsErr });
    const row = await getOne(
      `INSERT INTO order_combos (name, items, is_active) VALUES ($1,$2,TRUE) RETURNING id`,
      [trimmed, JSON.stringify(items)]
    );
    res.json({ ok: true, id: row.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/combos/:id', requireAdmin, async (req, res) => {
  try {
    const { name, items, isActive } = req.body;
    if (items !== undefined) {
      const itemsErr = validateComboItems(items);
      if (itemsErr) return res.status(400).json({ ok: false, error: itemsErr });
    }
    const sets = [], vals = [];
    if (name !== undefined) { sets.push(`name=$${sets.length+1}`); vals.push((name||'').trim()); }
    if (items !== undefined) { sets.push(`items=$${sets.length+1}`); vals.push(JSON.stringify(items)); }
    if (isActive !== undefined) { sets.push(`is_active=$${sets.length+1}`); vals.push(!!isActive); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Nothing to update' });
    sets.push(`updated_at=NOW()`);
    vals.push(req.params.id);
    await query(`UPDATE order_combos SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/combos/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM order_combos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -- STOCK ADJUSTMENTS (permanent audit log for manual inventory changes) --------
// Written every time an admin adjusts a product's stock from either the main
// Inventory page or the ACS Logistics page. Persisted server-side (unlike the old
// client-only log) so it survives refresh and is visible to every admin, on both pages.
router.get('/stock-adjustments', requireAdmin, async (req, res) => {
  try {
    const { warehouse, sku } = req.query;
    const conds = [], vals = [];
    if (warehouse) { vals.push(warehouse); conds.push(`warehouse=$${vals.length}`); }
    if (sku) { vals.push(sku); conds.push(`sku=$${vals.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    vals.push(Math.min(parseInt(req.query.limit)||1000, 5000));
    const rows = await getAll(
      `SELECT * FROM stock_adjustments ${where} ORDER BY id DESC LIMIT $${vals.length}`,
      vals
    );
    res.json({ ok: true, adjustments: rows.map(r => ({
      id: r.id, sku: r.sku, warehouse: r.warehouse || 'main',
      cases: r.cases || 0, bottles: r.bottles || 0, sign: r.sign,
      reason: r.reason || '', notes: r.notes || '',
      byUserId: r.by_user_id, byName: r.by_name || '',
      createdAt: r.created_at,
    })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/stock-adjustments', requireAdmin, async (req, res) => {
  try {
    const { sku, warehouse, cases, bottles, sign, reason, notes } = req.body;
    if (!sku) return res.status(400).json({ ok: false, error: 'SKU is required' });
    const row = await getOne(
      `INSERT INTO stock_adjustments (sku, warehouse, cases, bottles, sign, reason, notes, by_user_id, by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [
        sku, warehouse || 'main', parseInt(cases) || 0, parseInt(bottles) || 0,
        (sign === -1 ? -1 : 1), reason || '', notes || '',
        req.user.id, (req.user.fname ? `${req.user.fname} ${req.user.lname||''}`.trim() : (req.user.email||''))
      ]
    );
    res.json({ ok: true, id: row.id, createdAt: row.created_at });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Product detail fields that have no dedicated column of their own -- persisted together in the
// products.details_extra JSONB column so nothing edited in Manage Products is lost on refresh.
const EXTRA_DETAIL_KEYS = ['code','vendorCode','ttb','casesProd','closureType','notes',
  'searchable','discontinued','taxable','btg','inventoryItem','packingSlip','priceTasting',
  'adminOnly','orderableByReps','managerApproval','newVintageInStock','samplesAllowed','poAliases'];
function pickExtraDetails(details) {
  const out = {};
  if (details && typeof details === 'object') {
    EXTRA_DETAIL_KEYS.forEach(k => { if (details[k] !== undefined) out[k] = details[k]; });
  }
  return out;
}
// Creates the column on first use (safe to repeat), so no separate migration step is needed.
let _detailsExtraReady = null;
function ensureDetailsExtraColumn() {
  if (!_detailsExtraReady) {
    _detailsExtraReady = query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS details_extra JSONB DEFAULT '{}'`)
      .catch(err => { _detailsExtraReady = null; throw err; });
  }
  return _detailsExtraReady;
}

router.get('/products', requireAuth, async (req, res) => {
  try {
    await ensureDetailsExtraColumn();
    const isCustomer = req.user.role === 'customer';
    const isAdmin = req.user.role === 'admin';
    const seesAllTiers = isAdmin || !!req.user.pricing_admin; // also governs restricted-product visibility
    const rows = await getAll(
      isAdmin
        ? 'SELECT * FROM products ORDER BY name'
        : seesAllTiers
          ? `SELECT * FROM products WHERE COALESCE(warehouse,'main')<>'acs_logistics' ORDER BY name`
          : `SELECT * FROM products WHERE COALESCE(warehouse,'main')<>'acs_logistics' AND COALESCE(restricted,FALSE)=FALSE ORDER BY name`
    );

    // Bulk-fetch all dynamic tier prices, grouped by SKU, filtered by what this user is allowed to see
    const tierRows = isCustomer ? [] : await getAll(
      seesAllTiers
        ? 'SELECT * FROM product_tier_prices ORDER BY sort_order, tier_name'
        : 'SELECT * FROM product_tier_prices WHERE rep_visible=TRUE OR $1 = ANY(visible_rep_ids) ORDER BY sort_order, tier_name',
      seesAllTiers ? [] : [req.user.id]
    );
    const tiersBySku = {};
    tierRows.forEach(t => {
      if (!tiersBySku[t.sku]) tiersBySku[t.sku] = [];
      tiersBySku[t.sku].push({
        name: t.tier_name,
        price: parseFloat(t.price) || 0,
        da: parseFloat(t.da_amount) || 0,
        commission: t.commission !== null && t.commission !== undefined ? parseFloat(t.commission) : null,
        internalNote: t.internal_note || '',
        repVisible: t.rep_visible,
        visibleRepIds: t.visible_rep_ids || [],
        accountId: t.account_id || null, // kept for backward compatibility
        accountIds: t.account_ids || [],
        corpGroups: t.corp_groups || [],
      });
    });

    res.json({ ok: true, products: rows.map(r => ({
      sku: r.sku, name: r.name, producer: r.producer, cat: r.cat,
      warehouse: r.warehouse||'main',
      restricted: !!r.restricted,
      btl: r.btl, stock: parseFloat(r.stock)||0, reorder: r.reorder,
      extraTiers: tiersBySku[r.sku] || [],
      prices: {
        frontline: parseFloat(r.price_frontline)||0,
        mix12: parseFloat(r.price_mix12)||0,
        acs3: parseFloat(r.price_acs3)||0,
        brand3: parseFloat(r.price_brand3)||0,
        brand5: parseFloat(r.price_brand5)||0,
        ...(r.comm_frontline!==null ? {__comm_frontline: parseFloat(r.comm_frontline)} : {}),
        ...(r.comm_mix12!==null ? {__comm_mix12: parseFloat(r.comm_mix12)} : {}),
        ...(r.comm_acs3!==null ? {__comm_acs3: parseFloat(r.comm_acs3)} : {}),
        ...(r.comm_brand3!==null ? {__comm_brand3: parseFloat(r.comm_brand3)} : {}),
        ...(r.comm_brand5!==null ? {__comm_brand5: parseFloat(r.comm_brand5)} : {}),
      },
      da: isCustomer ? undefined : {
        frontline: parseFloat(r.da_frontline)||0,
        mix12: parseFloat(r.da_mix12)||0,
        acs3: parseFloat(r.da_acs3)||0,
        brand3: parseFloat(r.da_brand3)||0,
        brand5: parseFloat(r.da_brand5)||0,
      },
      _details: isCustomer ? {
        redemptionEntry: r.redemption_entry||'',
        bottleSize: r.bottle_size||'',
        active: r.active||'Yes',
        vintage: r.vintage||'',
        spiritType: r.spirit_type||'',
      } : {
        redemptionEntry: r.redemption_entry||'',
        bottleSize: r.bottle_size||'',
        upc: r.upc||'',
        fobPrice: parseFloat(r.fob_price)||0,
        laidInCost: parseFloat(r.laid_in_cost)||0,
        active: r.active||'Yes',
        core: r.core||'No',
        vintage: r.vintage||'',
        spiritType: r.spirit_type||'',
        ...(r.details_extra || {}),
      },
      image: r.image_url||'',
      tierNotes: r.tier_notes||{},
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/product-tier-prices', requireAuth, async (req, res) => {
  try {
    const sku = req.query.sku;
    if (!sku) return res.status(400).json({ ok: false, error: 'SKU required' });
    const rows = await getAll(
      `SELECT * FROM product_tier_prices WHERE sku=$1 ORDER BY tier_name`,
      [sku]
    );
    // Resolve account and rep names for display in one batch, rather than a query per row
    const allAcctIds = [...new Set(rows.flatMap(r => r.account_ids || []))];
    let acctNameById = {};
    if (allAcctIds.length) {
      const acctRows = await getAll(`SELECT id, name FROM accounts WHERE id = ANY($1)`, [allAcctIds]);
      acctRows.forEach(a => { acctNameById[a.id] = a.name; });
    }
    const allRepIds = [...new Set(rows.flatMap(r => r.visible_rep_ids || []))];
    let repNameById = {};
    if (allRepIds.length) {
      const repRows = await getAll(`SELECT id, fname, lname FROM users WHERE id = ANY($1)`, [allRepIds]);
      repRows.forEach(r => { repNameById[r.id] = r.fname + ' ' + (r.lname || ''); });
    }
    res.json({ ok: true, tiers: rows.map(t => ({
      id: t.id, sku: t.sku, tierName: t.tier_name,
      price: parseFloat(t.price) || 0, da: parseFloat(t.da_amount) || 0,
      commission: t.commission !== null && t.commission !== undefined ? parseFloat(t.commission) : null,
      internalNote: t.internal_note || '',
      repVisible: t.rep_visible,
      accountIds: t.account_ids || [],
      accountNames: (t.account_ids || []).map(id => acctNameById[id] || id),
      corpGroups: t.corp_groups || [],
      visibleRepIds: t.visible_rep_ids || [],
      visibleRepNames: (t.visible_rep_ids || []).map(id => repNameById[id] || id),
    })) });
  } catch (err) {
    console.error('List pricing lanes error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/product-tier-prices', requireAdmin, async (req, res) => {
  try {
    const { sku, tierName, price, da, commission, internalNote, accountIds, corpGroups, repVisible, visibleRepIds } = req.body;
    if (!sku || !tierName || !tierName.trim()) return res.status(400).json({ ok: false, error: 'Product and pricing lane name are required' });
    const row = await getOne(
      `INSERT INTO product_tier_prices (sku, tier_name, price, da_amount, commission, internal_note, rep_visible, account_ids, corp_groups, visible_rep_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [sku, tierName, price || 0, da || 0, commission === '' || commission === undefined ? null : commission, internalNote || '', !!repVisible, accountIds || [], corpGroups || [], visibleRepIds || []]
    );
    res.json({ ok: true, id: row.id });
  } catch (err) {
    console.error('Create pricing lane error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/product-tier-prices/:id', requireAdmin, async (req, res) => {
  try {
    const { tierName, price, da, commission, internalNote, accountIds, corpGroups, repVisible, visibleRepIds } = req.body;
    if (!tierName || !tierName.trim()) return res.status(400).json({ ok: false, error: 'Pricing lane name is required' });
    await query(
      `UPDATE product_tier_prices SET tier_name=$1, price=$2, da_amount=$3, commission=$4, internal_note=$5, rep_visible=$6, account_ids=$7, corp_groups=$8, visible_rep_ids=$9, updated_at=NOW() WHERE id=$10`,
      [tierName, price || 0, da || 0, commission === '' || commission === undefined ? null : commission, internalNote || '', !!repVisible, accountIds || [], corpGroups || [], visibleRepIds || [], req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Update pricing lane error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/product-tier-prices/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM product_tier_prices WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Standard pricing tier labels + internal notes -- editable, persisted data (used to be a
// hardcoded frontend array and static, non-editable text). GET is available to any
// authenticated user since reps need to see these too, not just admin.
router.get('/pricing-tier-config', requireAuth, async (req, res) => {
  try {
    const rows = await getAll('SELECT * FROM pricing_tier_config ORDER BY sort_order, label');
    res.json({ ok: true, tiers: rows.map(t => ({ id: t.id, label: t.label, internalNote: t.internal_note || '' })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/pricing-tier-config/:id', requireAdmin, async (req, res) => {
  try {
    const { label, internalNote } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ ok: false, error: 'Tier label is required' });
    await query('UPDATE pricing_tier_config SET label=$1, internal_note=COALESCE($2,internal_note) WHERE id=$3', [label, internalNote !== undefined ? internalNote : null, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/products/bulk-inventory', requireAdmin, async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'No items provided' });
    let updated = 0;
    const notFound = [];
    for (const item of items) {
      if (!item.sku || item.stock === undefined || item.stock === null) continue;
      const result = await query('UPDATE products SET stock=$1 WHERE sku=$2', [item.stock, item.sku]);
      if (result.rowCount > 0) updated++;
      else notFound.push(item.sku);
    }
    res.json({ ok: true, updated, notFoundCount: notFound.length, notFound: notFound.slice(0, 50) });
  } catch (err) {
    console.error('Bulk inventory update error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/products/:sku/usage', requireAdmin, async (req, res) => {
  try {
    const row = await getOne('SELECT COUNT(*) as cnt FROM order_items WHERE sku=$1', [req.params.sku]);
    res.json({ ok: true, orderCount: parseInt(row.cnt) || 0 });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/products/:sku', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM products WHERE sku=$1', [req.params.sku]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete product error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Dedicated, safe endpoint for stock adjustments (the "Adjust inventory" modal) -- uses
// COALESCE so a minimal {stock, reorder} payload only ever touches those two fields, unlike
// the full-product PATCH route above which expects every field and would otherwise wipe out
// pricing/details when sent a partial payload.
router.patch('/products/:sku/stock', requireAdmin, async (req, res) => {
  try {
    const { stock, delta, reorder, adjustment } = req.body;
    let result;
    if (delta !== undefined) {
      const d = Number(delta);
      if (!Number.isFinite(d)) return res.status(400).json({ ok: false, error: 'delta must be a number' });
      // Atomic path, used by the "Adjust stock" (receive/deduct) flow. The new value is computed by the
      // database from whatever stock is stored THIS INSTANT, not from a number the admin's browser loaded
      // earlier. Additions are applied exactly (so a shipment landing on a negative balance offsets it
      // correctly -- -7 + 3 is -4, not 0). Deductions floor at zero but can never RAISE stock.
      result = await query(
        `UPDATE products SET stock = CASE WHEN $1::numeric >= 0 THEN stock + $1::numeric
                                          ELSE LEAST(stock, GREATEST(0, stock + $1::numeric)) END,
                reorder=COALESCE($2,reorder) WHERE sku=$3 RETURNING stock`,
        [d, reorder !== undefined ? reorder : null, req.params.sku]
      );
    } else {
      // Absolute-set path, used when the caller already has an authoritative total to write
      // (e.g. syncing QuickBooks' own on-hand quantity) rather than an amount to add/subtract.
      result = await query(
        `UPDATE products SET stock=COALESCE($1,stock), reorder=COALESCE($2,reorder) WHERE sku=$3 RETURNING stock`,
        [stock !== undefined ? stock : null, reorder !== undefined ? reorder : null, req.params.sku]
      );
    }
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Product not found' });

    // The history entry is written HERE, in the same request, only after the stock change succeeded --
    // so the log can never claim an adjustment that didn't actually reach the inventory.
    let logged = true;
    if (adjustment && typeof adjustment === 'object') {
      try {
        await query(
          `INSERT INTO stock_adjustments (sku, warehouse, cases, bottles, sign, reason, notes, by_user_id, by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [req.params.sku, adjustment.warehouse || 'main', parseInt(adjustment.cases) || 0, parseInt(adjustment.bottles) || 0,
           (adjustment.sign === -1 ? -1 : 1), adjustment.reason || '', adjustment.notes || '',
           req.user.id, (req.user.fname ? `${req.user.fname} ${req.user.lname||''}`.trim() : (req.user.email||''))]
        );
      } catch (logErr) {
        logged = false;
        console.error('Stock adjustment log insert failed (stock WAS updated):', logErr.message);
      }
    }
    res.json({ ok: true, stock: parseFloat(result.rows[0].stock), logged });
  } catch (err) {
    console.error('Update product stock error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Dedicated, safe endpoint for a single pricing tier's internal note on one product. Merges
// just that one key into tier_notes via jsonb_set, so this product's other tier notes (and
// every other product's notes entirely) are left untouched -- notes are per-product, unlike
// the tier label itself which is intentionally shared across the whole catalog.
router.patch('/products/:sku/tier-note', requireAdmin, async (req, res) => {
  try {
    const { tierId, note } = req.body;
    if (!tierId) return res.status(400).json({ ok: false, error: 'tierId required' });
    const result = await query(
      `UPDATE products SET tier_notes = COALESCE(tier_notes,'{}'::jsonb) || jsonb_build_object($1::text, $2::text) WHERE sku=$3`,
      [tierId, note || '', req.params.sku]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Product not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Update product tier note error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// NOTE: this full-product save deliberately does NOT write stock. The browser's copy of `stock` can be hours
// stale, and writing it back here silently undid inventory adjustments/sales made since the page loaded
// (the adjustment history showed the change, but the real number had been overwritten). Stock only ever
// changes through PATCH /products/:sku/stock (below) and order create/edit/delete.
router.patch('/products/:sku', requireAdmin, async (req, res) => {
  try {
    const { name, producer, cat, btl, prices, da, stock, _details, image, warehouse, restricted, newSku } = req.body;
    const currentSku = req.params.sku;
    await ensureDetailsExtraColumn();
    await query(`UPDATE products SET
      name=COALESCE($1,name), producer=COALESCE($2,producer), cat=COALESCE($3,cat), btl=COALESCE($4,btl),
      price_frontline=$5,price_mix12=$6,price_acs3=$7,price_brand3=$8,price_brand5=$9,
      da_frontline=$10,da_mix12=$11,da_acs3=$12,da_brand3=$13,da_brand5=$14,
      stock=CASE WHEN $15::numeric IS NOT NULL THEN stock ELSE stock END,fob_price=$16,laid_in_cost=$17,active=$18,core=$19,
      redemption_entry=$20,bottle_size=$21,upc=$22,image_url=$23,vintage=$25,
      comm_frontline=$26,comm_mix12=$27,comm_acs3=$28,comm_brand3=$29,comm_brand5=$30,
      warehouse=COALESCE($31,warehouse), restricted=$32, spirit_type=$33,
      details_extra=COALESCE(details_extra,'{}'::jsonb) || $34::jsonb
      WHERE sku=$24`,
      [name,producer,cat,btl,
       prices?.frontline||0,prices?.mix12||0,prices?.acs3||0,prices?.brand3||0,prices?.brand5||0,
       da?.frontline||0,da?.mix12||0,da?.acs3||0,da?.brand3||0,da?.brand5||0,
       stock||0,_details?.fobPrice||0,_details?.laidInCost||0,
       _details?.active||'Yes',_details?.core||'No',
       _details?.redemptionEntry||'',_details?.bottleSize||'',_details?.upc||'',
       image||'',
       currentSku,
       _details?.vintage||'',
       prices?.__comm_frontline ?? null, prices?.__comm_mix12 ?? null,
       prices?.__comm_acs3 ?? null, prices?.__comm_brand3 ?? null, prices?.__comm_brand5 ?? null,
       warehouse||null, !!restricted, _details?.spiritType||'',
       JSON.stringify(pickExtraDetails(_details))]);

    // SKU rename -- product_tier_prices cascades automatically via the foreign key (see
    // migrate.js), but order_items.sku has no formal constraint, so it needs updating by hand
    // or historical orders referencing the old SKU would silently stop resolving to a product.
    if (newSku && newSku !== currentSku) {
      const conflict = await getOne('SELECT sku FROM products WHERE sku=$1', [newSku]);
      if (conflict) return res.status(400).json({ ok: false, error: `SKU "${newSku}" is already in use by another product` });
      await query('UPDATE order_items SET sku=$1 WHERE sku=$2', [newSku, currentSku]);
      await query('UPDATE products SET sku=$1 WHERE sku=$2', [newSku, currentSku]);
    }

    res.json({ ok: true, sku: newSku || currentSku });
  } catch (err) {
    console.error('Update product error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/products', requireAdmin, async (req, res) => {
  try {
    const { sku, name, producer, cat, btl, image, warehouse } = req.body;
    if (!sku || !name) return res.status(400).json({ ok: false, error: 'SKU and name required' });
    await query(
      `INSERT INTO products (sku,name,producer,cat,btl,stock,reorder,image_url,warehouse)
       VALUES ($1,$2,$3,$4,$5,0,6,$6,$7)
       ON CONFLICT (sku) DO UPDATE SET name=$2,producer=$3,cat=$4,btl=$5,image_url=$6,warehouse=$7`,
      [sku, name, producer||'', cat||'Spirits', btl||6, image||'', warehouse||'main']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Create product error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/users', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'customer') {
      const cust = await getOne('SELECT acct_id FROM customer_users WHERE id=$1', [req.user.id]);
      const acct = cust ? await getOne('SELECT rep FROM accounts WHERE id=$1', [cust.acct_id]) : null;
      const rep = acct && acct.rep ? await getOne('SELECT id,fname,lname,email FROM users WHERE id=$1', [acct.rep]) : null;
      return res.json({ ok: true, users: rep ? [{ id: rep.id, fname: rep.fname, lname: rep.lname, email: rep.email, role: 'rep' }] : [] });
    }
    const rows = await getAll('SELECT id,fname,lname,email,role,commission,pricing_admin FROM users ORDER BY fname');
    res.json({ ok: true, users: rows.map(r => ({
      id: r.id, fname: r.fname, lname: r.lname, email: r.email,
      role: r.role, commission: parseFloat(r.commission)||5,
      pricingAdmin: !!r.pricing_admin,
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { id, fname, lname, email, password, role, commission, pricingAdmin } = req.body;
    if (!email||!password) return res.status(400).json({ ok: false, error: 'Email and password required' });
    const hash = await bcrypt.hash(password, 10);
    await query(
      'INSERT INTO users (id,fname,lname,email,pw_hash,role,commission,pricing_admin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id||('u'+Date.now()),fname,lname,email.toLowerCase(),hash,role||'rep',commission||5,!!pricingAdmin]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code==='23505') return res.status(400).json({ ok: false, error: 'Email already in use' });
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { fname, lname, email, role, commission, password, pricingAdmin } = req.body;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await query('UPDATE users SET fname=$1,lname=$2,email=$3,role=$4,commission=$5,pw_hash=$6,pricing_admin=$7 WHERE id=$8',
        [fname,lname,email?.toLowerCase(),role,commission,hash,!!pricingAdmin,req.params.id]);
    } else {
      await query('UPDATE users SET fname=$1,lname=$2,email=$3,role=$4,commission=$5,pricing_admin=$6 WHERE id=$7',
        [fname,lname,email?.toLowerCase(),role,commission,!!pricingAdmin,req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/drafts', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const rows = isAdmin
      ? await getAll('SELECT * FROM draft_orders ORDER BY saved_at DESC')
      : await getAll('SELECT * FROM draft_orders WHERE rep_id=$1 ORDER BY saved_at DESC', [req.user.id]);
    res.json({ ok: true, drafts: rows.map(r => ({
      id: r.id, acct: r.acct_id, rep: r.rep_id,
      date: r.date?.toISOString().slice(0,10),
      delivery: r.delivery?.toISOString().slice(0,10),
      po: r.po, notes: r.notes,
      savedAt: r.saved_at?.toISOString().slice(0,10),
      items: r.items||[]
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/drafts', requireAuth, async (req, res) => {
  try {
    const { id, acct, date, delivery, po, notes, items } = req.body;
    await query(
      `INSERT INTO draft_orders (id,acct_id,rep_id,date,delivery,po,notes,items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET items=$8,notes=$7`,
      [id,acct,req.user.id,date,delivery,po||'',notes||'',JSON.stringify(items||[])]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/drafts/:id', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM draft_orders WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/tastings', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const rows = isAdmin
      ? await getAll('SELECT * FROM tastings ORDER BY created_at DESC')
      : await getAll(
          `SELECT t.* FROM tastings t JOIN accounts a ON t.acct_id = a.id
           WHERE a.rep=$1 ORDER BY t.created_at DESC`, [req.user.id]);
    res.json({ ok: true, tastings: rows.map(r => ({
      id: r.id, acct: r.acct_id, rep: r.rep_id,
      date: r.date?.toISOString().slice(0,10),
      notes: r.notes||'',
      createdAt: r.created_at?.toISOString().slice(0,10),
      items: r.items||[]
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/tastings', requireAuth, async (req, res) => {
  try {
    const { id, acct, date, notes, items } = req.body;
    if (!acct) return res.status(400).json({ ok: false, error: 'Account required' });
    const tid = id || ('t'+Date.now());
    await query(
      `INSERT INTO tastings (id,acct_id,rep_id,date,notes,items)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET acct_id=$2,date=$4,notes=$5,items=$6`,
      [tid,acct,req.user.id,date||null,notes||'',JSON.stringify(items||[])]
    );
    res.json({ ok: true, id: tid });
  } catch (err) {
    console.error('Save tasting error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/tastings/:id', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM tastings WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/docs', requireAuth, async (req, res) => {
  try {
    const rows = await getAll('SELECT * FROM shared_docs ORDER BY created_at DESC');
    res.json({ ok: true, docs: rows.map(r => ({
      id: r.id, name: r.name, category: r.category, description: r.description,
      filename: r.filename, dataUrl: r.data_url, sizeLabel: r.size_label,
      uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at?.toISOString().slice(0,10),
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/docs', requireAdmin, async (req, res) => {
  try {
    const { id, name, category, description, filename, dataUrl, sizeLabel, uploadedBy } = req.body;
    await query(
      'INSERT INTO shared_docs (id,name,category,description,filename,data_url,size_label,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id||('doc'+Date.now()),name,category,description,filename,dataUrl,sizeLabel,uploadedBy]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.patch('/docs/:id', requireAdmin, async (req, res) => {
  try {
    const { name, category, description } = req.body;
    await query('UPDATE shared_docs SET name=$1,category=$2,description=$3 WHERE id=$4',
      [name,category,description,req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/docs/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM shared_docs WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/customer-users', requireAdmin, async (req, res) => {
  try {
    const { fname, lname, email, password, acctId } = req.body;
    if (!fname || !email || !password || !acctId) return res.status(400).json({ ok: false, error: 'Name, email, password, and account are required' });
    const emailLower = email.toLowerCase().trim();
    const existing = await getOne('SELECT id FROM users WHERE LOWER(email)=$1', [emailLower]) ||
                     await getOne('SELECT id FROM customer_users WHERE LOWER(email)=$1', [emailLower]);
    if (existing) return res.status(400).json({ ok: false, error: 'An account with this email already exists' });
    const acct = await getOne('SELECT id,name FROM accounts WHERE id=$1', [acctId]);
    if (!acct) return res.status(400).json({ ok: false, error: 'Account not found' });
    const existingPortal = await getOne('SELECT id FROM customer_users WHERE acct_id=$1', [acctId]);
    if (existingPortal) return res.status(400).json({ ok: false, error: 'A portal login already exists for this account' });
    const hash = await bcrypt.hash(password, 10);
    const id = 'c' + Date.now();
    await query(
      'INSERT INTO customer_users (id,fname,lname,email,pw_hash,acct_id,role) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, fname, lname || '', emailLower, hash, acctId, 'customer']
    );
    res.json({ ok: true, id, acctName: acct.name });
  } catch (err) {
    console.error('Create customer login error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/customer-users', requireAdmin, async (req, res) => {
  try {
    const rows = await getAll('SELECT id,fname,lname,email,acct_id,created_at FROM customer_users ORDER BY created_at DESC');
    res.json({ ok: true, customerUsers: rows.map(r => ({
      id: r.id, fname: r.fname, lname: r.lname, email: r.email,
      acctId: r.acct_id, createdAt: r.created_at?.toISOString().slice(0,10)
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/customer-users/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM customer_users WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/admin/backup', requireAdmin, async (req, res) => {
  try {
    // Discover every table dynamically -- guarantees nothing gets missed as the schema grows,
    // rather than relying on a hardcoded list that could go stale.
    const tableRows = await getAll(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
    );
    const backup = { generatedAt: new Date().toISOString(), tables: {} };
    for (const t of tableRows) {
      const rows = await getAll(`SELECT * FROM "${t.table_name}"`);
      backup.tables[t.table_name] = rows;
    }
    const filename = `toasted-backup-${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    console.error('Backup error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -- ACCOUNT CONTACTS -------------------------------------------------------
router.get('/accounts/:id/contacts', requireAuth, async (req, res) => {
  try {
    const rows = await getAll('SELECT * FROM account_contacts WHERE account_id=$1 ORDER BY is_primary DESC, created_at', [req.params.id]);
    res.json({ ok: true, contacts: rows.map(c => ({
      id: c.id, name: c.name || '', title: c.title || '', email: c.email || '', phone: c.phone || '',
      notes: c.notes || '', role: c.role || '', isPrimary: c.is_primary,
    })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
router.post('/accounts/:id/contacts', requireAdmin, async (req, res) => {
  try {
    const { name, title, email, phone, notes, role, isPrimary } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Contact name required' });
    if (isPrimary) await query('UPDATE account_contacts SET is_primary=FALSE WHERE account_id=$1', [req.params.id]);
    const row = await getOne(
      `INSERT INTO account_contacts (account_id,name,title,email,phone,notes,role,is_primary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.params.id, name, title || '', email || '', phone || '', notes || '', role || '', !!isPrimary]
    );
    res.json({ ok: true, id: row.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// Replaces every contact on this account in one call -- used by the account setup form,
// where contacts are drafted locally in a list and saved all at once rather than one at a
// time. Simpler and safer than diffing adds/edits/deletes from the frontend.
router.put('/accounts/:id/contacts', requireAdmin, async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts)) return res.status(400).json({ ok: false, error: 'contacts must be an array' });
    await query('DELETE FROM account_contacts WHERE account_id=$1', [req.params.id]);
    for (const c of contacts) {
      if (!c.name || !c.name.trim()) continue; // skip blank rows
      await query(
        `INSERT INTO account_contacts (account_id,name,title,email,phone,notes,role,is_primary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.params.id, c.name, c.title || '', c.email || '', c.phone || '', c.notes || '', c.role || '', !!c.isPrimary]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
router.patch('/accounts/:id/contacts/:contactId', requireAdmin, async (req, res) => {
  try {
    const { name, title, email, phone, notes, role, isPrimary } = req.body;
    if (isPrimary) await query('UPDATE account_contacts SET is_primary=FALSE WHERE account_id=$1', [req.params.id]);
    await query(
      `UPDATE account_contacts SET name=$1,title=$2,email=$3,phone=$4,notes=$5,role=$6,is_primary=$7 WHERE id=$8 AND account_id=$9`,
      [name, title || '', email || '', phone || '', notes || '', role || '', !!isPrimary, req.params.contactId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
router.delete('/accounts/:id/contacts/:contactId', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM account_contacts WHERE id=$1 AND account_id=$2', [req.params.contactId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -- ACCOUNT ATTACHMENTS -----------------------------------------------------
router.get('/accounts/:id/attachments', requireAuth, async (req, res) => {
  try {
    // Metadata only -- never send file_data in the list, keeps this fast even with several large files
    const rows = await getAll('SELECT id, filename, mime_type, file_size, uploaded_by, uploaded_at FROM account_attachments WHERE account_id=$1 ORDER BY uploaded_at DESC', [req.params.id]);
    res.json({ ok: true, attachments: rows.map(a => ({
      id: a.id, filename: a.filename, mimeType: a.mime_type, fileSize: a.file_size,
      uploadedBy: a.uploaded_by, uploadedAt: a.uploaded_at,
    })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
router.post('/accounts/:id/attachments', requireAdmin, async (req, res) => {
  try {
    const { filename, mimeType, fileData } = req.body;
    if (!filename || !fileData) return res.status(400).json({ ok: false, error: 'File data required' });
    const fileSize = Math.round((fileData.length * 3) / 4); // approx decoded size from base64 length
    const row = await getOne(
      `INSERT INTO account_attachments (account_id,filename,mime_type,file_data,file_size,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.params.id, filename, mimeType || '', fileData, fileSize, req.user.email || req.user.id]
    );
    res.json({ ok: true, id: row.id, fileSize });
  } catch (err) {
    console.error('Upload attachment error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
router.get('/accounts/:id/attachments/:attId/download', requireAuth, async (req, res) => {
  try {
    const row = await getOne('SELECT * FROM account_attachments WHERE id=$1 AND account_id=$2', [req.params.attId, req.params.id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, filename: row.filename, mimeType: row.mime_type, fileData: row.file_data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
router.delete('/accounts/:id/attachments/:attId', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM account_attachments WHERE id=$1 AND account_id=$2', [req.params.attId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// PO RECEIVING -- "PO Received" button on Purchase Orders. Adds what actually arrived to inventory,
// writes the normal inventory-adjustment log entries ("Received Shipment"), and tracks per-PO status
// (Open / Partial / Received). Tables are created on first use, so no migration step is needed.
// Lives here (not in purchaseOrders.js) so the existing PO routes are untouched.
// ============================================================================
let _poRecvReady = null;
function ensurePoReceivingTables() {
  if (!_poRecvReady) {
    _poRecvReady = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS po_sku_map (po_product_id INTEGER PRIMARY KEY, sku TEXT NOT NULL)`);
      await query(`CREATE TABLE IF NOT EXISTS po_receipts (
        id SERIAL PRIMARY KEY, po_id INTEGER NOT NULL, client_id TEXT UNIQUE, received_by TEXT,
        close_short BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW())`);
      await query(`CREATE TABLE IF NOT EXISTS po_receipt_lines (
        id SERIAL PRIMARY KEY, receipt_id INTEGER REFERENCES po_receipts(id) ON DELETE CASCADE,
        po_id INTEGER NOT NULL, line_key TEXT NOT NULL, sku TEXT, bottles_received INTEGER NOT NULL DEFAULT 0)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_po_receipt_lines_po ON po_receipt_lines(po_id)`);
      await query(`CREATE TABLE IF NOT EXISTS po_receive_status (
        po_id INTEGER PRIMARY KEY, status TEXT NOT NULL, closed_short BOOLEAN DEFAULT FALSE,
        received_at TIMESTAMPTZ, received_by TEXT)`);
    })().catch(err => { _poRecvReady = null; throw err; });
  }
  return _poRecvReady;
}
const poLineKey = (productId, description) => productId != null ? String(productId) : 'd:' + (description || '');

router.get('/po-receiving/summary', requireAdmin, async (req, res) => {
  try {
    await ensurePoReceivingTables();
    const [st, rl, mp] = await Promise.all([
      getAll('SELECT po_id, status, closed_short, received_at, received_by FROM po_receive_status'),
      getAll('SELECT po_id, line_key, SUM(bottles_received)::int AS bottles FROM po_receipt_lines GROUP BY po_id, line_key'),
      getAll('SELECT po_product_id, sku FROM po_sku_map'),
    ]);
    const statuses = {}, received = {}, skuMap = {};
    st.forEach(r => { statuses[r.po_id] = { status: r.status, closedShort: !!r.closed_short, receivedAt: r.received_at, receivedBy: r.received_by }; });
    rl.forEach(r => { (received[r.po_id] = received[r.po_id] || {})[r.line_key] = r.bottles; });
    mp.forEach(r => { skuMap[r.po_product_id] = r.sku; });
    res.json({ ok: true, statuses, received, skuMap });
  } catch (err) {
    console.error('PO receiving summary error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/po-receiving/sku-map', requireAdmin, async (req, res) => {
  try {
    await ensurePoReceivingTables();
    const pairs = Array.isArray(req.body.pairs) ? req.body.pairs : [];
    let n = 0;
    for (const p of pairs) {
      const pid = parseInt(p.poProductId);
      if (!pid || !p.sku) continue;
      await query(`INSERT INTO po_sku_map (po_product_id, sku) VALUES ($1,$2)
                   ON CONFLICT (po_product_id) DO UPDATE SET sku=EXCLUDED.sku`, [pid, String(p.sku)]);
      n++;
    }
    res.json({ ok: true, saved: n });
  } catch (err) {
    console.error('PO sku-map error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/po-receiving/:poId/receive', requireAdmin, async (req, res) => {
  try {
    await ensurePoReceivingTables();
    const poId = parseInt(req.params.poId);
    const { clientId, closeShort } = req.body;
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    const po = await getOne('SELECT id, po_number FROM purchase_orders WHERE id=$1', [poId]);
    if (!po) return res.status(404).json({ ok: false, error: 'PO not found' });
    if (!clientId) return res.status(400).json({ ok: false, error: 'Missing receipt id' });

    const toReceive = lines.map(l => ({ lineKey: String(l.lineKey), productId: l.productId != null ? parseInt(l.productId) : null,
      sku: l.sku, bottles: Math.max(0, parseInt(l.bottles) || 0) })).filter(l => l.bottles > 0);
    if (!toReceive.length && !closeShort) return res.status(400).json({ ok: false, error: 'Nothing to receive -- enter at least one quantity' });
    if (toReceive.some(l => !l.sku)) return res.status(400).json({ ok: false, error: 'Every received line needs an inventory product selected' });

    // Check every product exists BEFORE touching anything, so a bad line can't leave the PO half-applied.
    const skus = [...new Set(toReceive.map(l => l.sku))];
    const prods = await getAll(`SELECT sku, name, btl, COALESCE(warehouse,'main') AS warehouse FROM products WHERE sku = ANY($1)`, [skus]);
    const bySku = {}; prods.forEach(p => { bySku[p.sku] = p; });
    const missing = skus.filter(s => !bySku[s]);
    if (missing.length) return res.status(400).json({ ok: false, error: 'Product not found in inventory: ' + missing.join(', ') });

    // Claim this receipt id first. A double-click or an automatic retry carries the same id, finds it
    // already claimed, and is told so instead of adding the stock a second time.
    const by = req.user.fname ? `${req.user.fname} ${req.user.lname || ''}`.trim() : (req.user.email || '');
    const claim = await getOne(
      `INSERT INTO po_receipts (po_id, client_id, received_by, close_short) VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_id) DO NOTHING RETURNING id`, [poId, String(clientId), by, !!closeShort]);
    if (!claim) return res.json({ ok: true, duplicate: true });

    const results = [];
    for (const l of toReceive) {
      const p = bySku[l.sku];
      const btl = parseInt(p.btl) || 12;
      const deltaCases = l.bottles / btl;                       // stock is kept in cases
      const r = await query(`UPDATE products SET stock = stock + $1::numeric WHERE sku=$2 RETURNING stock`, [deltaCases, l.sku]);
      await query('INSERT INTO po_receipt_lines (receipt_id, po_id, line_key, sku, bottles_received) VALUES ($1,$2,$3,$4,$5)',
        [claim.id, poId, l.lineKey, l.sku, l.bottles]);
      try {
        await query(
          `INSERT INTO stock_adjustments (sku, warehouse, cases, bottles, sign, reason, notes, by_user_id, by_name)
           VALUES ($1,$2,$3,$4,1,'Received Shipment',$5,$6,$7)`,
          [l.sku, p.warehouse, Math.floor(l.bottles / btl), l.bottles % btl, 'PO ' + po.po_number, req.user.id, by]);
      } catch (e) { console.error('PO receive: adjustment log insert failed (stock WAS updated):', e.message); }
      // Remember the PO-product -> inventory-product pairing so next time it's pre-filled.
      if (l.productId != null) {
        await query(`INSERT INTO po_sku_map (po_product_id, sku) VALUES ($1,$2)
                     ON CONFLICT (po_product_id) DO UPDATE SET sku=EXCLUDED.sku`, [l.productId, l.sku]);
      }
      results.push({ sku: l.sku, stock: parseFloat(r.rows[0].stock) });
    }

    // Full or partial? Compare everything received on this PO (all receipts) with what was ordered.
    const ordered = await getAll('SELECT product_id, description, quantity_bottles, quantity_cases, bottles_per_case FROM po_line_items WHERE po_id=$1', [poId]);
    const got = await getAll('SELECT line_key, SUM(bottles_received)::int AS b FROM po_receipt_lines WHERE po_id=$1 GROUP BY line_key', [poId]);
    const gotBy = {}; got.forEach(g => { gotBy[g.line_key] = g.b; });
    const complete = ordered.every(o => {
      const need = (parseFloat(o.quantity_cases) || 0) * (o.bottles_per_case || 6) + (o.quantity_bottles || 0);
      return need <= 0 || (gotBy[poLineKey(o.product_id, o.description)] || 0) >= Math.round(need);
    });
    const status = (complete || closeShort) ? 'received' : 'partial';
    const closedShort = !!closeShort && !complete;
    await query(
      `INSERT INTO po_receive_status (po_id, status, closed_short, received_at, received_by) VALUES ($1,$2,$3,NOW(),$4)
       ON CONFLICT (po_id) DO UPDATE SET status=EXCLUDED.status, closed_short=EXCLUDED.closed_short, received_at=NOW(), received_by=EXCLUDED.received_by`,
      [poId, status, closedShort, by]);
    res.json({ ok: true, status, closedShort, stocks: results });
  } catch (err) {
    console.error('PO receive error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


module.exports = router;
