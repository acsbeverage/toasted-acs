const express = require('express');
const cors    = require('cors');
const sgMail  = require('@sendgrid/mail');
const path    = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ── SendGrid setup ────────────────────────────────────────────────────────────
if(process.env.SENDGRID_API_KEY){
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log('SendGrid ready');
} else {
  console.warn('WARNING: SENDGRID_API_KEY not set — emails will be logged only');
}

const FROM_EMAIL  = process.env.FROM_EMAIL  || 'accounting@acsbeverage.com';
const FROM_NAME   = process.env.FROM_NAME   || 'Toasted — ACS Beverage Co.';
const NOTIFY_LIST = (process.env.NOTIFY_EMAILS || 'kevin@acsbeverage.com,jessica@acsbeverage.com')
  .split(',').map(e=>e.trim()).filter(Boolean);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Serve Toasted HTML ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ── EMAIL: Send order notification ────────────────────────────────────────────
// POST /api/notify/order
// Body: { orderId, accountName, placedBy, repName, repEmail,
//         orderDate, deliveryDate, orderType, po, notes,
//         lines: [{name, qty, total}], fees: [{label, total}],
//         orderTotal }
app.post('/api/notify/order', async (req, res) => {
  try {
    const d = req.body;

    // Recipients: always Kevin & Jessica, plus the rep if they have an email
    const to = [...NOTIFY_LIST];
    if(d.repEmail && !to.map(e=>e.toLowerCase()).includes(d.repEmail.toLowerCase())){
      to.push(d.repEmail);
    }

    const subject = `New Order Has Been Placed - ${d.accountName}`;

    // Plain text body
    const linesText = (d.lines||[]).map(l=>`  • ${l.name}  (${l.qty})  ${l.total}`).join('\n');
    const feesText  = (d.fees||[]).length
      ? '\nFees:\n'+(d.fees.map(f=>`  • ${f.label}  ${f.total}`).join('\n'))
      : '';

    const textBody = `
A new order has been placed in Toasted.

Order ID:       ${d.orderId}
Account:        ${d.accountName}
Placed by:      ${d.placedBy}
Sales rep:      ${d.repName}${d.repEmail?' ('+d.repEmail+')':''}
Order date:     ${d.orderDate}
Delivery date:  ${d.deliveryDate}
Order type:     ${d.orderType||'Standard'}
${d.po?'PO #:           '+d.po+'\n':''}
Items:
${linesText}${feesText}

Order total:    ${d.orderTotal}
${d.notes?'\nNotes: '+d.notes:''}

---
Toasted | ACS Beverage Co. LLC
accounting@acsbeverage.com | acsbeverageco.com
`.trim();

    // HTML body
    const linesHtml = (d.lines||[]).map(l=>
      `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">${l.name}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${l.qty}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${l.total}</td>
      </tr>`
    ).join('');

    const feesHtml = (d.fees||[]).length
      ? (d.fees.map(f=>
          `<tr>
            <td colspan="2" style="padding:4px 12px;color:#888;font-style:italic">${f.label}</td>
            <td style="padding:4px 12px;text-align:right;color:#888">${f.total}</td>
          </tr>`
        ).join(''))
      : '';

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:system-ui,-apple-system,sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">

  <!-- Header -->
  <div style="background:#1a1a1a;padding:24px 32px;display:flex;align-items:center;gap:12px">
    <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.5px">
      Toast<span style="color:#B8872C;font-weight:400;font-style:italic">ed</span>
    </div>
    <div style="width:1px;height:20px;background:#444;margin:0 8px"></div>
    <div style="color:#aaa;font-size:13px">ACS Beverage Co. LLC</div>
  </div>

  <!-- Alert banner -->
  <div style="background:#B8872C;padding:14px 32px">
    <div style="color:#fff;font-size:16px;font-weight:700">New Order Has Been Placed</div>
    <div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:2px">${d.accountName}</div>
  </div>

  <!-- Order meta -->
  <div style="padding:24px 32px;border-bottom:1px solid #f0f0f0">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr>
        <td style="padding:4px 0;color:#888;width:140px">Order ID</td>
        <td style="padding:4px 0;font-weight:700;color:#B8872C">${d.orderId}</td>
        <td style="padding:4px 0;color:#888;width:140px">Order Date</td>
        <td style="padding:4px 0">${d.orderDate}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#888">Account</td>
        <td style="padding:4px 0;font-weight:600">${d.accountName}</td>
        <td style="padding:4px 0;color:#888">Delivery Date</td>
        <td style="padding:4px 0">${d.deliveryDate}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#888">Placed by</td>
        <td style="padding:4px 0">${d.placedBy}</td>
        <td style="padding:4px 0;color:#888">Order Type</td>
        <td style="padding:4px 0">${d.orderType||'Standard'}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#888">Sales Rep</td>
        <td style="padding:4px 0">${d.repName}${d.repEmail?' &lt;'+d.repEmail+'&gt;':''}</td>
        ${d.po?`<td style="padding:4px 0;color:#888">PO #</td><td style="padding:4px 0">${d.po}</td>`:'<td colspan="2"></td>'}
      </tr>
    </table>
  </div>

  <!-- Line items -->
  <div style="padding:24px 32px">
    <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#888;margin-bottom:10px">Order Items</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f9f9f9">
          <th style="padding:8px 12px;text-align:left;color:#888;font-weight:600;font-size:11px;text-transform:uppercase">Product</th>
          <th style="padding:8px 12px;text-align:center;color:#888;font-weight:600;font-size:11px;text-transform:uppercase">Qty</th>
          <th style="padding:8px 12px;text-align:right;color:#888;font-weight:600;font-size:11px;text-transform:uppercase">Total</th>
        </tr>
      </thead>
      <tbody>${linesHtml}${feesHtml}</tbody>
      <tfoot>
        <tr style="border-top:2px solid #222">
          <td colspan="2" style="padding:10px 12px;font-weight:700;font-size:15px">Order Total</td>
          <td style="padding:10px 12px;text-align:right;font-weight:700;font-size:15px;color:#B8872C">${d.orderTotal}</td>
        </tr>
      </tfoot>
    </table>
    ${d.notes?`<div style="margin-top:16px;padding:12px;background:#fffbe8;border-radius:8px;font-size:13px;color:#7a5800"><strong>Notes:</strong> ${d.notes}</div>`:''}
  </div>

  <!-- Footer -->
  <div style="padding:16px 32px;background:#f9f9f9;border-top:1px solid #eee;font-size:11px;color:#aaa;text-align:center">
    Toasted &mdash; ACS Beverage Co. LLC &nbsp;&bull;&nbsp;
    accounting@acsbeverage.com &nbsp;&bull;&nbsp; acsbeverageco.com
  </div>

</div>
</body>
</html>`;

    const msg = {
      to,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      text: textBody,
      html: htmlBody,
    };

    if(process.env.SENDGRID_API_KEY){
      await sgMail.sendMultiple(msg);
      console.log(`Order notification sent for ${d.orderId} to: ${to.join(', ')}`);
      res.json({ ok: true, sentTo: to });
    } else {
      // Dev mode — log instead of send
      console.log('--- EMAIL (dev mode, not sent) ---');
      console.log('To:', to.join(', '));
      console.log('Subject:', subject);
      console.log(textBody);
      res.json({ ok: true, devMode: true, sentTo: to, note: 'SENDGRID_API_KEY not set — logged only' });
    }
  } catch(err){
    console.error('Email error:', err.response?.body || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Toasted backend running on port ${PORT}`));
