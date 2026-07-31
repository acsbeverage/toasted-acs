const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, getOne, getAll } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/accounts', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const rows = isAdmin
      ? await getAll('SELECT * FROM accounts ORDER BY name')
      : await getAll('SELECT * FROM accounts WHERE rep=$1 ORDER BY name', [req.user.id]);
    res.json({ ok: true, accounts: rows.map(r => ({
      id: r.id, name: r.name, code: r.code, lic: r.lic, abcNum: r.abc_num,
      contact: r.contact, contactFirst: r.contact_first, contactLast: r.contact_last,
      phone: r.phone, email: r.email, address: r.address,
      shipStreet: r.ship_street, shipCity: r.ship_city, shipState: r.ship_state, shipZip: r.ship_zip,
      billStreet: r.bill_street, billCity: r.bill_city, billState: r.bill_state, billZip: r.bill_zip,
      terms: r.terms, rep: r.rep, qboId: r.qbo_id,
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.patch('/accounts/:id', requireAdmin, async (req, res) => {
  try {
    const { name, contact, phone, email, terms, rep, shipStreet, shipCity, shipState, shipZip } = req.body;
    await query(`UPDATE accounts SET name=$1,contact=$2,phone=$3,email=$4,terms=$5,
      rep=$6,ship_street=$7,ship_city=$8,ship_state=$9,ship_zip=$10 WHERE id=$11`,
      [name,contact,phone,email,terms,rep,shipStreet,shipCity,shipState,shipZip,req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/products', requireAuth, async (req, res) => {
  try {
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
      da: {
        frontline: parseFloat(r.da_frontline)||0,
        mix12: parseFloat(r.da_mix12)||0,
        acs3: parseFloat(r.da_acs3)||0,
        brand3: parseFloat(r.da_brand3)||0,
        brand5: parseFloat(r.da_brand5)||0,
      },
      _details: {
        redemptionEntry: r.redemption_entry||'',
        bottleSize: r.bottle_size||'',
        upc: r.upc||'',
        fobPrice: parseFloat(r.fob_price)||0,
        laidInCost: parseFloat(r.laid_in_cost)||0,
        active: r.active||'Yes',
        core: r.core||'No',
      }
    }))});
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.patch('/products/:sku', requireAdmin, async (req, res) => {
  try {
    const { prices, da, stock, _details } = req.body;
    await query(`UPDATE products SET
      price_frontline=$1,price_mix12=$2,price_acs3=$3,price_brand3=$4,price_brand5=$5,
      da_frontline=$6,da_mix12=$7,da_acs3=$8,da_brand3=$9,da_brand5=$10,
      stock=$11,fob_price=$12,laid_in_cost=$13,active=$14,core=$15,
      redemption_entry=$16,bottle_size=$17,upc=$18 WHERE sku=$19`,
      [prices?.frontline||0,prices?.mix12||0,prices?.acs3||0,prices?.brand3||0,prices?.brand5||0,
       da?.frontline||0,da?.mix12||0,da?.acs3||0,da?.brand3||0,da?.brand5||0,
       stock||0,_details?.fobPrice||0,_details?.laidInCost||0,
       _details?.active||'Yes',_details?.core||'No',
       _details?.redemptionEntry||'',_details?.bottleSize||'',_details?.upc||'',
       req.params.sku]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/users', requireAuth, async (req, res) => {
  try {
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
