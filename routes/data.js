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
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});
router.post('/accounts', requireAdmin, async (req, res) => {
  try {
    const { id, name, code, lic, contact, contactFirst, contactLast, phone, email, address,
            shipStreet, shipCity, shipState, shipZip, billStreet, billCity, billState, billZip,
            terms, rep } = req.body;
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
        ship_street,ship_city,ship_state,ship_zip,bill_street,bill_city,bill_state,bill_zip,terms,rep)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [acctId, name, acctCode, lic||'', contact||'', contactFirst||'', contactLast||'', phone||'', email||'', address||'',
       shipStreet||'', shipCity||'', shipState||'', shipZip||'', billStreet||'', billCity||'', billState||'', billZip||'',
       terms||'Net 30', rep||null]
    );
    res.json({ ok: true, id: acctId, code: acctCode });
  } catch (err) {
    console.error('Create account error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.patch('/accounts/:id', requireAdmin, async (req, res) => {
  try {
    const { name, code, contact, phone, email, terms, rep, shipStreet, shipCity, shipState, shipZip,
            paymentProvider, onlinePayments, redemption, taxId, resaleNum, warehouseCode,
            licExpiry, abcDetail, creditLimit, creditBalance, avgDaysToPay, commissionPct } = req.body;
    if (code !== undefined) {
      const trimmed = String(code).trim();
      if (trimmed) {
        const clash = await getOne('SELECT id FROM accounts WHERE code=$1 AND id<>$2', [trimmed, req.params.id]);
        if (clash) return res.status(400).json({ ok: false, error: 'That account number is already in use' });
      }
    }
    await query(`UPDATE accounts SET
      name=COALESCE($1,name), code=COALESCE($24,code), contact=COALESCE($2,contact),
      phone=COALESCE($3,phone), email=COALESCE($4,email),
      terms=COALESCE($5,terms), rep=COALESCE($6,rep),
      ship_street=COALESCE($7,ship_street), ship_city=COALESCE($8,ship_city),
      ship_state=COALESCE($9,ship_state), ship_zip=COALESCE($10,ship_zip),
      payment_provider=$11, online_payments=$12, redemption=$13,
      tax_id=$14, resale_num=$15, warehouse_code=$16, lic_expiry=$17,
      abc_detail=$18, credit_limit=$19, credit_balance=$20,
      avg_days_to_pay=$21, commission_pct=$22
      WHERE id=$23`,
      [name,contact,phone,email,terms,rep,shipStreet,shipCity,shipState,shipZip,
       paymentProvider||'',onlinePayments||'No',redemption||'No',taxId||'',
       resaleNum||'',warehouseCode||'',licExpiry||'',abcDetail||'',
       creditLimit||0,creditBalance||0,avgDaysToPay||0,commissionPct||0,
       req.params.id,code]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update account error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});


router.get('/products', requireAuth, async (req, res) => {
  try {
    const isCustomer = req.user.role === 'customer';
    const rows = await getAll('SELECT * FROM products ORDER BY name');
    res.json({ ok: true, products: rows.map(r => ({
      sku: r.sku, name: r.name, producer: r.producer, cat: r.cat,
      btl: r.btl, stock: parseFloat(r.stock)||0, reorder: r.reorder,
      prices: {
        frontline: parseFloat(r.price_frontline)||0,
        mix12: parseFloat(r.price_mix12)||0,
        acs3: parseFloat(r.price_acs3)||0,
        brand3: parseFloat(r.price_brand3)||0,
        brand5: parseFloat(r.price_brand5)||0,
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
      } : {
        redemptionEntry: r.redemption_entry||'',
        bottleSize: r.bottle_size||'',
        upc: r.upc||'',
        fobPrice: parseFloat(r.fob_price)||0,
        laidInCost: parseFloat(r.laid_in_cost)||0,
        active: r.active||'Yes',
        core: r.core||'No',
      },
      image: r.image_url||'',
    }))});
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

router.patch('/products/:sku', requireAdmin, async (req, res) => {
  try {
    const { name, producer, cat, btl, prices, da, stock, _details, image } = req.body;
    await query(`UPDATE products SET
      name=COALESCE($1,name), producer=COALESCE($2,producer), cat=COALESCE($3,cat), btl=COALESCE($4,btl),
      price_frontline=$5,price_mix12=$6,price_acs3=$7,price_brand3=$8,price_brand5=$9,
      da_frontline=$10,da_mix12=$11,da_acs3=$12,da_brand3=$13,da_brand5=$14,
      stock=$15,fob_price=$16,laid_in_cost=$17,active=$18,core=$19,
      redemption_entry=$20,bottle_size=$21,upc=$22,image_url=$23 WHERE sku=$24`,
      [name,producer,cat,btl,
       prices?.frontline||0,prices?.mix12||0,prices?.acs3||0,prices?.brand3||0,prices?.brand5||0,
       da?.frontline||0,da?.mix12||0,da?.acs3||0,da?.brand3||0,da?.brand5||0,
       stock||0,_details?.fobPrice||0,_details?.laidInCost||0,
       _details?.active||'Yes',_details?.core||'No',
       _details?.redemptionEntry||'',_details?.bottleSize||'',_details?.upc||'',
       image||'',
       req.params.sku]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update product error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
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
    const rows = await getAll('SELECT id,fname,lname,email,role,commission FROM users ORDER BY fname');
    res.json({ ok: true, users: rows.map(r => ({
      id: r.id, fname: r.fname, lname: r.lname, email: r.email,
      role: r.role, commission: parseFloat(r.commission)||5
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { id, fname, lname, email, password, role, commission } = req.body;
    if (!email||!password) return res.status(400).json({ ok: false, error: 'Email and password required' });
    const hash = await bcrypt.hash(password, 10);
    await query(
      'INSERT INTO users (id,fname,lname,email,pw_hash,role,commission) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id||('u'+Date.now()),fname,lname,email.toLowerCase(),hash,role||'rep',commission||5]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code==='23505') return res.status(400).json({ ok: false, error: 'Email already in use' });
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { fname, lname, email, role, commission, password } = req.body;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await query('UPDATE users SET fname=$1,lname=$2,email=$3,role=$4,commission=$5,pw_hash=$6 WHERE id=$7',
        [fname,lname,email?.toLowerCase(),role,commission,hash,req.params.id]);
    } else {
      await query('UPDATE users SET fname=$1,lname=$2,email=$3,role=$4,commission=$5 WHERE id=$6',
        [fname,lname,email?.toLowerCase(),role,commission,req.params.id]);
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
