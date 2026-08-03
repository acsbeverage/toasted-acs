require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));

app.use('/api/auth',   require('./routes/auth'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api',        require('./routes/data'));

app.get('/health', (req, res) => res.json({
  status: 'ok',
  time: new Date().toISOString(),
  db: !!process.env.DATABASE_URL,
  email: !!process.env.SENDGRID_API_KEY
}));

// One-time seed endpoint
// Historical order import endpoint
app.post('/api/import-orders', async (req, res) => {
  if (req.query.secret !== 'toasted2026') return res.status(403).json({ ok: false });
  try {
    const { query } = require('./db');
    const { orders } = req.body;
    let imported = 0, skipped = 0;
    for (const o of orders) {
      try {
        // Check if order already exists
        const exists = await query('SELECT id FROM orders WHERE id=$1', [o.id]);
        if (exists.rows.length > 0) { skipped++; continue; }
        await query(`INSERT INTO orders (id,acct_id,rep_id,date,delivery,status,order_type,po,notes,is_sample,paid,paid_date,paid_amount)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [o.id, o.acct, o.rep, o.date||null, o.delivery||null, o.status||'delivered',
           o.orderType||'standard', o.po||'', o.notes||'', !!o.isSample,
           !!o.paid, o.paidDate||null, o.paidAmount||0]);
        for (let i = 0; i < o.items.length; i++) {
          const item = o.items[i];
          await query(`INSERT INTO order_items (order_id,sku,cases,bottles,tier,discount_pct,is_fee,sort_order)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [o.id, item.sku, item.cases||0, item.bottles||0, item.tier||'frontline',
             0, false, i]);
        }
        imported++;
      } catch(e) { skipped++; }
    }
    res.json({ ok: true, imported, skipped });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/seed-now', async (req, res) => {
  if (req.query.secret !== 'toasted2026') {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  try {
    const { query, getOne, getAll } = require('./db');
    const bcrypt = require('bcryptjs');

    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    let seeded = { users: 0, products: 0, accounts: 0 };

    // Seed users
    const userRegex = /\{id:'([^']+)',fname:'([^']+)',lname:'([^']+)',email:'([^']+)',pw:'([^']+)',role:'([^']+)'(?:,commission:([^,}]+))?/g;
    let match;
    while ((match = userRegex.exec(html)) !== null) {
      const [, id, fname, lname, email, pw, role, commission] = match;
      const existing = await getOne('SELECT id FROM users WHERE id=$1', [id]);
      if (!existing) {
        const hash = await bcrypt.hash(pw, 10);
        await query('INSERT INTO users (id,fname,lname,email,pw_hash,role,commission) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
          [id, fname, lname, email.toLowerCase(), hash, role, parseFloat(commission)||5]);
        seeded.users++;
      }
    }

    // Seed products
    const prodStart = html.indexOf('let PRODUCTS=[');
    const prodEnd = html.indexOf('\n];', prodStart) + 3;
    const prodBlock = html.slice(prodStart + 14, prodEnd - 3);
    const prodLines = prodBlock.split('\n').filter(l => l.trim().startsWith('{sku:'));
    for (const line of prodLines) {
      try {
        const sku  = line.match(/sku:'([^']+)'/)?.[1] || line.match(/sku:"([^"]+)"/)?.[1];
        const name = line.match(/name:"([^"]+)"/)?.[1] || line.match(/name:'([^']+)'/)?.[1];
        if (!sku || !name) continue;
        const producer = line.match(/producer:'([^']*?)'/)?.[1] || '';
        const cat      = line.match(/cat:'([^']+)'/)?.[1] || '';
        const btl      = parseInt(line.match(/btl:(\d+)/)?.[1]) || 12;
        const stock    = parseFloat(line.match(/stock:([-\d.]+)/)?.[1]) || 0;
        const reorder  = parseInt(line.match(/reorder:(\d+)/)?.[1]) || 6;
        const fl  = parseFloat(line.match(/frontline:([\d.]+)/)?.[1]) || 0;
        const m12 = parseFloat(line.match(/mix12:([\d.]+)/)?.[1]) || 0;
        const a3  = parseFloat(line.match(/acs3:([\d.]+)/)?.[1]) || 0;
        const b3  = parseFloat(line.match(/brand3:([\d.]+)/)?.[1]) || 0;
        const b5  = parseFloat(line.match(/brand5:([\d.]+)/)?.[1]) || 0;
        const daMatch = line.match(/da:\{([^}]+)\}/);
        let daFl=0,daM12=0,daA3=0,daB3=0,daB5=0;
        if (daMatch) {
          const d = daMatch[1];
          daFl  = parseFloat(d.match(/frontline:([\d.]+)/)?.[1]) || 0;
          daM12 = parseFloat(d.match(/mix12:([\d.]+)/)?.[1]) || 0;
          daA3  = parseFloat(d.match(/acs3:([\d.]+)/)?.[1]) || 0;
          daB3  = parseFloat(d.match(/brand3:([\d.]+)/)?.[1]) || 0;
          daB5  = parseFloat(d.match(/brand5:([\d.]+)/)?.[1]) || 0;
        }
        const redemption = line.match(/redemptionEntry:'([^']*)'/)?.[1] || '';
        const active     = line.match(/active:'([^']*)'/)?.[1] || 'Yes';
        const core       = line.match(/core:'([^']*)'/)?.[1] || 'No';
        await query(`INSERT INTO products (sku,name,producer,cat,btl,stock,reorder,
          price_frontline,price_mix12,price_acs3,price_brand3,price_brand5,
          da_frontline,da_mix12,da_acs3,da_brand3,da_brand5,redemption_entry,active,core)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (sku) DO UPDATE SET name=$2,stock=$6,
          price_frontline=$8,price_mix12=$9,price_acs3=$10,price_brand3=$11,price_brand5=$12,
          da_frontline=$13,da_mix12=$14,da_acs3=$15,da_brand3=$16,da_brand5=$17,
          redemption_entry=$18,active=$19,core=$20`,
          [sku,name,producer,cat,btl,stock,reorder,fl,m12,a3,b3,b5,
           daFl,daM12,daA3,daB3,daB5,redemption,active,core]);
        seeded.products++;
      } catch(e) {}
    }

    // Seed accounts
    const acctStart = html.indexOf('let ACCOUNTS=[');
    const acctEnd = html.indexOf('\n];', acctStart) + 3;
    const acctBlock = html.slice(acctStart + 14, acctEnd - 3);
    const acctLines = acctBlock.split('\n').filter(l => l.trim().startsWith('{'));
    for (const line of acctLines) {
      try {
        const a = JSON.parse(line.trim().replace(/,$/, ''));
        if (!a.id || !a.name) continue;
        await query(`INSERT INTO accounts (id,name,code,lic,abc_num,contact,
          contact_first,contact_last,phone,email,address,
          ship_street,ship_city,ship_state,ship_zip,
          bill_street,bill_city,bill_state,bill_zip,terms,rep)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
          ON CONFLICT (id) DO NOTHING`,
          [a.id,a.name,a.code||'',a.lic||'',a.abcNum||'',
           a.contact||'',a.contactFirst||'',a.contactLast||'',
           a.phone||'',a.email||'',a.address||'',
           a.shipStreet||'',a.shipCity||'',a.shipState||'',a.shipZip||'',
           a.billStreet||'',a.billCity||'',a.billState||'',a.billZip||'',
           a.terms||'Net 30',a.rep||'u1']);
        seeded.accounts++;
      } catch(e) {}
    }

    console.log('Seed complete!', seeded);
    return res.json({ ok: true, seeded });
  } catch(err) {
    console.error('Seed error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
// Email notification endpoint (called from frontend)
app.post('/api/notify/order', async (req, res) => {
  try {
    const sgMail = require('@sendgrid/mail');
    if (!process.env.SENDGRID_API_KEY) {
      console.log('No SendGrid key - skipping email');
      return res.json({ ok: true, devMode: true });
    }
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const d = req.body;
    const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || 'kevin@acsbeverage.com,jessica@acsbeverage.com').split(',').map(e=>e.trim());
    const to = [...NOTIFY_EMAILS];
    if (d.repEmail && !to.map(e=>e.toLowerCase()).includes(d.repEmail.toLowerCase())) {
      to.push(d.repEmail);
    }
    const linesHtml = (d.lines||[]).map(l=>`<tr><td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">${l.name}</td><td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${l.qty}</td><td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${l.total}</td></tr>`).join('');
    const feesHtml = (d.fees||[]).map(f=>`<tr><td colspan="2" style="padding:4px 12px;color:#888;font-style:italic">${f.label}</td><td style="padding:4px 12px;text-align:right;color:#888">${f.total}</td></tr>`).join('');
    await sgMail.sendMultiple({
      to,
      from: { email: process.env.FROM_EMAIL||'kevin@acsbeverage.com', name: process.env.FROM_NAME||'Toasted — ACS Beverage Co.' },
      subject: `New Order Has Been Placed - ${d.accountName}`,
      text: `New order ${d.orderId} placed by ${d.placedBy} for ${d.accountName}. Total: ${d.orderTotal}`,
      html: `<div style="font-family:system-ui;max-width:600px;margin:32px auto">
        <div style="background:#1a1a1a;padding:20px 32px;border-radius:12px 12px 0 0">
          <span style="font-size:20px;font-weight:800;color:#fff">Toast<span style="color:#B8872C;font-weight:400;font-style:italic">ed</span></span>
        </div>
        <div style="background:#B8872C;padding:14px 32px">
          <div style="color:#fff;font-size:16px;font-weight:700">New Order — ${d.accountName}</div>
          <div style="color:rgba(255,255,255,0.85);font-size:13px">Order ID: ${d.orderId} &bull; Placed by: ${d.placedBy}</div>
        </div>
        <div style="background:#fff;padding:24px 32px;border:1px solid #eee">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr><td style="color:#888;padding:4px 0;width:140px">Account</td><td style="font-weight:600">${d.accountName}</td></tr>
            <tr><td style="color:#888;padding:4px 0">Order Date</td><td>${d.orderDate}</td></tr>
            <tr><td style="color:#888;padding:4px 0">Delivery Date</td><td>${d.deliveryDate}</td></tr>
            <tr><td style="color:#888;padding:4px 0">Sales Rep</td><td>${d.repName}${d.repEmail?' &lt;'+d.repEmail+'&gt;':''}</td></tr>
            ${d.po?`<tr><td style="color:#888;padding:4px 0">PO #</td><td>${d.po}</td></tr>`:''}
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
                <td style="padding:10px 12px;text-align:right;font-weight:700;font-size:15px;color:#B8872C">${d.orderTotal}</td>
              </tr></tfoot>
            </table>
          </div>
          ${d.notes?`<div style="margin-top:16px;padding:12px;background:#fffbe8;border-radius:8px;font-size:13px"><strong>Notes:</strong> ${d.notes}</div>`:''}
        </div>
        <div style="padding:14px 32px;background:#f9f9f9;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;font-size:11px;color:#aaa;text-align:center">
          Toasted &mdash; ACS Beverage Co. LLC &bull; accounting@acsbeverage.com
        </div>
      </div>`
    });
    console.log(`Email sent for ${d.orderId} to: ${to.join(', ')}`);
    res.json({ ok: true, sentTo: to });
  } catch(err) {
    console.error('Email error:', err.response?.body||err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Toasted v2 running on port ${PORT}`);
  if (process.env.DATABASE_URL) {
    try {
      const { query } = require('./db');
      await query('SELECT 1 FROM users LIMIT 1');
      console.log('Database OK');
    } catch (err) {
      console.log('Running migrations...');
      require('child_process').execSync('node db/migrate.js', { stdio: 'inherit' });
    }
  }
});
