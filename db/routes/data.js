const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, getOne, getAll } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// ── ACCOUNTS ──────────────────────────────────────────────────────────────────
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
      [name, contact, phone, email, terms, rep, shipStreet, shipCity, shipState, shipZip, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────────
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

route
