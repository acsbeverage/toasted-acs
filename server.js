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

app.use(express.static(path.join(__dirname, 'public')));
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
