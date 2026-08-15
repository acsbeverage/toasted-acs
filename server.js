require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    // This is a single-page app with no separate hashed/versioned asset files, so the
    // browser has no other signal that a new deploy has happened. Without this, some
    // browsers (mobile especially) can keep serving a stale cached index.html for a long
    // time after a new version ships -- even surviving a sign-out/sign-in, since that only
    // clears the auth session, not the browser's HTTP cache. no-cache still allows caching,
    // but forces a fast revalidation check (ETag) on every load rather than blindly reusing
    // a stale copy, so this doesn't meaningfully add load -- unchanged files still return a
    // quick 304, not a full re-download.
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use('/api/auth',   require('./routes/auth'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/po',     require('./routes/purchaseOrders'));
app.use('/api/qbo',    require('./routes/qbo'));
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
app.get('/api/remove-dash12-skus', async (req, res) => {
  if(req.query.secret !== 'toasted2026-dash12') return res.status(403).json({ok:false});
  const execute = req.query.execute === 'true';
  try {
    const { query, getAll } = require('./db');
    const matches = await getAll(
      `SELECT sku, name, producer, btl, active FROM products
       WHERE sku LIKE '%-12' AND producer NOT ILIKE '%liber%'
       ORDER BY producer, name`
    );
    const skus = matches.map(m => m.sku);
    const orderUsage = skus.length ? await getAll(
      `SELECT sku, COUNT(*) as line_items, COUNT(DISTINCT order_id) as orders
       FROM order_items WHERE sku = ANY($1) GROUP BY sku`,
      [skus]
    ) : [];
    const usageMap = {};
    orderUsage.forEach(u => { usageMap[u.sku] = { lineItems: parseInt(u.line_items), orders: parseInt(u.orders) }; });
    const withUsage = matches.map(m => ({ ...m, usedInOrders: usageMap[m.sku] || { lineItems: 0, orders: 0 } }));
    const safeToDelete = withUsage.filter(m => m.usedInOrders.lineItems === 0);
    const referencedByOrders = withUsage.filter(m => m.usedInOrders.lineItems > 0);

    if (!execute) {
      return res.json({ ok: true, dryRun: true,
        totalMatching: matches.length,
        safeToDeleteCount: safeToDelete.length,
        referencedByOrdersCount: referencedByOrders.length,
        safeToDelete, referencedByOrders,
        note: 'referencedByOrders products are used by real historical orders and will NOT be deleted, to avoid breaking those records -- only safeToDelete products get removed. Re-run with &execute=true to apply.' });
    }

    let deleted = 0;
    for (const m of safeToDelete) {
      await query('DELETE FROM products WHERE sku=$1', [m.sku]);
      deleted++;
    }
    res.json({ ok: true, executed: true, deletedCount: deleted, skippedDueToOrderReferences: referencedByOrders.length });
  } catch (err) {
    console.error('Remove dash-12 SKUs error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/diagnose-acs2878', async (req, res) => {
  if(req.query.secret !== 'toasted2026-diag2878') return res.status(403).json({ok:false});
  try {
    const { getAll } = require('./db');
    const order = await getAll('SELECT * FROM orders WHERE id=$1', ['ACS-2878']);
    const items = await getAll('SELECT * FROM order_items WHERE order_id=$1', ['ACS-2878']);
    const skus = [...new Set(items.map(i => i.sku))];
    const products = await getAll('SELECT sku,name,btl,active FROM products WHERE sku = ANY($1)', [skus]);
    res.json({ ok: true, order, items, products });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/fix-partial-payments', async (req, res) => {
  if(req.query.secret !== 'toasted2026-fixpartial') return res.status(403).json({ok:false});
  const execute = req.query.execute === 'true';
  try {
    const { query, getAll } = require('./db');
    const records = [["ACS-14316", 345.4], ["ACS-14320", 559.2], ["ACS-14581", 437.6], ["ACS-14871", 214.25], ["ACS-1503", 2946.6], ["ACS-15999", 946.2], ["ACS-16930", 231.0], ["ACS-16962", 69.75], ["ACS-1812", 102.6], ["ACS-18773", 1148.85], ["ACS-19213", 231.0], ["ACS-19581", 4593.0], ["ACS-19598", 504.6], ["ACS-2003", 333.6], ["ACS-2016", 479.2], ["ACS-20756", 484.2], ["ACS-2119", 6030.2], ["ACS-22147", 161.25], ["ACS-22165", 91.5], ["ACS-22314", 235.0], ["ACS-22955", 654.0], ["ACS-2304", 504.2], ["ACS-23259", 1483.5], ["ACS-2329", 492.8], ["ACS-23658", 1776.4], ["ACS-26101", 575.12], ["ACS-26130", 660.3], ["ACS-2878", 12959.5], ["ACS-288", 2008.78], ["ACS-28909", 824.8], ["ACS-29973", 1074.25], ["ACS-29996", 527.7], ["ACS-29997", 568.8], ["ACS-30900", 443.1], ["ACS-30902", 399.9], ["ACS-30913", 298.8], ["ACS-31956", 577.9], ["ACS-33073", 294.4], ["ACS-33082", 581.1], ["ACS-33083", 505.5], ["ACS-34210", 724.8], ["ACS-34941", 669.6], ["ACS-35150", 934.75], ["ACS-36310", 420.6], ["ACS-36312", 882.9], ["ACS-3690", 258.6], ["ACS-37284", 1349.4], ["ACS-37317", 1770.0], ["ACS-37613", 1343.35], ["ACS-38937", 148.5], ["ACS-39205", 1508.1], ["ACS-39796", 68.25], ["ACS-40654", 217.2], ["ACS-4219", 7408.1], ["ACS-4876", 516.6], ["ACS-5100", 9000.0], ["ACS-5102", 1771.77], ["ACS-5389", 2418.38], ["ACS-5639", 2390.4], ["ACS-6066", 496.8], ["ACS-6499", 101.0], ["ACS-7165", 421.18], ["ACS-7694", 612.8], ["ACS-872", 229.5]];

    if (!execute) {
      const invoiceIds = records.map(r => r[0]);
      const preview = await getAll(
        'SELECT id, paid, partial_paid_amount FROM orders WHERE id = ANY($1) ORDER BY id LIMIT 15',
        [invoiceIds]
      );
      const countRow = await getAll(
        'SELECT COUNT(*) as cnt FROM orders WHERE id = ANY($1)',
        [invoiceIds]
      );
      const alreadySetRow = await getAll(
        'SELECT COUNT(*) as cnt FROM orders WHERE id = ANY($1) AND partial_paid_amount IS NOT NULL AND partial_paid_amount > 0',
        [invoiceIds]
      );
      return res.json({ ok: true, dryRun: true,
        totalInvoicesProvided: records.length,
        matchedInLiveDb: parseInt(countRow[0].cnt),
        alreadyHavingAPartialAmountSet: parseInt(alreadySetRow[0].cnt),
        sample: preview,
        note: 'Sets partial_paid_amount to the true amount received, and paid=false, for each invoice. Re-run with &execute=true to apply.' });
    }

    let updated = 0;
    for (const [invoiceId, amountReceived] of records) {
      const result = await query(
        'UPDATE orders SET partial_paid_amount = $1, paid = FALSE WHERE id = $2',
        [amountReceived, invoiceId]
      );
      if (result.rowCount > 0) updated++;
    }
    res.json({ ok: true, executed: true, ordersUpdated: updated, totalProvided: records.length });
  } catch (err) {
    console.error('Fix partial payments error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/diagnose-rep-visibility', async (req, res) => {
  if(req.query.secret !== 'toasted2026-diagreps') return res.status(403).json({ok:false});
  try {
    const { getAll } = require('./db');
    const reps = await getAll("SELECT id, fname, lname, email FROM users WHERE role='rep' ORDER BY fname");
    const results = [];
    for (const rep of reps) {
      const acctCount = await getAll('SELECT COUNT(*) as cnt FROM accounts WHERE rep=$1', [rep.id]);
      const ordersViaAccount = await getAll(
        `SELECT COUNT(*) as cnt FROM orders o JOIN accounts a ON o.acct_id=a.id WHERE a.rep=$1`, [rep.id]
      );
      const ordersViaRepId = await getAll('SELECT COUNT(*) as cnt FROM orders WHERE rep_id=$1', [rep.id]);
      results.push({
        rep: rep.fname + ' ' + rep.lname, id: rep.id,
        accountsAssigned: parseInt(acctCount[0].cnt),
        ordersVisibleNow: parseInt(ordersViaAccount[0].cnt),
        ordersTheyPersonallyPlaced: parseInt(ordersViaRepId[0].cnt),
      });
    }
    res.json({ ok: true, results });
  } catch (err) {
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




app.get('/api/run-migration', async (req, res) => {
  if(req.query.secret !== 'toasted2026-runmigration') return res.status(403).json({ok:false});
  try {
    require('child_process').execSync('node db/migrate.js', { stdio: 'inherit' });
    res.json({ok:true, message:'Migration complete'});
  } catch (err) {
    res.status(500).json({ok:false, error: err.message});
  }
});
app.get('/api/mark-orders-paid', async (req, res) => {
  if(req.query.secret !== 'toasted2026-markpaid') return res.status(403).json({ok:false});
  const execute = req.query.execute === 'true';
  try {
    const { query, getAll } = require('./db');
    const invoiceIds = ["ACS-239", "ACS-240", "ACS-241", "ACS-230", "ACS-254", "ACS-270", "ACS-271", "ACS-285", "ACS-284", "ACS-302", "ACS-309", "ACS-318", "ACS-305", "ACS-326", "ACS-329", "ACS-330", "ACS-359", "ACS-361", "ACS-369", "ACS-383", "ACS-384", "ACS-392", "ACS-394", "ACS-396", "ACS-399", "ACS-402", "ACS-401", "ACS-371", "ACS-427", "ACS-434", "ACS-440", "ACS-442", "ACS-439", "ACS-421", "ACS-447", "ACS-450", "ACS-451", "ACS-464", "ACS-465", "ACS-471", "ACS-482", "ACS-472", "ACS-477", "ACS-478", "ACS-501", "ACS-506", "ACS-485", "ACS-522", "ACS-523", "ACS-496", "ACS-527", "ACS-546", "ACS-548", "ACS-549", "ACS-555", "ACS-562", "ACS-563", "ACS-564", "ACS-571", "ACS-577", "ACS-583", "ACS-585", "ACS-605", "ACS-582", "ACS-614", "ACS-608", "ACS-620", "ACS-628", "ACS-629", "ACS-636", "ACS-633", "ACS-637", "ACS-643", "ACS-652", "ACS-658", "ACS-659", "ACS-674", "ACS-677", "ACS-693", "ACS-694", "ACS-701", "ACS-722", "ACS-696", "ACS-720", "ACS-725", "ACS-741", "ACS-745", "ACS-748", "ACS-751", "ACS-757", "ACS-758", "ACS-765", "ACS-781", "ACS-782", "ACS-779", "ACS-780", "ACS-763", "ACS-799", "ACS-809", "ACS-810", "ACS-806", "ACS-836", "ACS-842", "ACS-858", "ACS-845", "ACS-856", "ACS-860", "ACS-874", "ACS-880", "ACS-892", "ACS-893", "ACS-884", "ACS-889", "ACS-898", "ACS-900", "ACS-903", "ACS-916", "ACS-932", "ACS-939", "ACS-928", "ACS-931", "ACS-951", "ACS-952", "ACS-944", "ACS-987", "ACS-968", "ACS-974", "ACS-983", "ACS-986", "ACS-999", "ACS-1006", "ACS-1018", "ACS-1019", "ACS-1024", "ACS-1016", "ACS-1029", "ACS-1017", "ACS-1052", "ACS-1078", "ACS-1079", "ACS-1084", "ACS-1096", "ACS-1089", "ACS-1109", "ACS-1111", "ACS-1101", "ACS-1113", "ACS-1123", "ACS-1118", "ACS-1142", "ACS-1159", "ACS-1173", "ACS-1495", "ACS-1181", "ACS-1177", "ACS-1185", "ACS-1187", "ACS-1184", "ACS-1210", "ACS-1212", "ACS-1229", "ACS-1235", "ACS-1222", "ACS-1257", "ACS-1298", "ACS-1300", "ACS-1313", "ACS-1291", "ACS-1321", "ACS-1320", "ACS-1381", "ACS-1414", "ACS-1457", "ACS-1461", "ACS-1517", "ACS-1519", "ACS-1503", "ACS-1504", "ACS-1520", "ACS-1513", "ACS-1325", "ACS-1568", "ACS-1564", "ACS-1582", "ACS-1581", "ACS-1616", "ACS-1614", "ACS-1591", "ACS-1627", "ACS-1624", "ACS-1622", "ACS-1683", "ACS-1685", "ACS-1678", "ACS-1681", "ACS-1687", "ACS-1705", "ACS-1692", "ACS-1711", "ACS-1724", "ACS-1720", "ACS-1716", "ACS-1714", "ACS-1747", "ACS-1746", "ACS-1760", "ACS-1765", "ACS-1779", "ACS-1790", "ACS-1812", "ACS-1811", "ACS-1876", "ACS-1877", "ACS-1953", "ACS-1958", "ACS-1982", "ACS-1981", "ACS-2025", "ACS-2020", "ACS-2049", "ACS-2108", "ACS-2110", "ACS-2111", "ACS-2120", "ACS-2121", "ACS-2178", "ACS-2177", "ACS-2198", "ACS-2192", "ACS-2186", "ACS-2219", "ACS-2201", "ACS-2199", "ACS-2305", "ACS-2377", "ACS-2376", "ACS-2334", "ACS-2194", "ACS-2332", "ACS-2333", "ACS-2439", "ACS-2441", "ACS-2443", "ACS-2539", "ACS-2604", "ACS-2802", "ACS-2799", "ACS-2821", "ACS-2835", "ACS-2871", "ACS-2870", "ACS-2869", "ACS-2867", "ACS-2891", "ACS-2885", "ACS-2889", "ACS-2890", "ACS-2894", "ACS-2895", "ACS-2896", "ACS-2900", "ACS-2906", "ACS-2968", "ACS-2965", "ACS-2964", "ACS-3001", "ACS-2933", "ACS-3009", "ACS-3037", "ACS-2997", "ACS-2999", "ACS-3039", "ACS-3036", "ACS-3096", "ACS-3163", "ACS-3164", "ACS-3099", "ACS-3102", "ACS-3297", "ACS-3336", "ACS-3334", "ACS-3664", "ACS-3337", "ACS-3452", "ACS-3453", "ACS-3492", "ACS-3558", "ACS-3592", "ACS-3594", "ACS-3659", "ACS-3657", "ACS-3658", "ACS-3668", "ACS-3800", "ACS-3803", "ACS-3809", "ACS-3822", "ACS-3855", "ACS-3806", "ACS-3888", "ACS-3889", "ACS-3890", "ACS-4220", "ACS-4218", "ACS-3988", "ACS-4219", "ACS-4023", "ACS-4031", "ACS-4033", "ACS-4062", "ACS-4153", "ACS-4152", "ACS-4120", "ACS-4162", "ACS-4290", "ACS-4291", "ACS-4292", "ACS-4582", "ACS-4616", "ACS-4654", "ACS-4655", "ACS-4657", "ACS-4699", "ACS-4700", "ACS-4698", "ACS-4721", "ACS-4849", "ACS-4859", "ACS-7587", "ACS-4890", "ACS-4904", "ACS-4956", "ACS-4955", "ACS-4954", "ACS-5044", "ACS-5132", "ACS-5100", "ACS-5180", "ACS-5183", "ACS-5307", "ACS-5390", "ACS-5374", "ACS-5396", "ACS-5420", "ACS-5423", "ACS-5426", "ACS-5434", "ACS-5592", "ACS-5576", "ACS-5577", "ACS-5591", "ACS-5578", "ACS-5684", "ACS-5683", "ACS-5662", "ACS-5661", "ACS-5682", "ACS-5680", "ACS-5678", "ACS-5676", "ACS-5665", "ACS-5674", "ACS-5673", "ACS-5671", "ACS-5670", "ACS-5669", "ACS-5668", "ACS-5667", "ACS-5666", "ACS-5664", "ACS-5675", "ACS-5663", "ACS-5677", "ACS-5802", "ACS-5679", "ACS-5836", "ACS-5934", "ACS-6008", "ACS-6232", "ACS-6233", "ACS-6241", "ACS-6401", "ACS-6403", "ACS-6173", "ACS-6402", "ACS-6462", "ACS-6529", "ACS-6698", "ACS-6732", "ACS-6792", "ACS-6907", "ACS-6906", "ACS-6995", "ACS-7223", "ACS-7222", "ACS-7333", "ACS-7684", "ACS-7816", "ACS-7981", "ACS-8181", "ACS-8186", "ACS-8443", "ACS-8709", "ACS-8773", "ACS-8475", "ACS-8938", "ACS-8721", "ACS-9505", "ACS-9531", "ACS-9503", "ACS-9366", "ACS-9564", "ACS-9597", "ACS-9763", "ACS-9862", "ACS-10225", "ACS-10361", "ACS-10323", "ACS-10192", "ACS-10360", "ACS-10365", "ACS-10525", "ACS-10658", "ACS-10789", "ACS-10790", "ACS-10987", "ACS-10986", "ACS-11083", "ACS-10985", "ACS-11082", "ACS-11182", "ACS-11084", "ACS-11253", "ACS-11291", "ACS-11285", "ACS-11259", "ACS-11445", "ACS-11657", "ACS-13235", "ACS-11776", "ACS-12418", "ACS-12667", "ACS-12832", "ACS-12912", "ACS-13071", "ACS-13393", "ACS-13296", "ACS-13427", "ACS-13626", "ACS-13792", "ACS-13624", "ACS-14054", "ACS-13964", "ACS-14336", "ACS-14335", "ACS-14556", "ACS-14613", "ACS-14651", "ACS-14713", "ACS-14860", "ACS-14859", "ACS-14946", "ACS-15009", "ACS-15247", "ACS-15246", "ACS-15439", "ACS-15706", "ACS-15441", "ACS-15837", "ACS-15834", "ACS-15967", "ACS-16034", "ACS-16107", "ACS-16007", "ACS-16066", "ACS-16305", "ACS-16363", "ACS-16303", "ACS-16758", "ACS-16824", "ACS-17080", "ACS-17078", "ACS-17074", "ACS-17061", "ACS-17081", "ACS-17093", "ACS-17157", "ACS-17289", "ACS-17288", "ACS-17287", "ACS-17652", "ACS-17884", "ACS-17881", "ACS-17880", "ACS-17882", "ACS-17716", "ACS-18342", "ACS-18475", "ACS-18606", "ACS-18642", "ACS-18809", "ACS-18771", "ACS-19139", "ACS-19168", "ACS-19244", "ACS-19201", "ACS-19243", "ACS-18810", "ACS-19245", "ACS-19323", "ACS-19420", "ACS-19564", "ACS-19414", "ACS-19728", "ACS-19893", "ACS-20158", "ACS-19931", "ACS-20323", "ACS-20355", "ACS-20426", "ACS-20590", "ACS-20520", "ACS-20686", "ACS-20685", "ACS-20423", "ACS-20956", "ACS-21249", "ACS-21354", "ACS-21352", "ACS-21512", "ACS-22083", "ACS-22077", "ACS-21972", "ACS-22073", "ACS-22078", "ACS-22436", "ACS-22443", "ACS-22442", "ACS-22437", "ACS-22472", "ACS-22434", "ACS-22540", "ACS-22438", "ACS-22864", "ACS-22699", "ACS-23134", "ACS-23131", "ACS-23402", "ACS-23226", "ACS-23327", "ACS-23328", "ACS-23533", "ACS-23790", "ACS-23791", "ACS-23957", "ACS-23792", "ACS-23952", "ACS-23956", "ACS-23933", "ACS-24249", "ACS-24183", "ACS-24315", "ACS-24520", "ACS-24547", "ACS-24513", "ACS-24646", "ACS-24850", "ACS-24851", "ACS-24911", "ACS-24976", "ACS-25240", "ACS-25241", "ACS-25472", "ACS-25481", "ACS-25641", "ACS-25899", "ACS-26002", "ACS-26000", "ACS-26113", "ACS-26112", "ACS-28191", "ACS-26426", "ACS-26410", "ACS-26988", "ACS-26989", "ACS-27325", "ACS-27254", "ACS-27616", "ACS-27550", "ACS-27632", "ACS-27633", "ACS-27652", "ACS-27747", "ACS-27880", "ACS-28110", "ACS-28209", "ACS-28343", "ACS-28346", "ACS-28344", "ACS-28540", "ACS-28904", "ACS-28704", "ACS-28836", "ACS-28903", "ACS-29068", "ACS-29412", "ACS-29397", "ACS-29364", "ACS-29925", "ACS-29894", "ACS-30255", "ACS-30586", "ACS-30425", "ACS-30424", "ACS-30621", "ACS-31146", "ACS-31015", "ACS-31254", "ACS-31610", "ACS-31710", "ACS-31711", "ACS-31709", "ACS-31892", "ACS-31893", "ACS-32170", "ACS-32433", "ACS-32401", "ACS-32369", "ACS-32571", "ACS-32567", "ACS-32568", "ACS-32569", "ACS-32570", "ACS-32572", "ACS-32573", "ACS-32575", "ACS-32664", "ACS-32763", "ACS-32961", "ACS-33608", "ACS-33819", "ACS-34164", "ACS-34446", "ACS-34386", "ACS-34281", "ACS-35008", "ACS-34944", "ACS-35010", "ACS-34683", "ACS-34682", "ACS-35011", "ACS-34679", "ACS-34678", "ACS-34677", "ACS-34680", "ACS-35121", "ACS-35073", "ACS-35117", "ACS-35123", "ACS-35187", "ACS-35186", "ACS-35305", "ACS-35308", "ACS-35337", "ACS-35122", "ACS-35668", "ACS-35767", "ACS-36097", "ACS-36030", "ACS-36105", "ACS-36104", "ACS-36103", "ACS-36237", "ACS-36363", "ACS-36525", "ACS-36366", "ACS-36700", "ACS-36701", "ACS-36703", "ACS-36699", "ACS-36702", "ACS-36698", "ACS-36694", "ACS-36696", "ACS-36695", "ACS-36693", "ACS-36692", "ACS-36691", "ACS-36697", "ACS-36923", "ACS-36822", "ACS-36921", "ACS-36922", "ACS-37152", "ACS-37518", "ACS-37519", "ACS-37587", "ACS-37599", "ACS-37714", "ACS-37812", "ACS-38081", "ACS-38087", "ACS-38088", "ACS-38089", "ACS-38408", "ACS-38439", "ACS-38574", "ACS-38575", "ACS-38936", "ACS-39066", "ACS-38939", "ACS-39101", "ACS-39205", "ACS-39206", "ACS-39207", "ACS-39528", "ACS-39209", "ACS-39431", "ACS-39562", "ACS-39794", "ACS-39960", "ACS-41511", "ACS-39795", "ACS-39796", "ACS-40288", "ACS-40355", "ACS-40356", "ACS-40354", "ACS-40353", "ACS-40422", "ACS-40488", "ACS-40850", "ACS-40993"];

    if (!execute) {
      const preview = await getAll(
        'SELECT id, paid, paid_date, date FROM orders WHERE id = ANY($1) ORDER BY date LIMIT 15',
        [invoiceIds]
      );
      const countRow = await getAll(
        'SELECT COUNT(*) as cnt FROM orders WHERE id = ANY($1)',
        [invoiceIds]
      );
      const alreadyPaidRow = await getAll(
        'SELECT COUNT(*) as cnt FROM orders WHERE id = ANY($1) AND paid = TRUE',
        [invoiceIds]
      );
      return res.json({ ok: true, dryRun: true,
        totalInvoicesProvided: invoiceIds.length,
        matchedInLiveDb: parseInt(countRow[0].cnt),
        alreadyMarkedPaid: parseInt(alreadyPaidRow[0].cnt),
        sample: preview,
        note: 'paid_date will be set to each order own date field, since no more precise paid date is available. Re-run with &execute=true to apply.' });
    }

    const result = await query(
      'UPDATE orders SET paid = TRUE, paid_date = date WHERE id = ANY($1) AND paid = FALSE',
      [invoiceIds]
    );
    res.json({ ok: true, executed: true, ordersMarkedPaid: result.rowCount });
  } catch (err) {
    console.error('Mark orders paid error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/find-missing-invoice', async (req, res) => {
  if(req.query.secret !== 'toasted2026-findmissing') return res.status(403).json({ok:false});
  try {
    const { getAll } = require('./db');
    const invoiceIds = ["ACS-239", "ACS-240", "ACS-241", "ACS-230", "ACS-254", "ACS-270", "ACS-271", "ACS-285", "ACS-284", "ACS-302", "ACS-309", "ACS-318", "ACS-305", "ACS-326", "ACS-329", "ACS-330", "ACS-359", "ACS-361", "ACS-369", "ACS-383", "ACS-384", "ACS-392", "ACS-394", "ACS-396", "ACS-399", "ACS-402", "ACS-401", "ACS-371", "ACS-427", "ACS-434", "ACS-440", "ACS-442", "ACS-439", "ACS-421", "ACS-447", "ACS-450", "ACS-451", "ACS-464", "ACS-465", "ACS-471", "ACS-482", "ACS-472", "ACS-477", "ACS-478", "ACS-501", "ACS-506", "ACS-485", "ACS-522", "ACS-523", "ACS-496", "ACS-527", "ACS-546", "ACS-548", "ACS-549", "ACS-555", "ACS-562", "ACS-563", "ACS-564", "ACS-571", "ACS-577", "ACS-583", "ACS-585", "ACS-605", "ACS-582", "ACS-614", "ACS-608", "ACS-620", "ACS-628", "ACS-629", "ACS-636", "ACS-633", "ACS-637", "ACS-643", "ACS-652", "ACS-658", "ACS-659", "ACS-674", "ACS-677", "ACS-693", "ACS-694", "ACS-701", "ACS-722", "ACS-696", "ACS-720", "ACS-725", "ACS-741", "ACS-745", "ACS-748", "ACS-751", "ACS-757", "ACS-758", "ACS-765", "ACS-781", "ACS-782", "ACS-779", "ACS-780", "ACS-763", "ACS-799", "ACS-809", "ACS-810", "ACS-806", "ACS-836", "ACS-842", "ACS-858", "ACS-845", "ACS-856", "ACS-860", "ACS-874", "ACS-880", "ACS-892", "ACS-893", "ACS-884", "ACS-889", "ACS-898", "ACS-900", "ACS-903", "ACS-916", "ACS-932", "ACS-939", "ACS-928", "ACS-931", "ACS-951", "ACS-952", "ACS-944", "ACS-987", "ACS-968", "ACS-974", "ACS-983", "ACS-986", "ACS-999", "ACS-1006", "ACS-1018", "ACS-1019", "ACS-1024", "ACS-1016", "ACS-1029", "ACS-1017", "ACS-1052", "ACS-1078", "ACS-1079", "ACS-1084", "ACS-1096", "ACS-1089", "ACS-1109", "ACS-1111", "ACS-1101", "ACS-1113", "ACS-1123", "ACS-1118", "ACS-1142", "ACS-1159", "ACS-1173", "ACS-1495", "ACS-1181", "ACS-1177", "ACS-1185", "ACS-1187", "ACS-1184", "ACS-1210", "ACS-1212", "ACS-1229", "ACS-1235", "ACS-1222", "ACS-1257", "ACS-1298", "ACS-1300", "ACS-1313", "ACS-1291", "ACS-1321", "ACS-1320", "ACS-1381", "ACS-1414", "ACS-1457", "ACS-1461", "ACS-1517", "ACS-1519", "ACS-1503", "ACS-1504", "ACS-1520", "ACS-1513", "ACS-1325", "ACS-1568", "ACS-1564", "ACS-1582", "ACS-1581", "ACS-1616", "ACS-1614", "ACS-1591", "ACS-1627", "ACS-1624", "ACS-1622", "ACS-1683", "ACS-1685", "ACS-1678", "ACS-1681", "ACS-1687", "ACS-1705", "ACS-1692", "ACS-1711", "ACS-1724", "ACS-1720", "ACS-1716", "ACS-1714", "ACS-1747", "ACS-1746", "ACS-1760", "ACS-1765", "ACS-1779", "ACS-1790", "ACS-1812", "ACS-1811", "ACS-1876", "ACS-1877", "ACS-1953", "ACS-1958", "ACS-1982", "ACS-1981", "ACS-2025", "ACS-2020", "ACS-2049", "ACS-2108", "ACS-2110", "ACS-2111", "ACS-2120", "ACS-2121", "ACS-2178", "ACS-2177", "ACS-2198", "ACS-2192", "ACS-2186", "ACS-2219", "ACS-2201", "ACS-2199", "ACS-2305", "ACS-2377", "ACS-2376", "ACS-2334", "ACS-2194", "ACS-2332", "ACS-2333", "ACS-2439", "ACS-2441", "ACS-2443", "ACS-2539", "ACS-2604", "ACS-2802", "ACS-2799", "ACS-2821", "ACS-2835", "ACS-2871", "ACS-2870", "ACS-2869", "ACS-2867", "ACS-2891", "ACS-2885", "ACS-2889", "ACS-2890", "ACS-2894", "ACS-2895", "ACS-2896", "ACS-2900", "ACS-2906", "ACS-2968", "ACS-2965", "ACS-2964", "ACS-3001", "ACS-2933", "ACS-3009", "ACS-3037", "ACS-2997", "ACS-2999", "ACS-3039", "ACS-3036", "ACS-3096", "ACS-3163", "ACS-3164", "ACS-3099", "ACS-3102", "ACS-3297", "ACS-3336", "ACS-3334", "ACS-3664", "ACS-3337", "ACS-3452", "ACS-3453", "ACS-3492", "ACS-3558", "ACS-3592", "ACS-3594", "ACS-3659", "ACS-3657", "ACS-3658", "ACS-3668", "ACS-3800", "ACS-3803", "ACS-3809", "ACS-3822", "ACS-3855", "ACS-3806", "ACS-3888", "ACS-3889", "ACS-3890", "ACS-4220", "ACS-4218", "ACS-3988", "ACS-4219", "ACS-4023", "ACS-4031", "ACS-4033", "ACS-4062", "ACS-4153", "ACS-4152", "ACS-4120", "ACS-4162", "ACS-4290", "ACS-4291", "ACS-4292", "ACS-4582", "ACS-4616", "ACS-4654", "ACS-4655", "ACS-4657", "ACS-4699", "ACS-4700", "ACS-4698", "ACS-4721", "ACS-4849", "ACS-4859", "ACS-7587", "ACS-4890", "ACS-4904", "ACS-4956", "ACS-4955", "ACS-4954", "ACS-5044", "ACS-5132", "ACS-5100", "ACS-5180", "ACS-5183", "ACS-5307", "ACS-5390", "ACS-5374", "ACS-5396", "ACS-5420", "ACS-5423", "ACS-5426", "ACS-5434", "ACS-5592", "ACS-5576", "ACS-5577", "ACS-5591", "ACS-5578", "ACS-5684", "ACS-5683", "ACS-5662", "ACS-5661", "ACS-5682", "ACS-5680", "ACS-5678", "ACS-5676", "ACS-5665", "ACS-5674", "ACS-5673", "ACS-5671", "ACS-5670", "ACS-5669", "ACS-5668", "ACS-5667", "ACS-5666", "ACS-5664", "ACS-5675", "ACS-5663", "ACS-5677", "ACS-5802", "ACS-5679", "ACS-5836", "ACS-5934", "ACS-6008", "ACS-6232", "ACS-6233", "ACS-6241", "ACS-6401", "ACS-6403", "ACS-6173", "ACS-6402", "ACS-6462", "ACS-6529", "ACS-6698", "ACS-6732", "ACS-6792", "ACS-6907", "ACS-6906", "ACS-6995", "ACS-7223", "ACS-7222", "ACS-7333", "ACS-7684", "ACS-7816", "ACS-7981", "ACS-8181", "ACS-8186", "ACS-8443", "ACS-8709", "ACS-8773", "ACS-8475", "ACS-8938", "ACS-8721", "ACS-9505", "ACS-9531", "ACS-9503", "ACS-9366", "ACS-9564", "ACS-9597", "ACS-9763", "ACS-9862", "ACS-10225", "ACS-10361", "ACS-10323", "ACS-10192", "ACS-10360", "ACS-10365", "ACS-10525", "ACS-10658", "ACS-10789", "ACS-10790", "ACS-10987", "ACS-10986", "ACS-11083", "ACS-10985", "ACS-11082", "ACS-11182", "ACS-11084", "ACS-11253", "ACS-11291", "ACS-11285", "ACS-11259", "ACS-11445", "ACS-11657", "ACS-13235", "ACS-11776", "ACS-12418", "ACS-12667", "ACS-12832", "ACS-12912", "ACS-13071", "ACS-13393", "ACS-13296", "ACS-13427", "ACS-13626", "ACS-13792", "ACS-13624", "ACS-14054", "ACS-13964", "ACS-14336", "ACS-14335", "ACS-14556", "ACS-14613", "ACS-14651", "ACS-14713", "ACS-14860", "ACS-14859", "ACS-14946", "ACS-15009", "ACS-15247", "ACS-15246", "ACS-15439", "ACS-15706", "ACS-15441", "ACS-15837", "ACS-15834", "ACS-15967", "ACS-16034", "ACS-16107", "ACS-16007", "ACS-16066", "ACS-16305", "ACS-16363", "ACS-16303", "ACS-16758", "ACS-16824", "ACS-17080", "ACS-17078", "ACS-17074", "ACS-17061", "ACS-17081", "ACS-17093", "ACS-17157", "ACS-17289", "ACS-17288", "ACS-17287", "ACS-17652", "ACS-17884", "ACS-17881", "ACS-17880", "ACS-17882", "ACS-17716", "ACS-18342", "ACS-18475", "ACS-18606", "ACS-18642", "ACS-18809", "ACS-18771", "ACS-19139", "ACS-19168", "ACS-19244", "ACS-19201", "ACS-19243", "ACS-18810", "ACS-19245", "ACS-19323", "ACS-19420", "ACS-19564", "ACS-19414", "ACS-19728", "ACS-19893", "ACS-20158", "ACS-19931", "ACS-20323", "ACS-20355", "ACS-20426", "ACS-20590", "ACS-20520", "ACS-20686", "ACS-20685", "ACS-20423", "ACS-20956", "ACS-21249", "ACS-21354", "ACS-21352", "ACS-21512", "ACS-22083", "ACS-22077", "ACS-21972", "ACS-22073", "ACS-22078", "ACS-22436", "ACS-22443", "ACS-22442", "ACS-22437", "ACS-22472", "ACS-22434", "ACS-22540", "ACS-22438", "ACS-22864", "ACS-22699", "ACS-23134", "ACS-23131", "ACS-23402", "ACS-23226", "ACS-23327", "ACS-23328", "ACS-23533", "ACS-23790", "ACS-23791", "ACS-23957", "ACS-23792", "ACS-23952", "ACS-23956", "ACS-23933", "ACS-24249", "ACS-24183", "ACS-24315", "ACS-24520", "ACS-24547", "ACS-24513", "ACS-24646", "ACS-24850", "ACS-24851", "ACS-24911", "ACS-24976", "ACS-25240", "ACS-25241", "ACS-25472", "ACS-25481", "ACS-25641", "ACS-25899", "ACS-26002", "ACS-26000", "ACS-26113", "ACS-26112", "ACS-28191", "ACS-26426", "ACS-26410", "ACS-26988", "ACS-26989", "ACS-27325", "ACS-27254", "ACS-27616", "ACS-27550", "ACS-27632", "ACS-27633", "ACS-27652", "ACS-27747", "ACS-27880", "ACS-28110", "ACS-28209", "ACS-28343", "ACS-28346", "ACS-28344", "ACS-28540", "ACS-28904", "ACS-28704", "ACS-28836", "ACS-28903", "ACS-29068", "ACS-29412", "ACS-29397", "ACS-29364", "ACS-29925", "ACS-29894", "ACS-30255", "ACS-30586", "ACS-30425", "ACS-30424", "ACS-30621", "ACS-31146", "ACS-31015", "ACS-31254", "ACS-31610", "ACS-31710", "ACS-31711", "ACS-31709", "ACS-31892", "ACS-31893", "ACS-32170", "ACS-32433", "ACS-32401", "ACS-32369", "ACS-32571", "ACS-32567", "ACS-32568", "ACS-32569", "ACS-32570", "ACS-32572", "ACS-32573", "ACS-32575", "ACS-32664", "ACS-32763", "ACS-32961", "ACS-33608", "ACS-33819", "ACS-34164", "ACS-34446", "ACS-34386", "ACS-34281", "ACS-35008", "ACS-34944", "ACS-35010", "ACS-34683", "ACS-34682", "ACS-35011", "ACS-34679", "ACS-34678", "ACS-34677", "ACS-34680", "ACS-35121", "ACS-35073", "ACS-35117", "ACS-35123", "ACS-35187", "ACS-35186", "ACS-35305", "ACS-35308", "ACS-35337", "ACS-35122", "ACS-35668", "ACS-35767", "ACS-36097", "ACS-36030", "ACS-36105", "ACS-36104", "ACS-36103", "ACS-36237", "ACS-36363", "ACS-36525", "ACS-36366", "ACS-36700", "ACS-36701", "ACS-36703", "ACS-36699", "ACS-36702", "ACS-36698", "ACS-36694", "ACS-36696", "ACS-36695", "ACS-36693", "ACS-36692", "ACS-36691", "ACS-36697", "ACS-36923", "ACS-36822", "ACS-36921", "ACS-36922", "ACS-37152", "ACS-37518", "ACS-37519", "ACS-37587", "ACS-37599", "ACS-37714", "ACS-37812", "ACS-38081", "ACS-38087", "ACS-38088", "ACS-38089", "ACS-38408", "ACS-38439", "ACS-38574", "ACS-38575", "ACS-38936", "ACS-39066", "ACS-38939", "ACS-39101", "ACS-39205", "ACS-39206", "ACS-39207", "ACS-39528", "ACS-39209", "ACS-39431", "ACS-39562", "ACS-39794", "ACS-39960", "ACS-41511", "ACS-39795", "ACS-39796", "ACS-40288", "ACS-40355", "ACS-40356", "ACS-40354", "ACS-40353", "ACS-40422", "ACS-40488", "ACS-40850", "ACS-40993"];
    const rows = await getAll('SELECT id FROM orders WHERE id = ANY($1)', [invoiceIds]);
    const foundSet = new Set(rows.map(r => r.id));
    const missing = invoiceIds.filter(id => !foundSet.has(id));
    res.json({ ok: true, missing });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/migrate-accounts', async (req, res) => {
  if(req.query.secret !== 'toasted2026') return res.status(403).json({ok:false});
  const {query} = require('./db');
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS warehouse_code TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tax_id TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS resale_num TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lic_expiry TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS abc_detail TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) DEFAULT 0`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS payment_provider TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pref_method TEXT`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS online_payments TEXT DEFAULT 'No'`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS redemption TEXT DEFAULT 'No'`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avg_days_to_pay NUMERIC(5,1) DEFAULT 0`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(10,2) DEFAULT 0`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credit_balance NUMERIC(10,2) DEFAULT 0`);
  res.json({ok:true, message:'Account columns added'});
});
app.get('/api/list-blank-crv', async (req, res) => {
  if(req.query.secret !== 'toasted2026-blankcrv') return res.status(403).json({ok:false});
  try {
    const { getAll } = require('./db');
    const rows = await getAll(`SELECT sku, name, producer FROM products WHERE redemption_entry IS NULL OR TRIM(redemption_entry) = '' ORDER BY producer, name`);
    res.json({ ok: true, count: rows.length, products: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/migrate-multilane', async (req, res) => {
  if(req.query.secret !== 'toasted2026-multilane') return res.status(403).json({ok:false});
  try {
    require('child_process').execSync('node db/migrate.js', { stdio: 'inherit' });
    res.json({ok:true, message:'Migration complete -- multi-account/corp-group pricing lane columns added'});
  } catch (err) {
    res.status(500).json({ok:false, error: err.message});
  }
});
app.get('/api/restrict-liber-12pack', async (req, res) => {
  if(req.query.secret !== 'toasted2026-restrictliber') return res.status(403).json({ok:false});
  try {
    const { query, getAll } = require('./db');
    const matches = await getAll(
      `SELECT sku, name, producer, btl FROM products WHERE producer ILIKE '%liber%' AND btl=12`
    );
    for (const m of matches) {
      await query(`UPDATE products SET restricted=TRUE WHERE sku=$1`, [m.sku]);
    }
    res.json({ ok: true, restrictedCount: matches.length, products: matches });
  } catch (err) {
    console.error('Restrict Liber 12-pack error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/diagnose-pack-sizes', async (req, res) => {
  if(req.query.secret !== 'toasted2026-packsizes') return res.status(403).json({ok:false});
  try {
    const { getAll } = require('./db');
    const rows = await getAll(`SELECT sku, name, producer, btl, bottle_size FROM products ORDER BY producer, name`);
    const mismatches = [];
    let noPatternFound = 0;

    for (const r of rows) {
      const m = (r.name || '').match(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*(ml|l)?\b/i);
      if (!m) { noPatternFound++; continue; }
      const foundBtl = parseInt(m[1]);
      const sizeNum = parseFloat(m[2]);
      let unit = (m[3] || '').toLowerCase();
      if (!unit) unit = sizeNum >= 10 ? 'ml' : 'l';
      const foundSize = unit === 'l' ? (sizeNum + 'L') : (Math.round(sizeNum) + 'ml');

      const currentBtl = r.btl;
      const currentSize = r.bottle_size || '';
      const btlMismatch = currentBtl !== foundBtl;
      const sizeMismatch = currentSize !== foundSize;
      if (btlMismatch || sizeMismatch) {
        mismatches.push({
          sku: r.sku, name: r.name, producer: r.producer,
          currentBtl, foundBtl, currentSize: currentSize || '(not set)', foundSize,
        });
      }
    }
    res.json({ ok: true, totalProducts: rows.length, noPatternFound, mismatchCount: mismatches.length, mismatches });
  } catch (err) {
    console.error('Diagnose pack sizes error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/migrate-invoice-emails', async (req, res) => {
  if(req.query.secret !== 'toasted2026-invoiceemails') return res.status(403).json({ok:false});
  try {
    require('child_process').execSync('node db/migrate.js', { stdio: 'inherit' });
    res.json({ok:true, message:'Migration complete -- scheduled_invoice_emails table added'});
  } catch (err) {
    res.status(500).json({ok:false, error: err.message});
  }
});
app.get('/api/apply-pack-sizes', async (req, res) => {
  if(req.query.secret !== 'toasted2026-packapply') return res.status(403).json({ok:false});
  try {
    const { query, getAll } = require('./db');
    const dryRun = req.query.apply !== 'true';
    const packSizes = [{"sku": "845098", "btl": 12}, {"sku": "845001", "btl": 12}, {"sku": "845066", "btl": 12}, {"sku": "845100", "btl": 12}, {"sku": "845195", "btl": 12}, {"sku": "945015", "btl": 12}, {"sku": "845057", "btl": 12}, {"sku": "845099", "btl": 12}, {"sku": "845115", "btl": 12}, {"sku": "845190", "btl": 12}, {"sku": "845235", "btl": 12}, {"sku": "845242", "btl": 12}, {"sku": "845173", "btl": 12}, {"sku": "845232", "btl": 12}, {"sku": "845233", "btl": 12}, {"sku": "845234", "btl": 12}, {"sku": "945029", "btl": 12}, {"sku": "945030", "btl": 12}, {"sku": "945031", "btl": 12}, {"sku": "845191", "btl": 12}, {"sku": "845275", "btl": 12}, {"sku": "845002", "btl": 6}, {"sku": "845003", "btl": 6}, {"sku": "845004", "btl": 6}, {"sku": "845005", "btl": 6}, {"sku": "845009", "btl": 6}, {"sku": "845010", "btl": 6}, {"sku": "845011", "btl": 6}, {"sku": "845013", "btl": 6}, {"sku": "845014", "btl": 12}, {"sku": "845015", "btl": 6}, {"sku": "845016", "btl": 6}, {"sku": "845026", "btl": 6}, {"sku": "845031", "btl": 6}, {"sku": "845032", "btl": 6}, {"sku": "845032-12", "btl": 12}, {"sku": "845033", "btl": 6}, {"sku": "845033-12", "btl": 12}, {"sku": "845034", "btl": 6}, {"sku": "845035", "btl": 12}, {"sku": "845039", "btl": 6}, {"sku": "845040", "btl": 12}, {"sku": "845041", "btl": 12}, {"sku": "845044", "btl": 12}, {"sku": "845045", "btl": 12}, {"sku": "845053", "btl": 6}, {"sku": "845054", "btl": 6}, {"sku": "845055", "btl": 6}, {"sku": "845056", "btl": 6}, {"sku": "845061", "btl": 6}, {"sku": "845065", "btl": 6}, {"sku": "845078", "btl": 6}, {"sku": "845079", "btl": 6}, {"sku": "845080", "btl": 6}, {"sku": "845081", "btl": 6}, {"sku": "845082", "btl": 6}, {"sku": "845084", "btl": 12}, {"sku": "845085", "btl": 6}, {"sku": "845087", "btl": 6}, {"sku": "845088", "btl": 6}, {"sku": "845089", "btl": 6}, {"sku": "845101", "btl": 12}, {"sku": "845102", "btl": 12}, {"sku": "845103", "btl": 12}, {"sku": "845104", "btl": 6}, {"sku": "845111", "btl": 12}, {"sku": "845113", "btl": 6}, {"sku": "845113-12", "btl": 12}, {"sku": "845114", "btl": 6}, {"sku": "845114-12", "btl": 12}, {"sku": "845117", "btl": 6}, {"sku": "845118", "btl": 12}, {"sku": "845119", "btl": 6}, {"sku": "845131", "btl": 6}, {"sku": "845131-12", "btl": 12}, {"sku": "845133", "btl": 6}, {"sku": "845135", "btl": 6}, {"sku": "845136", "btl": 6}, {"sku": "845137", "btl": 6}, {"sku": "845141", "btl": 6}, {"sku": "845141-12", "btl": 12}, {"sku": "845142", "btl": 6}, {"sku": "845146", "btl": 6}, {"sku": "845147", "btl": 12}, {"sku": "845151", "btl": 12}, {"sku": "845153", "btl": 12}, {"sku": "845154", "btl": 6}, {"sku": "845155", "btl": 6}, {"sku": "845156", "btl": 6}, {"sku": "845157", "btl": 6}, {"sku": "845158", "btl": 12}, {"sku": "845162", "btl": 6}, {"sku": "845167", "btl": 6}, {"sku": "845169", "btl": 6}, {"sku": "845170", "btl": 6}, {"sku": "845171", "btl": 6}, {"sku": "845174", "btl": 6}, {"sku": "845175", "btl": 12}, {"sku": "845176", "btl": 12}, {"sku": "845183", "btl": 6}, {"sku": "845183-12", "btl": 12}, {"sku": "845184", "btl": 6}, {"sku": "845184-12", "btl": 12}, {"sku": "845185", "btl": 6}, {"sku": "845185-12", "btl": 12}, {"sku": "845186", "btl": 6}, {"sku": "845187", "btl": 6}, {"sku": "845188", "btl": 6}, {"sku": "845189", "btl": 6}, {"sku": "845192", "btl": 6}, {"sku": "845193", "btl": 6}, {"sku": "845193-12", "btl": 12}, {"sku": "845194", "btl": 6}, {"sku": "845198", "btl": 6}, {"sku": "845198-12", "btl": 12}, {"sku": "845200", "btl": 6}, {"sku": "845200-12", "btl": 12}, {"sku": "845202", "btl": 12}, {"sku": "845203", "btl": 6}, {"sku": "845204", "btl": 6}, {"sku": "845205", "btl": 6}, {"sku": "845206", "btl": 6}, {"sku": "845207", "btl": 6}, {"sku": "845209", "btl": 6}, {"sku": "845210", "btl": 6}, {"sku": "845211", "btl": 6}, {"sku": "845222", "btl": 12}, {"sku": "845225", "btl": 12}, {"sku": "845226", "btl": 6}, {"sku": "845227", "btl": 6}, {"sku": "845228", "btl": 6}, {"sku": "845229", "btl": 12}, {"sku": "845230", "btl": 6}, {"sku": "845231", "btl": 6}, {"sku": "845236", "btl": 12}, {"sku": "845237", "btl": 12}, {"sku": "845238", "btl": 12}, {"sku": "845239", "btl": 12}, {"sku": "845240", "btl": 12}, {"sku": "845241", "btl": 12}, {"sku": "845247", "btl": 6}, {"sku": "845248", "btl": 6}, {"sku": "845249", "btl": 6}, {"sku": "845250", "btl": 6}, {"sku": "845251", "btl": 6}, {"sku": "845252", "btl": 6}, {"sku": "845253", "btl": 18}, {"sku": "845256", "btl": 6}, {"sku": "845257", "btl": 6}, {"sku": "845257-12", "btl": 12}, {"sku": "845258", "btl": 6}, {"sku": "845258-12", "btl": 12}, {"sku": "845265", "btl": 6}, {"sku": "845266", "btl": 6}, {"sku": "845267", "btl": 6}, {"sku": "845267-12", "btl": 12}, {"sku": "845268", "btl": 6}, {"sku": "845269", "btl": 6}, {"sku": "845270", "btl": 6}, {"sku": "845271", "btl": 6}, {"sku": "845271-12", "btl": 12}, {"sku": "845272", "btl": 6}, {"sku": "845273", "btl": 6}, {"sku": "845273-12", "btl": 12}, {"sku": "845274", "btl": 6}, {"sku": "845278", "btl": 6}, {"sku": "845280", "btl": 6}, {"sku": "845280-12", "btl": 12}, {"sku": "845281", "btl": 6}, {"sku": "845282", "btl": 12}, {"sku": "845283", "btl": 12}, {"sku": "845284", "btl": 12}, {"sku": "845285", "btl": 12}, {"sku": "845286", "btl": 12}, {"sku": "845287", "btl": 12}, {"sku": "845288", "btl": 12}, {"sku": "845290", "btl": 12}, {"sku": "845291", "btl": 6}, {"sku": "845291-12", "btl": 12}, {"sku": "845293", "btl": 6}, {"sku": "845295", "btl": 12}, {"sku": "845296", "btl": 12}, {"sku": "845297", "btl": 12}, {"sku": "845299", "btl": 6}, {"sku": "845300", "btl": 6}, {"sku": "845301", "btl": 6}, {"sku": "845302", "btl": 6}, {"sku": "845303", "btl": 18}, {"sku": "845307", "btl": 6}, {"sku": "845307-12", "btl": 12}, {"sku": "845308", "btl": 6}, {"sku": "845309", "btl": 6}, {"sku": "845310", "btl": 6}, {"sku": "845311", "btl": 6}, {"sku": "845312", "btl": 6}, {"sku": "845313", "btl": 6}, {"sku": "845313-2", "btl": 12}, {"sku": "845314", "btl": 6}, {"sku": "845315", "btl": 6}, {"sku": "845316", "btl": 6}, {"sku": "845316-2", "btl": 12}, {"sku": "845317", "btl": 6}, {"sku": "845317-2", "btl": 12}, {"sku": "845318", "btl": 6}, {"sku": "845319", "btl": 6}, {"sku": "845319-12", "btl": 12}, {"sku": "845320", "btl": 6}, {"sku": "845324", "btl": 6}, {"sku": "845325", "btl": 6}, {"sku": "845326", "btl": 6}, {"sku": "845326-2", "btl": 12}, {"sku": "845329", "btl": 6}, {"sku": "845329-12", "btl": 12}, {"sku": "845330", "btl": 6}, {"sku": "845331", "btl": 6}, {"sku": "845332", "btl": 6}, {"sku": "845332-12", "btl": 12}, {"sku": "845333", "btl": 6}, {"sku": "845333-12", "btl": 12}, {"sku": "845334", "btl": 6}, {"sku": "845334-12", "btl": 12}, {"sku": "845335", "btl": 6}, {"sku": "845335-2", "btl": 12}, {"sku": "845336", "btl": 6}, {"sku": "845336-2", "btl": 12}, {"sku": "845337", "btl": 6}, {"sku": "845337-12", "btl": 12}, {"sku": "845338", "btl": 6}, {"sku": "845338-2", "btl": 12}, {"sku": "845339", "btl": 6}, {"sku": "845339-12", "btl": 12}, {"sku": "845340", "btl": 6}, {"sku": "845340-12", "btl": 12}, {"sku": "845341", "btl": 6}, {"sku": "845341-12", "btl": 12}, {"sku": "845342", "btl": 6}, {"sku": "845343", "btl": 6}, {"sku": "845343-12", "btl": 12}, {"sku": "845344", "btl": 6}, {"sku": "845344-12", "btl": 12}, {"sku": "845345", "btl": 6}, {"sku": "845346", "btl": 6}, {"sku": "845346-12", "btl": 12}, {"sku": "845347", "btl": 6}, {"sku": "845347-12", "btl": 12}, {"sku": "845348", "btl": 6}, {"sku": "845348-12", "btl": 12}, {"sku": "845352", "btl": 6}, {"sku": "845352-12", "btl": 12}, {"sku": "845354", "btl": 6}, {"sku": "845355", "btl": 6}, {"sku": "845356", "btl": 6}, {"sku": "845357", "btl": 6}, {"sku": "845358", "btl": 6}, {"sku": "845359", "btl": 12}, {"sku": "845360", "btl": 12}, {"sku": "845361", "btl": 6}, {"sku": "845362", "btl": 6}, {"sku": "845363", "btl": 4}, {"sku": "845364", "btl": 6}, {"sku": "845364-12", "btl": 12}, {"sku": "845365", "btl": 6}, {"sku": "845365-12", "btl": 12}, {"sku": "845366", "btl": 6}, {"sku": "845367", "btl": 6}, {"sku": "845368", "btl": 6}, {"sku": "845368-12", "btl": 12}, {"sku": "845369", "btl": 3}, {"sku": "845371", "btl": 6}, {"sku": "845379", "btl": 6}, {"sku": "845380", "btl": 6}, {"sku": "845381", "btl": 6}, {"sku": "845383", "btl": 6}, {"sku": "845384", "btl": 6}, {"sku": "845387", "btl": 6}, {"sku": "845388", "btl": 6}, {"sku": "845388-12", "btl": 12}, {"sku": "845389", "btl": 6}, {"sku": "845389-12", "btl": 12}, {"sku": "845390", "btl": 6}, {"sku": "845396", "btl": 12}, {"sku": "845397", "btl": 12}, {"sku": "845398", "btl": 6}, {"sku": "845399", "btl": 6}, {"sku": "845400", "btl": 6}, {"sku": "845401", "btl": 6}, {"sku": "845402", "btl": 6}, {"sku": "845403", "btl": 6}, {"sku": "845403-12", "btl": 12}, {"sku": "845404", "btl": 6}, {"sku": "845405", "btl": 6}, {"sku": "845406", "btl": 6}, {"sku": "845407", "btl": 6}, {"sku": "845408", "btl": 6}, {"sku": "845409", "btl": 6}, {"sku": "845410", "btl": 6}, {"sku": "845411", "btl": 12}, {"sku": "845412", "btl": 6}, {"sku": "845413", "btl": 12}, {"sku": "845414", "btl": 12}, {"sku": "845415", "btl": 12}, {"sku": "845416", "btl": 12}, {"sku": "845417", "btl": 12}, {"sku": "845418", "btl": 6}, {"sku": "845419", "btl": 6}, {"sku": "845420", "btl": 6}, {"sku": "845420-12", "btl": 12}, {"sku": "845423", "btl": 6}, {"sku": "945001", "btl": 12}, {"sku": "945002", "btl": 12}, {"sku": "945003", "btl": 12}, {"sku": "945004", "btl": 6}, {"sku": "945005", "btl": 6}, {"sku": "945006", "btl": 6}, {"sku": "945007", "btl": 12}, {"sku": "945008", "btl": 6}, {"sku": "945009", "btl": 6}, {"sku": "945009-12", "btl": 12}, {"sku": "945010", "btl": 12}, {"sku": "945011", "btl": 6}, {"sku": "945012", "btl": 6}, {"sku": "945016", "btl": 6}, {"sku": "945017", "btl": 6}, {"sku": "945018", "btl": 6}, {"sku": "945019", "btl": 6}, {"sku": "945020", "btl": 6}, {"sku": "945021", "btl": 6}, {"sku": "945023", "btl": 24}, {"sku": "945024", "btl": 24}, {"sku": "945026", "btl": 6}, {"sku": "945027", "btl": 6}, {"sku": "945038", "btl": 6}, {"sku": "945039", "btl": 6}, {"sku": "945040", "btl": 6}, {"sku": "945042", "btl": 6}, {"sku": "945043", "btl": 6}, {"sku": "945046", "btl": 6}, {"sku": "945047", "btl": 6}, {"sku": "945048", "btl": 6}, {"sku": "945051", "btl": 24}, {"sku": "945052", "btl": 24}, {"sku": "945053", "btl": 12}, {"sku": "945054", "btl": 12}, {"sku": "945055", "btl": 12}, {"sku": "945056", "btl": 6}, {"sku": "945056-12", "btl": 12}, {"sku": "945057", "btl": 6}, {"sku": "945058", "btl": 6}, {"sku": "945059", "btl": 12}, {"sku": "945060", "btl": 12}, {"sku": "945061", "btl": 12}, {"sku": "945062", "btl": 12}, {"sku": "945063", "btl": 12}, {"sku": "945064", "btl": 12}, {"sku": "945066", "btl": 6}, {"sku": "945067", "btl": 6}, {"sku": "945068", "btl": 6}, {"sku": "945069", "btl": 6}, {"sku": "945070", "btl": 24}, {"sku": "945071", "btl": 24}, {"sku": "945072", "btl": 6}, {"sku": "945073", "btl": 12}, {"sku": "945074", "btl": 12}, {"sku": "945075", "btl": 12}, {"sku": "945076", "btl": 12}, {"sku": "945077", "btl": 12}, {"sku": "945078", "btl": 24}, {"sku": "945079", "btl": 24}, {"sku": "945080", "btl": 24}, {"sku": "945081", "btl": 24}, {"sku": "945082", "btl": 24}, {"sku": "945083", "btl": 24}, {"sku": "945084", "btl": 24}, {"sku": "945085", "btl": 120}, {"sku": "945086", "btl": 6}, {"sku": "945087", "btl": 6}, {"sku": "945088", "btl": 6}, {"sku": "945090", "btl": 12}, {"sku": "945092", "btl": 6}, {"sku": "945093", "btl": 12}, {"sku": "945094", "btl": 12}, {"sku": "945095", "btl": 12}, {"sku": "945096", "btl": 12}, {"sku": "945097", "btl": 6}, {"sku": "945097-12", "btl": 12}, {"sku": "945098", "btl": 12}, {"sku": "945099", "btl": 6}, {"sku": "945100", "btl": 6}, {"sku": "945101", "btl": 12}, {"sku": "945102", "btl": 6}, {"sku": "945103", "btl": 12}, {"sku": "945104", "btl": 6}, {"sku": "945104-12", "btl": 12}, {"sku": "945105", "btl": 6}, {"sku": "945105-12", "btl": 12}, {"sku": "945106", "btl": 6}, {"sku": "945106-12", "btl": 12}, {"sku": "945107", "btl": 6}, {"sku": "945107-12", "btl": 12}, {"sku": "945108", "btl": 6}, {"sku": "945108-12", "btl": 12}, {"sku": "945109", "btl": 6}, {"sku": "945110", "btl": 6}, {"sku": "945111", "btl": 120}, {"sku": "945112", "btl": 120}, {"sku": "945113", "btl": 6}, {"sku": "945114", "btl": 6}, {"sku": "945115", "btl": 6}, {"sku": "945116", "btl": 6}, {"sku": "945117", "btl": 6}, {"sku": "945118", "btl": 6}, {"sku": "945119", "btl": 6}, {"sku": "945120", "btl": 6}, {"sku": "945121", "btl": 24}, {"sku": "945122", "btl": 6}, {"sku": "945123", "btl": 6}, {"sku": "945124", "btl": 6}, {"sku": "945125", "btl": 6}, {"sku": "945126", "btl": 6}, {"sku": "945127", "btl": 6}, {"sku": "945128", "btl": 6}, {"sku": "945129", "btl": 12}, {"sku": "945130", "btl": 6}, {"sku": "ADJ00001", "btl": 12}, {"sku": "BF", "btl": 1}, {"sku": "CACRV24-", "btl": 1}, {"sku": "CACRV24oz+", "btl": 1}, {"sku": "CACRVCAN24- na", "btl": 1}, {"sku": "CA CRV CAN (<24oz)", "btl": 1}, {"sku": "Catalog", "btl": 1}, {"sku": "CRV1", "btl": 1}, {"sku": "DF1", "btl": 1}, {"sku": "EHRBPK", "btl": 6}, {"sku": "LF1", "btl": 1}, {"sku": "LLRBPK", "btl": 6}, {"sku": "Mystery", "btl": 6}, {"sku": "OHRBPK", "btl": 6}, {"sku": "PAL01", "btl": 12}, {"sku": "SF1", "btl": 1}];

    const current = await getAll('SELECT sku, btl FROM products');
    const currentBySku = {};
    current.forEach(r => { currentBySku[r.sku] = r.btl; });

    let matched = 0, changed = 0, unchanged = 0, notFound = 0;
    const changes = [];
    const missing = [];

    for (const row of packSizes) {
      if (!(row.sku in currentBySku)) { notFound++; missing.push(row.sku); continue; }
      matched++;
      if (currentBySku[row.sku] !== row.btl) {
        changed++;
        changes.push({ sku: row.sku, oldBtl: currentBySku[row.sku], newBtl: row.btl });
        if (!dryRun) {
          await query('UPDATE products SET btl=$1 WHERE sku=$2', [row.btl, row.sku]);
        }
      } else {
        unchanged++;
      }
    }

    res.json({
      ok: true, dryRun, totalInFile: packSizes.length,
      matched, changed, unchanged, notFound,
      changesSample: changes.slice(0, 50), changeCount: changes.length,
      missingSkus: missing,
    });
  } catch (err) {
    console.error('Apply pack sizes error:', err.message);
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
      console.log('Database check failed, attempting migrations...', err.message);
      try {
        require('child_process').execSync('node db/migrate.js', { stdio: 'inherit' });
        console.log('Migrations complete');
      } catch (migrateErr) {
        console.error('Migration attempt failed -- server will stay up, but the database may not be reachable yet:', migrateErr.message);
      }
    }
  }

  // Scheduled invoice emails ("send on day of delivery") -- checked hourly so a delivery
  // date rolling over gets caught within the hour, without needing a separate cron service.
  const ordersRouter = require('./routes/orders');
  const runScheduledEmailCheck = async () => {
    try {
      const sent = await ordersRouter.processScheduledInvoiceEmails();
      if (sent > 0) console.log(`Sent ${sent} scheduled invoice email(s)`);
    } catch (err) {
      console.error('Scheduled invoice email check failed:', err.message);
    }
  };
  runScheduledEmailCheck(); // catch anything due right at startup too
  setInterval(runScheduledEmailCheck, 60 * 60 * 1000);
});
