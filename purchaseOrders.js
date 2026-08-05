const express = require('express');
const router = express.Router();
const { query, getOne, getAll } = require('../db');
const { requireAdmin } = require('../middleware/auth');

// All Purchase Order routes are admin-only.

// ── SUPPLIERS ─────────────────────────────────────────────────────────────────
router.get('/suppliers', requireAdmin, async (req, res) => {
  try {
    const rows = await getAll('SELECT * FROM po_suppliers ORDER BY name');
    res.json({ ok: true, suppliers: rows.map(r => ({
      id: r.id, name: r.name, paymentTerms: r.payment_terms,
      contactName: r.contact_name || '', contactEmail: r.contact_email || '',
      contactPhone: r.contact_phone || '', address: r.address || ''
    })) });
  } catch (err) {
    console.error('List suppliers error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/suppliers', requireAdmin, async (req, res) => {
  try {
    const { name, paymentTerms, contactName, contactEmail, contactPhone, address } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'Supplier name required' });
    const row = await getOne(
      `INSERT INTO po_suppliers (name,payment_terms,contact_name,contact_email,contact_phone,address)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, paymentTerms || 'Net 30', contactName || '', contactEmail || '', contactPhone || '', address || '']
    );
    res.json({ ok: true, id: row.id });
  } catch (err) {
    console.error('Create supplier error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.patch('/suppliers/:id', requireAdmin, async (req, res) => {
  try {
    const { name, paymentTerms, contactName, contactEmail, contactPhone, address } = req.body;
    await query(
      `UPDATE po_suppliers SET name=$1,payment_terms=$2,contact_name=$3,contact_email=$4,contact_phone=$5,address=$6 WHERE id=$7`,
      [name, paymentTerms || 'Net 30', contactName || '', contactEmail || '', contactPhone || '', address || '', req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Update supplier error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/suppliers/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM po_suppliers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete supplier error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────────
router.get('/products', requireAdmin, async (req, res) => {
  try {
    const supplierId = req.query.supplierId;
    const rows = supplierId
      ? await getAll('SELECT * FROM po_products WHERE supplier_id=$1 AND is_active=TRUE ORDER BY description', [supplierId])
      : await getAll('SELECT * FROM po_products WHERE is_active=TRUE ORDER BY description');
    res.json({ ok: true, products: rows.map(r => ({
      id: r.id, supplierId: r.supplier_id, brandName: r.brand_name || '',
      vintage: r.vintage || '', type: r.type || 'Spirits',
      bottleSize: r.bottle_size || '750ml', bottlesPerCase: r.bottles_per_case || 6,
      description: r.description, casePrice: parseFloat(r.case_price) || 0,
      bottlePrice: parseFloat(r.bottle_price) || 0
    })) });
  } catch (err) {
    console.error('List products error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/products', requireAdmin, async (req, res) => {
  try {
    const { supplierId, brandName, vintage, type, bottleSize, bottlesPerCase, description, casePrice, bottlePrice } = req.body;
    if (!supplierId || !description) return res.status(400).json({ ok: false, error: 'Supplier and description required' });
    const row = await getOne(
      `INSERT INTO po_products (supplier_id,brand_name,vintage,type,bottle_size,bottles_per_case,description,case_price,bottle_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [supplierId, brandName || '', vintage || null, type || 'Spirits', bottleSize || '750ml',
       bottlesPerCase || 6, description, casePrice || 0, bottlePrice || 0]
    );
    res.json({ ok: true, id: row.id });
  } catch (err) {
    console.error('Create product error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.patch('/products/:id', requireAdmin, async (req, res) => {
  try {
    const { brandName, vintage, type, bottleSize, bottlesPerCase, description, casePrice, bottlePrice } = req.body;
    await query(
      `UPDATE po_products SET brand_name=$1,vintage=$2,type=$3,bottle_size=$4,bottles_per_case=$5,
       description=$6,case_price=$7,bottle_price=$8 WHERE id=$9`,
      [brandName || '', vintage || null, type || 'Spirits', bottleSize || '750ml',
       bottlesPerCase || 6, description, casePrice || 0, bottlePrice || 0, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Update product error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/products/:id', requireAdmin, async (req, res) => {
  try {
    await query('UPDATE po_products SET is_active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete product error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PO NUMBER SEQUENCE ────────────────────────────────────────────────────────
router.get('/next-number', requireAdmin, async (req, res) => {
  try {
    const row = await getOne('SELECT next_seq FROM po_sequence WHERE id=1');
    res.json({ ok: true, poNumber: `ACS ${String(row.next_seq).padStart(3, '0')}` });
  } catch (err) {
    console.error('Get next PO number error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PURCHASE ORDERS ───────────────────────────────────────────────────────────
router.get('/orders', requireAdmin, async (req, res) => {
  try {
    const rows = await getAll(`
      SELECT po.*, s.name as supplier_name
      FROM purchase_orders po
      LEFT JOIN po_suppliers s ON po.supplier_id = s.id
      ORDER BY po.created_at DESC`);
    res.json({ ok: true, orders: rows.map(r => ({
      id: r.id, poNumber: r.po_number, poDate: r.po_date, paymentTerms: r.payment_terms,
      supplierId: r.supplier_id, supplierName: r.supplier_name || '--',
      deliveryAddress: r.delivery_address,
      totalBottles: r.total_bottles, totalCases: parseFloat(r.total_cases) || 0,
      grandTotal: parseFloat(r.grand_total) || 0, notes: r.notes || ''
    })) });
  } catch (err) {
    console.error('List POs error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const po = await getOne(`
      SELECT po.*, s.name as supplier_name
      FROM purchase_orders po LEFT JOIN po_suppliers s ON po.supplier_id = s.id
      WHERE po.id=$1`, [req.params.id]);
    if (!po) return res.status(404).json({ ok: false, error: 'PO not found' });
    const items = await getAll('SELECT * FROM po_line_items WHERE po_id=$1 ORDER BY sort_order', [req.params.id]);
    res.json({ ok: true, order: {
      id: po.id, poNumber: po.po_number, poDate: po.po_date, paymentTerms: po.payment_terms,
      supplierId: po.supplier_id, supplierName: po.supplier_name || '--',
      deliveryAddress: po.delivery_address,
      totalBottles: po.total_bottles, totalCases: parseFloat(po.total_cases) || 0,
      grandTotal: parseFloat(po.grand_total) || 0, notes: po.notes || '',
      lineItems: items.map(i => ({
        productId: i.product_id, brandName: i.brand_name, vintage: i.vintage, type: i.type,
        bottleSize: i.bottle_size, bottlesPerCase: i.bottles_per_case, description: i.description,
        quantityBottles: i.quantity_bottles, quantityCases: parseFloat(i.quantity_cases) || 0,
        casePrice: i.case_price !== null ? parseFloat(i.case_price) : null,
        bottlePrice: i.bottle_price !== null ? parseFloat(i.bottle_price) : null,
        lineTotal: parseFloat(i.line_total) || 0, isNoCharge: i.is_no_charge
      }))
    }});
  } catch (err) {
    console.error('Get PO error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/orders', requireAdmin, async (req, res) => {
  try {
    const { supplierId, paymentTerms, deliveryAddress, notes, totalBottles, totalCases, grandTotal, lineItems } = req.body;
    if (!supplierId) return res.status(400).json({ ok: false, error: 'Supplier required' });
    if (!Array.isArray(lineItems) || !lineItems.length) return res.status(400).json({ ok: false, error: 'At least one line item required' });

    // Atomically claim the next PO number
    const seqRow = await getOne('UPDATE po_sequence SET next_seq = next_seq + 1 WHERE id=1 RETURNING next_seq - 1 as claimed');
    const poNumber = `ACS ${String(seqRow.claimed).padStart(3, '0')}`;

    const po = await getOne(
      `INSERT INTO purchase_orders (po_number,payment_terms,supplier_id,delivery_address,notes,total_bottles,total_cases,grand_total,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [poNumber, paymentTerms || 'Net 30', supplierId, deliveryAddress || '', notes || '',
       totalBottles || 0, totalCases || 0, grandTotal || 0, req.user.email]
    );

    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      await query(`
        INSERT INTO po_line_items (po_id,product_id,brand_name,vintage,type,bottle_size,bottles_per_case,
          description,quantity_bottles,quantity_cases,case_price,bottle_price,line_total,is_no_charge,sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [po.id, item.productId || null, item.brandName || '', item.vintage || null, item.type || 'Spirits',
         item.bottleSize || '750ml', item.bottlesPerCase || 6, item.description || '',
         item.quantityBottles || 0, item.quantityCases || 0,
         item.isNoCharge ? null : (item.casePrice || 0), item.isNoCharge ? null : (item.bottlePrice || 0),
         item.lineTotal || 0, !!item.isNoCharge, i]);
    }

    res.json({ ok: true, id: po.id, poNumber });
  } catch (err) {
    console.error('Create PO error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
