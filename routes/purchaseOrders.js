const express = require('express');
const router = express.Router();
const { query, getOne, getAll } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const sgMail = require('@sendgrid/mail');

const FROM_EMAIL = process.env.PO_FROM_EMAIL || 'purchasing@acsbeverage.com';
const FROM_NAME = process.env.PO_FROM_NAME || 'ACS Beverage Co. Purchasing';
const NOTIFY_EMAILS = (process.env.PO_CC_EMAILS || 'accounting@acsbeverage.com,jessica@acsbeverage.com')
  .split(',').map(e => e.trim()).filter(Boolean);

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
      grandTotal: parseFloat(r.grand_total) || 0, notes: r.notes || '',
      emailStatus: r.email_status || 'pending', emailSentAt: r.email_sent_at
    })) });
  } catch (err) {
    console.error('List POs error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const po = await getOne(`
      SELECT po.*, s.name as supplier_name, s.contact_email
      FROM purchase_orders po LEFT JOIN po_suppliers s ON po.supplier_id = s.id
      WHERE po.id=$1`, [req.params.id]);
    if (!po) return res.status(404).json({ ok: false, error: 'PO not found' });
    const items = await getAll('SELECT * FROM po_line_items WHERE po_id=$1 ORDER BY sort_order', [req.params.id]);
    res.json({ ok: true, order: {
      id: po.id, poNumber: po.po_number, poDate: po.po_date, paymentTerms: po.payment_terms,
      supplierId: po.supplier_id, supplierName: po.supplier_name || '--',
      supplierContactEmail: po.contact_email || '',
      deliveryAddress: po.delivery_address,
      totalBottles: po.total_bottles, totalCases: parseFloat(po.total_cases) || 0,
      grandTotal: parseFloat(po.grand_total) || 0, notes: po.notes || '',
      emailStatus: po.email_status || 'pending', emailSentAt: po.email_sent_at,
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

router.post('/orders/:id/send-email', requireAdmin, async (req, res) => {
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) return res.status(400).json({ ok: false, error: 'PDF data required' });

    const po = await getOne(`
      SELECT po.*, s.name as supplier_name, s.contact_email
      FROM purchase_orders po LEFT JOIN po_suppliers s ON po.supplier_id = s.id
      WHERE po.id=$1`, [req.params.id]);
    if (!po) return res.status(404).json({ ok: false, error: 'PO not found' });
    if (!po.contact_email) return res.status(400).json({ ok: false, error: 'This supplier has no contact email set -- add one in Suppliers & Products first' });
    if (!process.env.SENDGRID_API_KEY) return res.status(500).json({ ok: false, error: 'Email is not configured on the server' });

    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const dateStr = po.po_date ? new Date(po.po_date).toLocaleDateString('en-US') : '';
    const totalStr = '$' + (parseFloat(po.grand_total) || 0).toFixed(2);

    try {
      await sgMail.send({
        to: po.contact_email,
        cc: NOTIFY_EMAILS,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: `Purchase Order ${po.po_number} — ACS Beverage Co.`,
        text: `Please find attached Purchase Order ${po.po_number} from ACS Beverage Co., dated ${dateStr}.\n\n` +
              `PO Number: ${po.po_number}\nSupplier: ${po.supplier_name}\nDate: ${dateStr}\nTotal: ${totalStr}\n\n` +
              `Please send all invoices to accounting@acsbeverage.com. Invoices are reviewed and paid on a weekly cycle.\n\n` +
              `Enter this order in accordance with the prices, terms, delivery method, and specifications listed in the attached PDF. Please notify us immediately if you are unable to ship as specified.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1a1a1a">
          <div style="background:#2C2C2C;padding:16px 24px;margin-bottom:24px">
            <span style="color:#fff;font-size:18px;font-weight:bold;letter-spacing:1px">ACS BEVERAGE CO.</span>
          </div>
          <div style="line-height:1.6;font-size:14px">
            <p>Hello,</p>
            <p>Please find attached Purchase Order <strong>${po.po_number}</strong> from ACS Beverage Co., dated ${dateStr}.</p>
            <p>PO Number: ${po.po_number}<br/>Supplier: ${po.supplier_name}<br/>Date: ${dateStr}<br/>Total: ${totalStr}</p>
            <p>Please send all invoices to <a href="mailto:accounting@acsbeverage.com" style="color:#C0392B">accounting@acsbeverage.com</a>. Invoices are reviewed and paid on a weekly cycle.</p>
            <p>Enter this order in accordance with the prices, terms, delivery method, and specifications listed in the attached PDF. Please notify us immediately if you are unable to ship as specified.</p>
          </div>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
          <p style="font-size:11px;color:#999">ACS Beverage Co. &middot; 531 Getty Ct. Suite D, Benicia CA 94510</p>
        </div>`,
        attachments: [{
          filename: po.po_number.replace(/\s+/g, '_') + '.pdf',
          content: pdfBase64,
          type: 'application/pdf',
          disposition: 'attachment'
        }]
      });
      await query('UPDATE purchase_orders SET email_status=$1, email_sent_at=NOW() WHERE id=$2', ['sent', req.params.id]);
      res.json({ ok: true });
    } catch (sendErr) {
      console.error('Send PO email error:', sendErr.response?.body || sendErr.message);
      await query('UPDATE purchase_orders SET email_status=$1 WHERE id=$2', ['failed', req.params.id]);
      res.status(500).json({ ok: false, error: 'Email failed to send -- check the supplier contact email is valid' });
    }
  } catch (err) {
    console.error('Send PO email error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
