require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, getOne } = require('./index');
const fs = require('fs');
const path = require('path');

async function extractFromHTML() {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error('public/index.html not found. Copy the Toasted HTML file there first.');
  }
  return fs.readFileSync(htmlPath, 'utf8');
}

async function seedUsers(html) {
  console.log('Seeding users...');
  const userRegex = /\{id:'([^']+)',fname:'([^']+)',lname:'([^']+)',email:'([^']+)',pw:'([^']+)',role:'([^']+)'(?:,commission:([^,}]+))?/g;
  let match, count = 0;
  while ((match = userRegex.exec(html)) !== null) {
    const [, id, fname, lname, email, pw, role, commission] = match;
    const existing = await getOne('SELECT id FROM users WHERE id=$1', [id]);
    if (!existing) {
      const hash = await bcrypt.hash(pw, 10);
      await query(
        'INSERT INTO users (id,fname,lname,email,pw_hash,role,commission) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
        [id, fname, lname, email.toLowerCase(), hash, role, parseFloat(commission)||5]
      );
      count++;
    }
  }
  console.log(`  Seeded ${count} users`);
}

async function seedProducts(html) {
  console.log('Seeding products...');
  const prodStart = html.indexOf('let PRODUCTS=[');
  const prodEnd = html.indexOf('\n];', prodStart) + 3;
  const prodBlock = html.slice(prodStart + 14, prodEnd - 3);
  const lines = prodBlock.split('\n').filter(l => l.trim().startsWith('{sku:'));
  let count = 0;
  for (const line of lines) {
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
      await query(`
        INSERT INTO products (sku,name,producer,cat,btl,stock,reorder,
          price_frontline,price_mix12,price_acs3,price_brand3,price_brand5,
          da_frontline,da_mix12,da_acs3,da_brand3,da_brand5,
          redemption_entry,active,core)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT (sku) DO UPDATE SET
          name=$2,stock=$6,price_frontline=$8,price_mix12=$9,
          price_acs3=$10,price_brand3=$11,price_brand5=$12,
          da_frontline=$13,da_mix12=$14,da_acs3=$15,da_brand3=$16,da_brand5=$17,
          redemption_entry=$18,active=$19,core=$20
      `, [sku,name,producer,cat,btl,stock,reorder,fl,m12,a3,b3,b5,daFl,daM12,daA3,daB3,daB5,redemption,active,core]);
