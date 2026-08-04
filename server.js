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



app.get('/api/set-fintech', async (req, res) => {
  if(req.query.secret !== 'toasted2026') return res.status(403).json({ok:false});
  const {query} = require('./db');
  const ids = ["289944","273501","242568","359204","415090","271882","265641","278400","321380","277489","369476","418233","277672","430679","430665","415117","239018","396155","445281","238996","418796","320398","463649","415161","313326","444681","303943","430421","239046","477316","387676","303720","418224","476537","321333","305476","308600","248627","465982","300928","321368","369722","242566","353625","273616","363475","292324","460527","329358","329068","385262","403319","258419","415156","368108","396964","331020","278401","415172","252952","415187","327858","412028","357638","358266","415116","239040","415171","272545","299332","365584","418238","321376","379513","417697","460509","387549","465173","277472","321375","415194","277696","316237","418240","257433","321109","415189","415101","277667","316239","415190","321331","491292","334556","418225","397663","277707","321381","415102","277662","321370","420341","286876","415152","239024","307106","400901","307689","415134","239035","412073","377254","367274","402881","417703","239900","381815","321372","317622","325964","415143","240798","305475","418227","415105","277464","311896","239030","469077","359203","404256","259245","356828","328265","301132","477150","327076","415405","417453","406884","286882","418235","417711","455378","327602","450009","412876","420342","462691","417048","289478","415109","277705","412099","415170","415097","370531","308161","415181","446957","365295","415165","418972","417710","277471","418966","396952","463825","417035","447616","301468","468869","308604","415163","277487","415137","312251","277666","425997","480468","444519","305474","277481","418364","303924","415130","277669","357037","460522","329000","299631","353663","460701","417948","321330","417668","477918","358041","415111","277658","277467","477917","310925","417696","414035","303929","460534","320123","415286","303939","415123","277664","415179","385163","239074","449999","239089","415192","305470","415158","421057","277703","303937","321366","277700","259786","474035","428509","372755","401718","450000","415113","303947","384632","450002","410374","403912","321367","410637","303932","466620","249584","415107","321369","365339","379597","252738","328595","303933","404260","415124","417076","420001","463624","329061","415099","330619","415162","316232","415164","292707","418230","378442","239068","373367","415128","286870","286880","358952","258151","415155","418232","278402","460194","331086","356804","400871","357105","359205","415157","277480","480184","286597","412069","277701","430461","459987","415195","410020","410077","264302","387807","415153","364594","335464","450004","363563","408796","353623","415095","331940","247550","391539","410018","259082","329268","330658","330657","259611","381766","300936","384956","329108","328455","239070","239072","450042","415173","256767","395977","275607","372359","378568","324090","406883","368284","463376","418236","356685","444292","404552","278404","291995","328452","326527","406129","415188","449997","239499","413041","327527","366279","302136","491291","412647","418241","389682","444536","335865","469349","239015","389454","353662","415166","277698","405030","278403","418222","277709","291824","415176","459625","469350","277477","292323","469080","273938","328380","418237","415151","316472","239061","432832","420146","461316","419910","430460","415121","277660","246835","255820","286878","391885","316236","417701","286877","239014","418780","418779","462339","247430","321373","277478","415169","418226","308633","304554","320489","404545","317863","329329","277710","450005","264544","265181","335819","316233","286874","415127","277476","329932","305575","239027","415091","247587","293182","409145","329065","305352","271691","387854","465978","239085","328084","388437","321379","415108","387165","415104","446512","387341","450007","286875","303936","316234","395528","357806","418234","293301","415149","407395","334145","256079","415256","239084","415125","449994","415184","333983","415180","282779","395683","417702","272344","389990","258860","239071","415136","330250","310786","430662","335521","365749","311895","365583","415100","384883","358794","293176","428719","450014","275952","461315","259727","417047","277486","390164","276923","305471","391273","415126","462256","408686","418221","396462","412922","277708","415182","415433","480178","415122","321329","475070","491294","356816","358267","415110","277699","277465","277493","318480","389671","298031","460512","417704","255469","411287","417709","409341","478213","468865","277661","415167","415120","277466","321377","491293","240783","412822","417707","487991","366128","326791","328665","406885","365936","387547","247093","405116","291612","406886","325759","277490","402618","358639","328382","480214","490150","256339","412095","412841","277488","462354","415096","469097","468636","468867","415139","468866","363488","480410","415159","277491","303945","415150","466021","403304","368468","461393","469188","291526","259787","260139","261144","246900","285826","402578","327078","364625","420010","420009","419913","417698","415112","239019","316228","328778","274201","420000","240914","420002","415178","272156","465354","259369","380688","256634","321374","294721","256661","257346","321365","418239","415098","257497","415148","279609","328486","407394","304695","278458","277479","444854","250909","364806","239134","364662","240995","466273","276319","415145","264300","334559","239016","381773","446018","402785","364572","364947","301102","415106","239011","463484","306211","239467","325131","415089","356902","239470","254433","239073","325180","329436","334248","445404","446939","277482","310283","446354","466621","370913","415092","446918","306365","403416","277704","308411","309891","415160","239022","415141","325275","461374","415185","277695","303948","359385","277470","308603","277553","417700","321332","415146","305472","316556","415103","353635","308602","411751","415088","444175","328232","415186","329933","239228","277474","297750","326523","321334","324981","290838","415177","292709","277473","463798","461372","321378","324472","417699","369313","316240","277483","409366","239067","330410","415197","305473","408954","415175","306368","328453","450011","239508","415094","367276","461314","277469","367275","415193","267422","414529","404328","450040","450036","450038","303935","257387","463569","415133","286871","394270","415147","459629","327019","418223","371305","277484","277492","252951","444477","277657","257520","358160","420050","415135","468264","414472","468253","413427","429990","429984","308599","450091","277468","415401","413437","415370","413433","415174","308631","277485","325268","415142","255573","415138","450006","415115","319619","417708","415132","415168","303926","330635","415196","277659","239049","412826","447604","412831","305935","462688","415154","277670","462254","466241","430418","316235","316231","450003","277706","450041","417705","417706","257997","240943","277663","420260","415140","462471","415119","328532","465980","277475","418804","255580","415114","303928","299569","324785","304659","353650","397083","415183","255883","286881","415191","277697","418219","461514","359202","465790","359391","312743","431005","463918","415087","415144","334488","466388","418220","415118","450001","320400","247859","316241","413316","319620","418231","367277","328780","277694","333583","316238","321371","249182","333491","417039"];
  let updated = 0, skipped = 0;
  for(const id of ids){
    try{
      const r = await query('UPDATE accounts SET payment_provider=$1 WHERE id=$2', ['Fintech', id]);
      if(r.rowCount > 0) updated++;
      else skipped++;
    }catch(e){skipped++;}
  }
  res.json({ok:true, updated, skipped, total:ids.length});
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
