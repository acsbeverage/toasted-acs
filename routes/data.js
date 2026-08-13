const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, getOne, getAll } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

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
      terms: r.terms, rep: r.rep, qboId: r.qbo_id,paymentProvider: r.payment_provider||'',
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
  } catch (err) {
    console.error('Create account error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
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
      lic:'lic', abcNum:'abc_num',
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


router.get('/products', requireAuth, async (req, res) => {
  try {
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
        : 'SELECT * FROM product_tier_prices WHERE rep_visible=TRUE ORDER BY sort_order, tier_name'
    );
    const tiersBySku = {};
    tierRows.forEach(t => {
      if (!tiersBySku[t.sku]) tiersBySku[t.sku] = [];
      tiersBySku[t.sku].push({
        name: t.tier_name,
        price: parseFloat(t.price) || 0,
        da: parseFloat(t.da_amount) || 0,
        repVisible: t.rep_visible,
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
      } : {
        redemptionEntry: r.redemption_entry||'',
        bottleSize: r.bottle_size||'',
        upc: r.upc||'',
        fobPrice: parseFloat(r.fob_price)||0,
        laidInCost: parseFloat(r.laid_in_cost)||0,
        active: r.active||'Yes',
        core: r.core||'No',
        vintage: r.vintage||'',
      },
      image: r.image_url||'',
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/product-tier-prices', requireAdmin, async (req, res) => {
  try {
    const sku = req.query.sku;
    if (!sku) return res.status(400).json({ ok: false, error: 'SKU required' });
    const rows = await getAll(
      `SELECT * FROM product_tier_prices WHERE sku=$1 ORDER BY tier_name`,
      [sku]
    );
    // Resolve account names for display in one batch, rather than a query per row
    const allAcctIds = [...new Set(rows.flatMap(r => r.account_ids || []))];
    let acctNameById = {};
    if (allAcctIds.length) {
      const acctRows = await getAll(`SELECT id, name FROM accounts WHERE id = ANY($1)`, [allAcctIds]);
      acctRows.forEach(a => { acctNameById[a.id] = a.name; });
    }
    res.json({ ok: true, tiers: rows.map(t => ({
      id: t.id, sku: t.sku, tierName: t.tier_name,
      price: parseFloat(t.price) || 0, da: parseFloat(t.da_amount) || 0,
      repVisible: t.rep_visible,
      accountIds: t.account_ids || [],
      accountNames: (t.account_ids || []).map(id => acctNameById[id] || id),
      corpGroups: t.corp_groups || [],
    })) });
  } catch (err) {
    console.error('List pricing lanes error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/product-tier-prices', requireAdmin, async (req, res) => {
  try {
    const { sku, tierName, price, da, accountIds, corpGroups, repVisible } = req.body;
    if (!sku || !tierName || !tierName.trim()) return res.status(400).json({ ok: false, error: 'Product and pricing lane name are required' });
    const row = await getOne(
      `INSERT INTO product_tier_prices (sku, tier_name, price, da_amount, rep_visible, account_ids, corp_groups)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [sku, tierName, price || 0, da || 0, !!repVisible, accountIds || [], corpGroups || []]
    );
    res.json({ ok: true, id: row.id });
  } catch (err) {
    console.error('Create pricing lane error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/product-tier-prices/:id', requireAdmin, async (req, res) => {
  try {
    const { tierName, price, da, accountIds, corpGroups, repVisible } = req.body;
    if (!tierName || !tierName.trim()) return res.status(400).json({ ok: false, error: 'Pricing lane name is required' });
    await query(
      `UPDATE product_tier_prices SET tier_name=$1, price=$2, da_amount=$3, rep_visible=$4, account_ids=$5, corp_groups=$6, updated_at=NOW() WHERE id=$7`,
      [tierName, price || 0, da || 0, !!repVisible, accountIds || [], corpGroups || [], req.params.id]
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

router.patch('/products/:sku', requireAdmin, async (req, res) => {
  try {
    const { name, producer, cat, btl, prices, da, stock, _details, image, warehouse, restricted } = req.body;
    await query(`UPDATE products SET
      name=COALESCE($1,name), producer=COALESCE($2,producer), cat=COALESCE($3,cat), btl=COALESCE($4,btl),
      price_frontline=$5,price_mix12=$6,price_acs3=$7,price_brand3=$8,price_brand5=$9,
      da_frontline=$10,da_mix12=$11,da_acs3=$12,da_brand3=$13,da_brand5=$14,
      stock=$15,fob_price=$16,laid_in_cost=$17,active=$18,core=$19,
      redemption_entry=$20,bottle_size=$21,upc=$22,image_url=$23,vintage=$25,
      comm_frontline=$26,comm_mix12=$27,comm_acs3=$28,comm_brand3=$29,comm_brand5=$30,
      warehouse=COALESCE($31,warehouse), restricted=$32
      WHERE sku=$24`,
      [name,producer,cat,btl,
       prices?.frontline||0,prices?.mix12||0,prices?.acs3||0,prices?.brand3||0,prices?.brand5||0,
       da?.frontline||0,da?.mix12||0,da?.acs3||0,da?.brand3||0,da?.brand5||0,
       stock||0,_details?.fobPrice||0,_details?.laidInCost||0,
       _details?.active||'Yes',_details?.core||'No',
       _details?.redemptionEntry||'',_details?.bottleSize||'',_details?.upc||'',
       image||'',
       req.params.sku,
       _details?.vintage||'',
       prices?.__comm_frontline ?? null, prices?.__comm_mix12 ?? null,
       prices?.__comm_acs3 ?? null, prices?.__comm_brand3 ?? null, prices?.__comm_brand5 ?? null,
       warehouse||null, !!restricted]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update product error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/products', requireAdmin, async (req, res) => {
  try {
    const { sku, name, producer, cat, btl, image } = req.body;
    if (!sku || !name) return res.status(400).json({ ok: false, error: 'SKU and name required' });
    await query(
      `INSERT INTO products (sku,name,producer,cat,btl,stock,reorder,image_url)
       VALUES ($1,$2,$3,$4,$5,0,6,$6)
       ON CONFLICT (sku) DO UPDATE SET name=$2,producer=$3,cat=$4,btl=$5,image_url=$6`,
      [sku, name, producer||'', cat||'Spirits', btl||6, image||'']
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
      : await getAll('SELECT * FROM tastings WHERE rep_id=$1 ORDER BY created_at DESC', [req.user.id]);
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

module.exports = router;
