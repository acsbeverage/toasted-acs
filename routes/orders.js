const router = require('express').Router();
const { query, getOne, getAll } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const sgMail = require('@sendgrid/mail');

const FROM_EMAIL    = process.env.FROM_EMAIL || 'accounting@acsbeverage.com';
const FROM_NAME     = process.env.FROM_NAME  || 'Toasted — ACS Beverage Co.';
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || 'kevin@acsbeverage.com,jessica@acsbeverage.com')
  .split(',').map(e => e.trim()).filter(Boolean);

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
        ORDER BY o.created_at DESC`);
    } else if (isCustomer) {
      const cust = await getOne('SELECT acct_id FROM customer_users WHERE id=$1', [req.user.id]);
      if (!cust) return res.json({ ok: true, orders: [] });
      rows = await getAll(`
        SELECT o.*, a.name as acct_name
        FROM orders o
        LEFT JOIN accounts a ON o.acct_id = a.id
        WHERE o.acct_id=$1 ORDER BY o.created_at DESC`, [cust.acct_id]);
    } else {
      // Reps see every order for accounts assigned to them -- not just orders they personally
      // placed. Previously this filtered on the order's own rep_id, meaning a rep couldn't see
      // an order an admin (or a prior rep) placed for an account now assigned to them.
      rows = await getAll(`
        SELECT o.*, a.name as acct_name, u.fname as rep_fname, u.lname as rep_lname
        FROM orders o
        LEFT JOIN accounts a ON o.acct_id = a.id
        LEFT JOIN users u ON o.rep_id = u.id
        WHERE a.rep=$1 ORDER BY o.created_at DESC`, [req.user.id]);
    }
    const orderIds = rows.map(r => r.id);
    let items = [];
    if (orderIds.length > 0) {
      items = await getAll(
        `SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY sort_order`,
        [orderIds]);
    }
    const itemsByOrder = {};
    items.forEach(item => {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push({
        sku: item.sku, cases: item.cases, bottles: item.bottles,
        tier: item.tier, discountPct: parseFloat(item.discount_pct)||0,
        _fee: item.is_fee, feeAmt: item.fee_amt ? parseFloat(item.fee_amt) : undefined,
        count: item.fee_count, _manual: item.is_manual,
        rate: item.rate !== null ? parseFloat(item.rate) : undefined,
      });
    });
    const orders = rows.map(r => ({
      id: r.id, acct: r.acct_id, acctName: r.acct_name,
      rep: r.rep_id, repName: r.rep_fname ? r.rep_fname+' '+(r.rep_lname||'') : '',
      date: r.date ? r.date.toISOString().slice(0,10) : '',
      delivery: r.delivery ? r.delivery.toISOString().slice(0,10) : '',
      status: r.status, orderType: r.order_type,
      po: r.po, notes: r.notes, isSample: r.is_sample,
      labelsPrinted: r.labels_printed||false,
      waiveDelivery: r.waive_delivery, waiveBrokenCase: r.waive_broken_case,
      waiveCRV: r.waive_crv, paid: r.paid,
      paidDate: r.paid_date ? r.paid_date.toISOString().slice(0,10) : null,
      paidAmount: r.paid_amount ? parseFloat(r.paid_amount) : null,
      qboInvoiceId: r.qbo_invoice_id, qboSyncedAt: r.qbo_synced_at,
      partialPaidAmount: r.partial_paid_amount ? parseFloat(r.partial_paid_amount) : null,
      items: itemsByOrder[r.id] || [],
    }));
    res.json({ ok: true, orders });
  } catch (err) {
    console.error('Get orders error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    let { id, acct, rep, date, delivery, status, orderType, po, notes,
            isSample, waiveDelivery, waiveBrokenCase, waiveCRV, items, placedByLabel } = req.body;

    // Customers can only ever place orders under their own account --
    // never trust acct/rep values coming from a customer-role client.
    if (req.user.role === 'customer') {
      const cust = await getOne('SELECT acct_id FROM customer_users WHERE id=$1', [req.user.id]);
      if (!cust) return res.status(403).json({ ok: false, error: 'Customer account not found' });
      const custAcct = await getOne('SELECT rep FROM accounts WHERE id=$1', [cust.acct_id]);
      acct = cust.acct_id;
      rep = custAcct ? custAcct.rep : null;
      status = 'unconfirmed';

      // Enforce pricing-tier minimums server-side -- never trust the client's claimed tier.
      if (Array.isArray(items)) {
        const prodItems = items.filter(i => !i._fee);
        const skus = [...new Set(prodItems.map(i => i.sku))];
        const products = skus.length ? await getAll('SELECT sku,btl,producer FROM products WHERE sku = ANY($1)', [skus]) : [];
        const prodMap = {};
        products.forEach(p => { prodMap[p.sku] = p; });
        const bottleCount = (item) => {
          const p = prodMap[item.sku];
          const btl = p ? p.btl : 1;
          return (item.cases||0)*btl + (item.bottles||0);
        };
        const caseEquivalent = (item) => {
          const p = prodMap[item.sku];
          const btl = p ? p.btl : 1;
          return (item.cases||0) + (item.bottles||0)/btl;
        };
        const EPS = 0.001; // floating-point tolerance

        // 12 Btl Mix: 12 bottles total, any products in the portfolio
        const mix12Total = prodItems.filter(i => i.tier === 'mix12').reduce((s,i) => s+bottleCount(i), 0);
        if (mix12Total > 0 && mix12Total < 12) {
          return res.status(400).json({ ok: false, error: `12 Btl Mix pricing requires at least 12 bottles total (any products) -- you have ${mix12Total}.` });
        }

        // 3 Case ACS: 3 cases total (case-equivalent), any products in the portfolio
        const acs3Total = prodItems.filter(i => i.tier === 'acs3').reduce((s,i) => s+caseEquivalent(i), 0);
        if (acs3Total > 0 && acs3Total < 3-EPS) {
          return res.status(400).json({ ok: false, error: `3 Case ACS pricing requires at least 3 cases total (any products) -- you have ${acs3Total.toFixed(2)}.` });
        }

        // Brand Family tiers: minimum applies per-brand (producer), not per-SKU, measured in cases
        const checkBrandTier = (tierId, minCases, label) => {
          const byBrand = {};
          prodItems.filter(i => i.tier === tierId).forEach(i => {
            const p = prodMap[i.sku];
            const brand = p ? (p.producer || 'Unknown') : 'Unknown';
            byBrand[brand] = (byBrand[brand] || 0) + caseEquivalent(i);
          });
          for (const [brand, total] of Object.entries(byBrand)) {
            if (total < minCases-EPS) {
              return `${label} pricing requires at least ${minCases} cases of the same brand (${brand}) -- you have ${total.toFixed(2)}.`;
            }
          }
          return null;
        };
        const brand3Err = checkBrandTier('brand3', 3, '3 Case Brand Family');
        if (brand3Err) return res.status(400).json({ ok: false, error: brand3Err });
        const brand5Err = checkBrandTier('brand5', 5, '5 Case Brand Family');
        if (brand5Err) return res.status(400).json({ ok: false, error: brand5Err });
      }
    }

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

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'customer') return res.status(403).json({ ok: false, error: 'Not permitted' });
    const { status, paid, paidDate, paidAmount, qboInvoiceId, qboSyncedAt, qboPaymentId,
            date, delivery, po, notes, items, labelsPrinted, partialPaidAmount } = req.body;
    const updates = [], values = [];
    let idx = 1;
    if (status !== undefined)       { updates.push(`status=$${idx++}`);         values.push(status); }
    if (paid !== undefined)         { updates.push(`paid=$${idx++}`);            values.push(paid); }
    if (paidDate !== undefined)     { updates.push(`paid_date=$${idx++}`);       values.push(paidDate); }
    if (paidAmount !== undefined)   { updates.push(`paid_amount=$${idx++}`);     values.push(paidAmount); }
    if (qboInvoiceId !== undefined) { updates.push(`qbo_invoice_id=$${idx++}`); values.push(qboInvoiceId); }
    if (qboSyncedAt !== undefined)  { updates.push(`qbo_synced_at=$${idx++}`);  values.push(qboSyncedAt); }
    if (qboPaymentId !== undefined) { updates.push(`qbo_payment_id=$${idx++}`); values.push(qboPaymentId); }
    if (date !== undefined)         { updates.push(`date=$${idx++}`);           values.push(date); }
    if (delivery !== undefined)     { updates.push(`delivery=$${idx++}`);       values.push(delivery); }
    if (po !== undefined)           { updates.push(`po=$${idx++}`);             values.push(po); }
    if (notes !== undefined)        { updates.push(`notes=$${idx++}`);          values.push(notes); }
    if (labelsPrinted !== undefined){ updates.push(`labels_printed=$${idx++}`); values.push(labelsPrinted); }
    if (partialPaidAmount !== undefined) { updates.push(`partial_paid_amount=$${idx++}`); values.push(partialPaidAmount); }
    if (updates.length > 0) {
      values.push(req.params.id);
      await query(`UPDATE orders SET ${updates.join(',')} WHERE id=$${idx}`, values);
    }
    // Replace line items if a new set was provided (order-edit flow)
    if (Array.isArray(items)) {
      await query('DELETE FROM order_items WHERE order_id=$1', [req.params.id]);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await query(`
          INSERT INTO order_items (order_id,sku,cases,bottles,tier,discount_pct,
            is_fee,fee_amt,fee_count,is_manual,rate,sort_order)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [req.params.id, item.sku, item.cases||0, item.bottles||0, item.tier||'frontline',
            item.discountPct||0, !!item._fee, item.feeAmt||null, item.count||null,
            !!item._manual, item.rate||null, i]);
      }
    }
    if (updates.length === 0 && !Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'Nothing to update' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Update order error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

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
      WHERE o.id=$1`, [orderId]);
    if (!order) return;
    const items = await getAll('SELECT * FROM order_items WHERE order_id=$1 ORDER BY sort_order', [orderId]);
    const to = [...NOTIFY_EMAILS];
    if (order.rep_email && !to.map(e=>e.toLowerCase()).includes(order.rep_email.toLowerCase())) {
      to.push(order.rep_email);
    }

    const prodLines = items.filter(i => !i.is_fee);
    const feeLines   = items.filter(i => i.is_fee);
    const skus = [...new Set(prodLines.map(l => l.sku))];
    const products = skus.length ? await getAll(
      'SELECT sku,name,btl,price_frontline,price_mix12,price_acs3,price_brand3,price_brand5 FROM products WHERE sku = ANY($1)',
      [skus]
    ) : [];
    const prodBySku = {};
    products.forEach(p => { prodBySku[p.sku] = p; });
    const TIER_COL = { frontline:'price_frontline', mix12:'price_mix12', acs3:'price_acs3', brand3:'price_brand3', brand5:'price_brand5' };

    let subtotal = 0;
    const linesHtml = prodLines.map(l => {
      const prod = prodBySku[l.sku];
      const name = prod ? prod.name : l.sku;
      const btl = prod ? prod.btl : 1;
      const qtyLabel = (l.cases||0) + ' cs' + (l.bottles>0 ? ' + '+l.bottles+' btl' : '');
      const tierCol = TIER_COL[l.tier] || 'price_frontline';
      const rate = prod && prod[tierCol] !== null && prod[tierCol] !== undefined ? parseFloat(prod[tierCol]) : 0;
      const totalBottles = (l.cases||0)*btl + (l.bottles||0);
      const discount = parseFloat(l.discount_pct)||0;
      const lineTotal = rate * totalBottles * (1 - discount/100);
      subtotal += lineTotal;
      return `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">${name}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${qtyLabel}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">$${lineTotal.toFixed(2)}</td>
      </tr>`;
    }).join('');

    const feeLabels = { '__DELIVERY__':'Delivery fee', '__BROKEN_CASE__':'Broken case fee', '__CRV__':'CA CRV' };
    const feesHtml = feeLines.map(f => {
      const label = feeLabels[f.sku] || f.sku;
      const amt = parseFloat(f.fee_amt)||0;
      const count = f.fee_count||1;
      const total = f.sku==='__BROKEN_CASE__' ? amt*count : amt;
      subtotal += total;
      return `<tr><td colspan="2" style="padding:4px 12px;color:#888;font-style:italic">${label}</td><td style="padding:4px 12px;text-align:right;color:#888">$${total.toFixed(2)}</td></tr>`;
    }).join('');

    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.sendMultiple({
      to,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: `New Order Has Been Placed - ${order.acct_name}`,
      text: `New order ${orderId} placed by ${placedByLabel} for ${order.acct_name}. Total: $${subtotal.toFixed(2)}`,
      html: `<div style="font-family:system-ui;max-width:600px;margin:32px auto">
        <div style="background:#1a1a1a;padding:20px 32px;border-radius:12px 12px 0 0">
          <span style="font-size:20px;font-weight:800;color:#fff">Toast<span style="color:#B8872C;font-weight:400;font-style:italic">ed</span></span>
        </div>
        <div style="background:#B8872C;padding:14px 32px">
          <div style="color:#fff;font-size:16px;font-weight:700">New Order — ${order.acct_name}</div>
          <div style="color:rgba(255,255,255,0.85);font-size:13px">Order ID: ${orderId} &bull; Placed by: ${placedByLabel} (Sales Rep)</div>
        </div>
        <div style="background:#fff;padding:24px 32px;border:1px solid #eee">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr><td style="color:#888;padding:4px 0;width:140px">Account</td><td style="font-weight:600">${order.acct_name}</td></tr>
            <tr><td style="color:#888;padding:4px 0">Order Date</td><td>${order.date?new Date(order.date).toLocaleDateString():''}</td></tr>
            <tr><td style="color:#888;padding:4px 0">Delivery Date</td><td>${order.delivery?new Date(order.delivery).toLocaleDateString():''}</td></tr>
            <tr><td style="color:#888;padding:4px 0">Sales Rep</td><td>${order.rep_fname||''} ${order.rep_lname||''}${order.rep_email?' &lt;'+order.rep_email+'&gt;':''}</td></tr>
            ${order.po?`<tr><td style="color:#888;padding:4px 0">PO #</td><td>${order.po}</td></tr>`:''}
          </table>
          <div style="margin-top:20px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="background:#f9f9f9">
                <th style="padding:8px 12px;text-align:left;color:#888;font-size:11px;text-transform:uppercase">Product</th>
                <th style="padding:8px 12px;text-align:center;color:#888;font-size:11px;text-transform:uppercase">Qty</th>
                <th style="padding:8px 12px;text-align:right;color:#888;font-size:11px;text-transform:uppercase">Total</th>
              </tr></thead>
              <tbody>${linesHtml}${feesHtml}</tbody>
              <tfoot><tr style="border-top:2px solid #222">
                <td colspan="2" style="padding:10px 12px;font-weight:700;font-size:15px">Order Total</td>
                <td style="padding:10px 12px;text-align:right;font-weight:700;font-size:15px;color:#B8872C">$${subtotal.toFixed(2)}</td>
              </tr></tfoot>
            </table>
          </div>
          ${order.notes?`<div style="margin-top:16px;padding:12px;background:#fffbe8;border-radius:8px;font-size:13px"><strong>Notes:</strong> ${order.notes}</div>`:''}
        </div>
        <div style="padding:14px 32px;background:#f9f9f9;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;font-size:11px;color:#aaa;text-align:center">
          Toasted &mdash; ACS Beverage Co. LLC &bull; accounting@acsbeverage.com
        </div>
      </div>`
    });
    console.log(`Notification sent for ${orderId} to: ${to.join(', ')}`);
  } catch (err) {
    console.error('Order notification error:', err.message);
  }
}

// -- INVOICE EMAILING -------------------------------------------------------
// The PDF is generated in the browser (reusing the exact same invoice layout used for
// viewing/downloading) and passed here as base64 -- avoids duplicating that whole layout
// server-side, and means a scheduled send just re-uses the PDF captured at confirm time.
async function _sendInvoiceEmail({ recipients, subject, body, pdfData, pdfFilename }) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  await sgMail.send({
    to: recipients,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    text: body,
    html: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;white-space:pre-wrap">${body.replace(/</g,'&lt;')}</div>`,
    attachments: [{
      content: pdfData, // base64, no data: prefix
      filename: pdfFilename,
      type: 'application/pdf',
      disposition: 'attachment',
    }],
  });
}

router.post('/:id/send-invoice-email', requireAdmin, async (req, res) => {
  try {
    const { recipients, subject, body, pdfData, pdfFilename } = req.body;
    if (!recipients || !recipients.length) return res.status(400).json({ ok: false, error: 'No recipients selected' });
    if (!pdfData) return res.status(400).json({ ok: false, error: 'No invoice PDF provided' });
    await _sendInvoiceEmail({ recipients, subject, body, pdfData, pdfFilename: pdfFilename || (req.params.id + '.pdf') });
    res.json({ ok: true });
  } catch (err) {
    console.error('Send invoice email error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:id/schedule-invoice-email', requireAdmin, async (req, res) => {
  try {
    const { recipients, subject, body, pdfData, pdfFilename, scheduledFor, accountId } = req.body;
    if (!recipients || !recipients.length) return res.status(400).json({ ok: false, error: 'No recipients selected' });
    if (!pdfData) return res.status(400).json({ ok: false, error: 'No invoice PDF provided' });
    if (!scheduledFor) return res.status(400).json({ ok: false, error: 'No delivery date to schedule for' });
    await query(
      `INSERT INTO scheduled_invoice_emails (order_id,account_id,recipients,subject,body,pdf_data,pdf_filename,scheduled_for)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.params.id, accountId || null, recipients, subject, body, pdfData, pdfFilename || (req.params.id + '.pdf'), scheduledFor]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Schedule invoice email error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Called on a timer from server.js -- sends any scheduled invoice emails whose delivery
// date has arrived. Exported so server.js can drive it without duplicating this logic.
async function processScheduledInvoiceEmails() {
  const due = await getAll(
    `SELECT * FROM scheduled_invoice_emails WHERE sent=FALSE AND scheduled_for <= CURRENT_DATE`
  );
  for (const row of due) {
    try {
      await _sendInvoiceEmail({
        recipients: row.recipients, subject: row.subject, body: row.body,
        pdfData: row.pdf_data, pdfFilename: row.pdf_filename,
      });
      await query('UPDATE scheduled_invoice_emails SET sent=TRUE, sent_at=NOW() WHERE id=$1', [row.id]);
      console.log(`Scheduled invoice email sent for order ${row.order_id}`);
    } catch (err) {
      console.error(`Scheduled invoice email failed for order ${row.order_id}:`, err.message);
      await query('UPDATE scheduled_invoice_emails SET error=$1 WHERE id=$2', [err.message, row.id]);
    }
  }
  return due.length;
}
router.processScheduledInvoiceEmails = processScheduledInvoiceEmails;

module.exports = router;
