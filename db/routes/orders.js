const router = require('express').Router();
const { query, getOne, getAll } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const sgMail = require('@sendgrid/mail');

const FROM_EMAIL    = process.env.FROM_EMAIL || 'accounting@acsbeverage.com';
const FROM_NAME     = process.env.FROM_NAME  || 'Toasted — ACS Beverage Co.';
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || 'kevin@acsbeverage.com,jessica@acsbeverage.com')
  .split(',').map(e => e.trim()).filter(Boolean);

// GET /api/orders
router.get('/', requireAuth, async (req, res) => {
  try {
    const isAdmin    = req.user.role === 'admin';
    const isCustomer = req.user.role === 'customer';
    let rows;

    if (isAdmin) {
      rows = await getAll(`
        SELECT o.*, a.name as acct_name, u.fname as rep_fname, u.lname as rep_lname
        FROM orders o
        LEFT JOIN accounts a ON o.acct_id = a.id
        LEFT JOIN users u ON o.rep_id = u.id
        ORDER BY o.created_at DESC
      `);
    } else if (isCustomer) {
      const cust = await getOne('SELECT acct_id FROM customer_users WHERE id=$1', [req.user.id]);
      if (!cust) return res.json({ ok: true, orders: [] });
      rows = await getAll(`
        SELECT o.*, a.name as acct_name
        FROM orders o
        LEFT JOIN accounts a ON o.acct_id = a.id
        WHERE o.acct_id=$1 ORDER BY o.created_at DESC
      `, [cust.acct_id]);
    } else {
      rows = await getAll(`
        SELECT o.*, a.name as acct_name, u.fname as rep_fname, u.lname as rep_lname
        FROM orders o
        LEFT JOIN accounts a ON o.acct_id = a.id
        LEFT JOIN users u ON o.rep_id = u.id
        WHERE o.rep_id=$1 ORDER BY o.created_at DESC
      `, [req.user.id]);
    }

    const orderIds = rows.map(r => r.id);
    let items = [];
    if (orderIds.length > 0) {
      items = await getAll(
        `SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY sort_order`,
        [orderIds]
      );
    }

    const itemsByOrder = {};
    items.forEach(item => {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push({
        sku: item.sku, cases: item.cases, bottles: item.bottles,
        tier: item.tier, discountPct: parseFloat(item.discount_pct)||0,
        _fee: item.is_fee, feeAmt: item.fee_amt ? parseFloat(item.fee_amt) : undefined,
        count: item.fee_count, _manual: item.is_manual,
        rate: item.rate ? parseFloat(item.rate) : undefined,
      });
    });

    const orders = rows.map(r => ({
      id: r.id, acct: r.acct_id, acctName: r.acct_name,
      rep: r.rep_id, repName: r.rep_fname ? r.rep_fname+' '+(r.rep_lname||'') : '',
      date: r.date ? r.date.toISOString().slice(0,10) : '',
      delivery: r.delivery ? r.delivery.toISOString().slice(0,10) : '',
      status: r.status, orderType: r.order_type,
      po: r.po, notes: r.notes, isSample: r.is_sample,
      waiveDelivery: r.waive_delivery, waiveBrokenCase: r.waive_broken_case,
      waiveCRV: r.waive_crv, paid: r.paid,
      paidDate: r.paid_date ? r.paid_date.toISOString().slice(0,10) : null,
      paidAmount: r.paid_amount ? parseFloat(r.paid_amount) : null,
      qboInvoiceId: r.qbo_invoice_id, qboSyncedAt: r.qbo_synced_at,
      items: itemsByOrder[r.id] || [],
    }));

    res.json({ ok: true, orders });
  } catch (err) {
    console.error('Get orders error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/orders
router.post('/', requireAuth, async (req, res) => {
  try {
    const { id, acct, rep, date, delivery, status, orderType, po, notes,
            isSample, waiveDelivery, waiveBrokenCase, waiveCRV, items, placedByLabel } = req.body;
    if (!id || !acct) return res.status(400).json({ ok: false, error: 'Missing required fields' });

    await query(`
      INSERT INTO orders (id,acct_id,rep_id,date,delivery,status,order_type,po,notes,
        is_sample,waive_delivery,waive_broken_case,waive_crv)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [id, acct, rep, date, delivery, status||'unconfirmed', orderType||'standard',
        po||'', notes||'', !!isSample, !!waiveDelivery, !!waiveBrokenCase, !!waiveCRV]);

    if (items && items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await query(`
          INSERT INTO order_items (order_id,sku,cases,bottles,tier,discount_pct,
            is_fee,fee_amt,fee_count,is_manual,rate,sort_order)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [id, item.sku, item.cases||0, item.bottles||0, item.tier||'frontline',
            item.discountPct||0, !!item._fee, item.feeAmt||null, item.count||null,
            !!item._manual, item.rate||null, i]);
      }
    }

    sendOrderNotification(id, placedByLabel||req.user.fname+' '+(req.user.lname||''), req.user.email).catch(console.error);
    res.json({ ok: true, id });
  } catch (err) {
    console.error('Create order error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/orders/:id
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { status, paid, paidDate, paidAmount, qboInvoiceId, qboSyncedAt, qboPaymentId } = req.body;
    const updates = [], values = [];
    let idx = 1;
    if (status !== undefined)       { updates.push(`status=$${idx++}`);         values.push(status); }
    if (paid !== undefined)         { updates.push(`paid=$${idx++}`);            values.push(paid); }
    if (paidDate !== undefined)     { updates.push(`paid_date=$${idx++}`);       values.push(paidDate); }
    if (paidAmount !== undefined)   { updates.push(`paid_amount=$${idx++}`);     values.push(paidAmount); }
    if (qboInvoiceId !== undefined) { updates.push(`qbo_invoice_id=$${idx++}`); values.push(qboInvoiceId); }
    if (qboSyncedAt !== undefined)  { updates.push(`qbo_synced_at=$${idx++}`);  values.push(qboSyncedAt); }
    if (qboPaymentId !== undefined) { updates.push(`qbo_payment_id=$${idx++}`); values.push(qboPaymentId); }
    if (updates.length === 0) return res.status(400).json({ ok: false, error: 'Nothing to update' });
    values.push(req.params.id);
    await query(`UPDATE orders SET ${updates.join(',')} WHERE id=$${idx}`, values);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update order error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/orders/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM order_items WHERE order_id=$1', [req.params.id]);
    await query('DELETE FROM orders WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete order error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

async function sendOrderNotification(orderId, placedByLabel, placedByEmail) {
  try {
    if (!process.env.SENDGRID_API_KEY) {
      console.log('Order notification (no SendGrid):', orderId, 'by', placedByLabel);
      return;
    }
    const order = await getOne(`
      SELECT o.*, a.name as acct_name,
             u.fname as rep_fname, u.lname as rep_lname, u.email as rep_email
      FROM orders o
      LEFT JOIN accounts a ON o.acct_id = a.id
      LEFT JOIN users u ON o.rep_id = u.id
      WHERE o.id=$1
    `, [orderId]);
    if (!order) return;

    const items = await getAll('SELECT * FROM order_items WHERE order_id=$1 ORDER BY sort_order', [orderId]);
    const to = [...NOTIFY_EMAILS];
    if (order.rep_email && !to.map(e=>e.toLowerCase()).includes(order.rep_email.toLowerCase())) {
      to.push(order.rep_email);
    }

    const prodLines = items.filter(i => !i.is_fee);
    const linesHtml = prodLines.map(l =>
      `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">${l.sku}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${l.cases}cs${l.bottles>0?'+'+l.bottles+'btl':''}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right">${l.tier}</td>
      </tr>`
    ).join('');

    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.sendMultiple({
      to,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: `New Order Has Been Placed - ${order.acct_name}`,
      text: `New order ${orderId} placed by ${placedByLabel} for ${order.acct_name}.`,
      html: `<div style="font-family:system-ui;max-width:600px;margin:32px auto">
        <div style="background:#1a1a1a;padding:20px 32px;border-radius:12px 12px 0 0">
          <span style="font-size:20px;font-weight:800;color:#fff">Toast<span style="color:#B8872C;font-weight:400;font-style:italic">ed</span></span>
        </div>
        <div style="background:#B8872C;padding:14px 32px">
          <div style="color:#fff;font-size:16px;font-weight:700">New Order — ${order.acct_name}</div>
          <div style="color:rgba(255,255,255,0.85);font-size:13px">Order ID: ${orderId} &bull; Placed by: ${placedByLabel}</div>
        </div>
        <div style="background:#fff;padding:24px 32px;border:1px solid #eee">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr><td style="color:#888;padding:4px 0;width:140px">Account</td><td style="font-weight:600">${order.acct_name}</td></tr>
            <tr><td style="color:#888;padding:4px 0">Order Date</td><td>${order.date?new Date(order.date).toLocaleDateString():''
