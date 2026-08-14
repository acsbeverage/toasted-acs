const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { query, getOne, getAll } = require('../db');

// Loads the bundle once per request -- fine at this scale, and keeps memory usage predictable
// rather than holding a 5.5MB structure in memory permanently between requests.
function loadBundle() {
  const filePath = path.join(__dirname, '..', 'db', 'historical-orders-import.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

router.get('/import-historical-orders', async (req, res) => {
  if (req.query.secret !== 'toasted2026-histimport') return res.status(403).json({ ok: false });
  const execute = req.query.execute === 'true';

  try {
    const bundle = loadBundle();
    const { orders, newProducts, newAccounts } = bundle;

    // -- Build lookup maps from live data --
    const liveAccounts = await getAll('SELECT id, name FROM accounts');
    const liveProducts = await getAll('SELECT sku FROM products');
    const liveUsers = await getAll("SELECT id, fname, lname, role FROM users WHERE role IN ('admin','rep')");
    const adminUser = liveUsers.find(u => u.role === 'admin');

    const accountIdByName = {};
    liveAccounts.forEach(a => { accountIdByName[a.name.trim().toLowerCase()] = a.id; });
    const liveSkuSet = new Set(liveProducts.map(p => String(p.sku).trim()));
    const repIdByName = {};
    liveUsers.forEach(u => { repIdByName[(u.fname + ' ' + (u.lname || '')).trim().toLowerCase().replace(/\s+/g, ' ')] = u.id; });

    if (!execute) {
      // -- DRY RUN: report what would happen, touch nothing --
      let resolvedRep = 0, adminRep = 0, unassignedRep = 0;
      orders.forEach(o => {
        if (o.rep === 'ADMIN') adminRep++;
        else if (o.rep === null) unassignedRep++;
        else if (repIdByName[o.rep.toLowerCase().replace(/\s+/g, ' ')]) resolvedRep++;
        else unassignedRep++; // rep name present but doesn't match a live user -- falls back to unassigned
      });
      const existingOrderCount = (await getOne('SELECT COUNT(*) as cnt FROM orders')).cnt;
      return res.json({
        ok: true, dryRun: true,
        existingOrdersWillBeDeleted: parseInt(existingOrderCount),
        ordersToImport: orders.length,
        lineItemsToImport: orders.reduce((s, o) => s + o.items.length, 0),
        newAccountsToCreate: newAccounts.length,
        newProductsToCreate: newProducts.length,
        repAttribution: { resolvedToExistingRep: resolvedRep, mappedToAdmin: adminRep, leftUnassigned: unassignedRep },
        adminUserFound: !!adminUser,
        note: 'Nothing has been changed. Re-run with &execute=true to actually perform this import.',
      });
    }

    // -- EXECUTE: actually perform the import --
    if (!adminUser) throw new Error('No admin user found -- cannot map placeholder reps');

    // 1. Wipe existing orders (order_items cascades automatically)
    const deletedCount = (await getOne('SELECT COUNT(*) as cnt FROM orders')).cnt;
    await query('DELETE FROM orders');

    // 2. Create missing accounts
    let accountsCreated = 0;
    for (const a of newAccounts) {
      if (accountIdByName[a.name.trim().toLowerCase()]) continue; // already exists somehow
      const id = 'a' + Date.now() + Math.floor(Math.random() * 1000);
      const seqRow = await getOne('UPDATE account_code_sequence SET next_seq = next_seq + 1 WHERE id=1 RETURNING next_seq - 1 as claimed');
      const code = String(seqRow.claimed);
      await query(
        `INSERT INTO accounts (id,name,code,ship_street,ship_street2,ship_city,ship_state,ship_zip,region,account_type,corp_group,terms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Net 30')`,
        [id, a.name, code, a.shipStreet || '', a.shipStreet2 || '', a.shipCity || '', a.shipState || '', a.shipZip || '', a.region || '', a.accountType || '', a.corpGroup || '']
      );
      accountIdByName[a.name.trim().toLowerCase()] = id;
      accountsCreated++;
    }

    // 3. Create missing products (inactive/discontinued)
    let productsCreated = 0;
    for (const p of newProducts) {
      if (liveSkuSet.has(p.sku)) continue;
      await query(
        `INSERT INTO products (sku,name,producer,cat,btl,stock,reorder,active)
         VALUES ($1,$2,$3,'Spirits',$4,0,0,'No') ON CONFLICT (sku) DO NOTHING`,
        [p.sku, p.name, p.producer || '', p.btl || 12]
      );
      liveSkuSet.add(p.sku);
      productsCreated++;
    }

    // 4. Import orders + line items in batches
    let ordersImported = 0, itemsImported = 0, ordersSkipped = 0;
    const skippedOrders = [];

    for (const o of orders) {
      const acctId = accountIdByName[String(o.acct).trim().toLowerCase()];
      if (!acctId) { ordersSkipped++; skippedOrders.push(o.id); continue; }

      let repId = null;
      if (o.rep === 'ADMIN') repId = adminUser.id;
      else if (o.rep) repId = repIdByName[o.rep.toLowerCase().replace(/\s+/g, ' ')] || null;

      await query(
        `INSERT INTO orders (id,acct_id,rep_id,date,delivery,status,paid,paid_date,is_sample)
         VALUES ($1,$2,$3,$4,$5,'delivered',$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [o.id, acctId, repId, o.date, o.date, !!o.paid, o.paidDate || null, !!o.isSample]
      );

      let sortOrder = 0;
      for (const item of o.items) {
        if (item.isFee) {
          await query(
            `INSERT INTO order_items (order_id,sku,cases,bottles,is_fee,fee_amt,fee_count,is_manual,sort_order)
             VALUES ($1,$2,0,0,TRUE,$3,$4,TRUE,$5)`,
            [o.id, item.internalSku, item.feeAmt, item.feeCount, sortOrder++]
          );
        } else {
          await query(
            `INSERT INTO order_items (order_id,sku,cases,bottles,tier,rate,is_manual,sort_order)
             VALUES ($1,$2,0,$3,$4,$5,TRUE,$6)`,
            [o.id, item.sku, item.bottles, item.tier || 'Historical', item.rate, sortOrder++]
          );
        }
        itemsImported++;
      }
      ordersImported++;
    }

    res.json({
      ok: true, executed: true,
      existingOrdersDeleted: parseInt(deletedCount),
      accountsCreated, productsCreated,
      ordersImported, itemsImported, ordersSkipped,
      skippedOrderSample: skippedOrders.slice(0, 20),
    });
  } catch (err) {
    console.error('Historical order import error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
