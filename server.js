require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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




app.get('/api/find-max-invoice', async (req, res) => {
  if(req.query.secret !== 'toasted2026-maxinvoice') return res.status(403).json({ok:false});
  try {
    const { getAll } = require('./db');
    // Only pure ACS-NNNNN (all digits after the dash) counts as the real sequence --
    // excludes any differently-formatted test IDs.
    const rows = await getAll(
      `SELECT id FROM orders WHERE id ~ '^ACS-[0-9]+$' ORDER BY (SUBSTRING(id FROM 5))::bigint DESC LIMIT 10`
    );
    const nonMatching = await getAll(
      `SELECT id FROM orders WHERE id LIKE 'ACS-%' AND id !~ '^ACS-[0-9]+$' ORDER BY created_at DESC LIMIT 10`
    );
    res.json({ ok: true, topSequentialIds: rows.map(r=>r.id), nonSequentialSample: nonMatching.map(r=>r.id) });
  } catch (err) {
    console.error('Find max invoice error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/set-order-sequence', async (req, res) => {
  if(req.query.secret !== 'toasted2026-setordseq') return res.status(403).json({ok:false});
  const nextSeq = parseInt(req.query.next);
  if(!nextSeq || nextSeq < 1) return res.status(400).json({ok:false, error:'Provide ?next=NNNNN -- the next order number to assign'});
  try {
    const { query } = require('./db');
    require('child_process').execSync('node db/migrate.js', { stdio: 'inherit' });
    await query('UPDATE order_code_sequence SET next_seq=$1 WHERE id=1', [nextSeq]);
    res.json({ ok: true, nextOrderWillBe: 'ACS-' + nextSeq });
  } catch (err) {
    console.error('Set order sequence error:', err.message);
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
