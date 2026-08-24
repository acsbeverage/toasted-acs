const router = require('express').Router();
const ExcelJS = require('exceljs');
const sgMail = require('@sendgrid/mail');
const { query, getOne, getAll } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const FROM_EMAIL = process.env.FROM_EMAIL || 'accounting@acsbeverage.com';
const FROM_NAME = process.env.FROM_NAME || 'Toasted -- ACS Beverage Co.';

// ─── DATE RANGE HELPERS ───────────────────────────────────────────────────
// Render's servers run in UTC, but the business operates in Pacific time -- all scheduling
// day/time math needs to happen in Pacific time, not the server's raw UTC clock. Otherwise a
// schedule due at, say, 6pm Pacific already looks like the next calendar day from the
// server's UTC perspective (UTC is 7-8 hours ahead), causing it to fire a day early.
function nowPacific() {
  const pacificStr = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  return new Date(pacificStr);
}
function dateOnlyStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayStr() { return dateOnlyStr(nowPacific()); }
function plusDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function resolveDateRange(sched) {
  if (sched.dateRange === 'custom') return { from: sched.customFrom, to: sched.customTo };
  const today = todayStr();
  switch (sched.dateRange) {
    case 'rolling7': return { from: plusDays(today, -7), to: today };
    case 'rolling30': return { from: plusDays(today, -30), to: today };
    case 'mtd': return { from: today.slice(0, 8) + '01', to: today };
    case 'lastMonth': {
      const d = new Date(today); d.setDate(1); d.setDate(d.getDate() - 1);
      const lastMonthEnd = d.toISOString().slice(0, 10);
      const lastMonthStart = lastMonthEnd.slice(0, 8) + '01';
      return { from: lastMonthStart, to: lastMonthEnd };
    }
    case 'ytd': return { from: today.slice(0, 4) + '-01-01', to: today };
    case 'all': return { from: null, to: null };
    default: return { from: plusDays(today, -30), to: today };
  }
}
// Next send date matching the schedule's frequency/day settings, computed in Pacific time.
// When afterSend is true (called right after a successful send), the result is guaranteed to
// be strictly after today -- never today again -- regardless of how the exact configured
// send time compares to the actual moment we sent at. This is what actually stops a schedule
// from re-firing on every subsequent hourly check: previously, if the real send happened
// earlier in the day than the configured time (which the timezone bug above caused), the
// plain "next <= now" comparison could fail to advance to the following week at all.
function calcNextSend(freq, dayOfWeek, dayOfMonth, time, afterSend) {
  const now = nowPacific();
  const [hh, mm] = (time || '08:00').split(':').map(Number);
  let next = new Date(now);
  if (freq === 'monthly') {
    next.setDate(dayOfMonth || 1);
    next.setHours(hh || 8, mm || 0, 0, 0);
    const landsToday = afterSend && dateOnlyStr(next) === dateOnlyStr(now);
    if (next <= now || landsToday) next.setMonth(next.getMonth() + 1);
  } else {
    const targetDow = dayOfWeek ?? 1;
    next.setHours(hh || 8, mm || 0, 0, 0);
    let daysUntil = (targetDow - next.getDay() + 7) % 7;
    if (daysUntil === 0 && (next <= now || afterSend)) daysUntil = freq === 'biweekly' ? 14 : 7;
    next.setDate(next.getDate() + daysUntil);
  }
  return dateOnlyStr(next);
}

// ─── REPORT DATA GENERATION (server-side, direct from the database) ──────
// Each of these returns { headers: [...], rows: [[...], ...] } ready for the Excel writer.
// Standard pricing tier display names -- account-specific custom pricing lanes use their own
// tier name directly (falls through to the raw value), matching how the frontend does this.
const TIER_LABELS = {
  frontline: 'Frontline', mix12: '12 Btl Mix', acs3: '3 Case ACS',
  brand3: '3 Case Brand Family', brand5: '5 Case Brand Family',
};

async function buildRA5(from, to, producers, producerLabel) {
  // One row per order line item, matching the real RA5 export -- not an aggregated summary.
  const rows = await getAll(
    `SELECT p.name as wine_name, p.sku as wine_code, p.vintage, p.producer, p.cat, p.btl, p.bottle_size,
            p.fob_price, p.comm_frontline,
            p.da_frontline, p.da_mix12, p.da_acs3, p.da_brand3, p.da_brand5,
            a.name as account_name, a.lic as abc_number, a.ship_street, a.ship_city, a.ship_state, a.ship_zip, a.id as account_id,
            u.fname as rep_fname, u.lname as rep_lname,
            o.id as invoice_number, o.po as po_number, o.date, o.is_sample, o.notes as order_notes,
            oi.cases, oi.bottles, oi.rate, oi.tier, oi.notes as line_notes, oi.discount_pct,
            (SELECT ptp.da_amount FROM product_tier_prices ptp
             WHERE ptp.sku = oi.sku AND ptp.tier_name = oi.tier
               AND (ptp.account_id = o.acct_id OR ptp.account_id IS NULL)
             ORDER BY ptp.account_id NULLS LAST LIMIT 1) as custom_da
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     JOIN products p ON oi.sku = p.sku
     LEFT JOIN accounts a ON o.acct_id = a.id
     LEFT JOIN users u ON o.rep_id = u.id
     WHERE o.status='delivered' AND oi.is_fee=FALSE
       AND ($1::date IS NULL OR o.date >= $1) AND ($2::date IS NULL OR o.date <= $2)
       AND ($3::text[] IS NULL OR p.producer = ANY($3))
     ORDER BY p.name, o.date`,
    [from || null, to || null, (producers && producers.length) ? producers : null]
  );

  const STANDARD_DA_COL = {
    frontline: 'da_frontline', mix12: 'da_mix12', acs3: 'da_acs3',
    brand3: 'da_brand3', brand5: 'da_brand5',
  };
  const headers = [
    'Wine Name', 'Wine Code', 'Vintage', producerLabel || 'Producer', 'Account', 'Sales Rep', 'Date',
    'Quantity', 'Unit Price', 'Total', 'Notes', 'Invoice Number', 'PO Number',
    'Warehouse', 'Sample Order', 'Bill Back Amount', 'Bill Back Total',
    'Price Label', 'ABC Number',
    'Shipping Street', 'Shipping City', 'Shipping State', 'Shipping Zip Code',
    'FOB Price', 'Account ID', 'Bottle Size', 'Pack Size', 'Wine Category',
  ];
  const out = rows.map(r => {
    const qty = (r.cases || 0) + (r.bottles || 0) / (r.btl || 1); // case-equivalent, matching the fractional format the real report uses
    const unitPrice = parseFloat(r.rate || 0) * (r.btl || 1); // per-case price
    const total = qty * unitPrice;
    const priceLabel = TIER_LABELS[r.tier] || r.tier || '';
    // DA (Bill Back): prefer a matching custom pricing lane's rate, otherwise fall back to
    // the standard per-tier DA column on the product itself.
    const daPerBottle = r.custom_da !== null && r.custom_da !== undefined
      ? parseFloat(r.custom_da)
      : parseFloat(r[STANDARD_DA_COL[r.tier]] || 0);
    const billBackAmount = daPerBottle * (r.btl || 1); // per case, matching Unit Price's convention
    const billBackTotal = billBackAmount * qty;
    return [
      r.wine_name, r.wine_code, r.vintage || '', r.producer,
      r.account_name || '', r.rep_fname ? (r.rep_fname + ' ' + (r.rep_lname || '')) : '',
      r.date ? r.date.toISOString().slice(0, 10) : '',
      Number(qty.toFixed(4)), Number(unitPrice.toFixed(2)), Number(total.toFixed(2)),
      r.line_notes || r.order_notes || '', r.invoice_number, r.po_number || '',
      'ACS Warehouse', r.is_sample ? 'Yes' : 'No',
      Number(billBackAmount.toFixed(2)), Number(billBackTotal.toFixed(2)),
      priceLabel, r.abc_number || '',
      r.ship_street || '', r.ship_city || '', r.ship_state || '', r.ship_zip || '',
      parseFloat(r.fob_price || 0), r.account_id || '', r.bottle_size || '', r.btl, r.cat || '',
    ];
  });
  return { headers, rows: out };
}

async function buildRBInventory(sched) {
  const producers = sched.producers || [];
  const rows = await getAll(
    `SELECT sku, name, vintage, cat, producer, stock
     FROM products
     WHERE COALESCE(warehouse,'main')<>'acs_logistics'
       AND ($1::text[] IS NULL OR producer = ANY($1))
     ORDER BY producer, name`,
    [producers.length ? producers : null]
  );
  const invHeaders = [
    'Code', 'Name', 'Vintage', 'Product Type', 'Producer', 'Warehouse', 'BIN location',
    'On Hand', 'On Hold', 'On Future', 'Pending Sync', 'Available', 'On Order', 'On Transfer',
  ];
  const invRows = rows.map(p => {
    const onHand = Number(parseFloat(p.stock).toFixed(2));
    return [
      p.sku, p.name, p.vintage || '', p.cat || '', p.producer, 'ACS Warehouse', '',
      onHand, 0, 0, 0, onHand, 0, 0, // Toasted has no hold/future/pending-sync/on-order/transfer tracking -- always 0
    ];
  });

  const reportName = sched.type === 'RB1' ? 'InventoryBySupplier' : 'InventoryByProducer';
  const filterRows = [
    ['Producers', producers.length ? producers.join(', ') : 'All'],
    ['Warehouses', 'ACS Warehouse'],
    ['Wine Status', 'All Wines'],
    ['Include active prices?', 'No'],
    ['Include "Delivery Fee" and "Duty" columns?', 'No'],
    ['Include non-inventory items?', 'No'],
    ['Include pre-sale allocations?', 'No'],
    ['Use simplified version?', 'No'],
    ['Include disabled warehouses?', 'No'],
    ['Report At', new Date().toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })],
    ['Report Name', reportName],
    ['Organization', 'ACS Beverage Co.'],
  ];

  return {
    sheets: [
      { name: 'Inventory', headers: invHeaders, rows: invRows },
      { name: 'Filters', headers: ['Filters', ''], rows: filterRows },
    ],
    rows: invRows, // kept for the row-count shown in the confirmation email
  };
}

async function buildReportData(sched) {
  if (sched.type === 'RA5' || sched.type === 'RA6') {
    const { from, to } = resolveDateRange(sched);
    const label = sched.type === 'RA6' ? 'Supplier' : 'Producer';
    return buildRA5(from, to, sched.producers || [], label);
  }
  // RB1/RB2 are current-state snapshots -- no date range to resolve, run fresh every time
  if (sched.type === 'RB1' || sched.type === 'RB2') return buildRBInventory(sched);
  return null; // Not yet supported for automated sending
}

// ─── EXCEL GENERATION ──────────────────────────────────────────────────────
async function buildExcelBuffer(reportName, data) {
  const wb = new ExcelJS.Workbook();
  const sheets = data.sheets || [{ name: reportName.slice(0, 31), headers: data.headers, rows: data.rows }];
  sheets.forEach(sheet => {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31)); // Excel sheet name limit
    ws.addRow(sheet.headers).font = { bold: true };
    sheet.rows.forEach(r => ws.addRow(r));
    ws.columns.forEach(col => { col.width = 18; });
  });
  return wb.xlsx.writeBuffer();
}

// ─── SEND (used by both "Send now" and the automated scheduler) ──────────
async function sendScheduleNow(sched) {
  const data = await buildReportData(sched);
  if (!data) return { ok: false, error: `Automatic sending isn't set up yet for ${sched.type}` };
  if (!data.rows.length) return { ok: false, error: 'No data found for the selected range/producers' };
  if (!sched.recipients || !sched.recipients.length) return { ok: false, error: 'No recipients configured' };

  const typeLabel = { RA5: 'Depletion by Producer', RA6: 'Depletion by Supplier', RB1: 'Inventory by Supplier', RB2: 'Inventory by Producer' };
  const reportName = typeLabel[sched.type] || sched.type;
  const buffer = await buildExcelBuffer(reportName, data);
  const base64 = buffer.toString('base64');
  const filename = `${sched.type}_${todayStr()}.xlsx`;

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const to = sched.recipients.map(r => r.email).filter(Boolean);
  await sgMail.send({
    to, from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: `${reportName} -- ${todayStr()} -- ACS Beverage Co.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px">
      <p>Hi,</p>
      <p>Please find the attached ${reportName} report, generated ${todayStr()}.</p>
      <p>${data.rows.length} row${data.rows.length !== 1 ? 's' : ''} included.</p>
      <p style="margin-top:20px;color:#888;font-size:12px">This report was sent automatically by Toasted.</p>
    </div>`,
    attachments: [{
      content: base64,
      filename,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment',
    }],
  });

  return { ok: true, recipientCount: to.length, rowCount: data.rows.length };
}

// ─── CRUD ROUTES ────────────────────────────────────────────────────────
function mapRow(r) {
  return {
    id: r.id, name: r.name, type: r.type,
    dateRange: r.date_range, customFrom: r.custom_from, customTo: r.custom_to,
    freq: r.freq, dayOfWeek: r.day_of_week, dayOfMonth: r.day_of_month, time: r.send_time,
    recipients: r.recipients || [], producers: r.producers || [],
    active: r.active, lastSent: r.last_sent, nextSend: r.next_send,
  };
}

router.get('/', requireAdmin, async (req, res) => {
  try {
    const rows = await getAll('SELECT * FROM report_schedules ORDER BY created_at DESC');
    res.json({ ok: true, schedules: rows.map(mapRow) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const s = req.body;
    const id = s.id || 'sch_' + Date.now();
    const nextSend = calcNextSend(s.freq, s.dayOfWeek, s.dayOfMonth, s.time);
    await query(
      `INSERT INTO report_schedules (id,name,type,date_range,custom_from,custom_to,freq,day_of_week,day_of_month,send_time,recipients,producers,active,last_sent,next_send)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         name=$2,type=$3,date_range=$4,custom_from=$5,custom_to=$6,freq=$7,day_of_week=$8,
         day_of_month=$9,send_time=$10,recipients=$11,producers=$12,active=$13,next_send=$15`,
      [id, s.name, s.type, s.dateRange || 'rolling30', s.customFrom || null, s.customTo || null,
       s.freq || 'weekly', s.dayOfWeek ?? 1, s.dayOfMonth ?? 1, s.time || '08:00',
       JSON.stringify(s.recipients || []), JSON.stringify(s.producers || []),
       s.active !== false, s.lastSent || null, nextSend]
    );
    res.json({ ok: true, id, nextSend });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { active } = req.body;
    const sched = await getOne('SELECT * FROM report_schedules WHERE id=$1', [req.params.id]);
    if (!sched) return res.status(404).json({ ok: false, error: 'Schedule not found' });
    const newActive = active !== undefined ? active : sched.active;
    const nextSend = newActive ? calcNextSend(sched.freq, sched.day_of_week, sched.day_of_month, sched.send_time) : sched.next_send;
    await query('UPDATE report_schedules SET active=$1, next_send=$2 WHERE id=$3', [newActive, nextSend, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM report_schedules WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manual "Send now" -- generates and actually emails the report immediately, with the real
// .xlsx attached, using the exact same logic the automated scheduler uses.
router.post('/:id/run', requireAdmin, async (req, res) => {
  try {
    const row = await getOne('SELECT * FROM report_schedules WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Schedule not found' });
    const sched = mapRow(row);
    const result = await sendScheduleNow(sched);
    if (!result.ok) return res.status(400).json(result);
    const nextSend = calcNextSend(sched.freq, sched.dayOfWeek, sched.dayOfMonth, sched.time, true);
    await query('UPDATE report_schedules SET last_sent=$1, next_send=$2 WHERE id=$3', [todayStr(), nextSend, req.params.id]);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Send report schedule error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── AUTOMATED SCHEDULER (called periodically by node-cron in server.js) ─
async function runDueSchedules() {
  try {
    const due = await getAll(
      `SELECT * FROM report_schedules WHERE active=TRUE AND next_send <= $1`,
      [todayStr()]
    );
    const nowHour = nowPacific().getHours();
    for (const row of due) {
      const sched = mapRow(row);
      // next_send is date-only, so a schedule due today would otherwise fire at whatever
      // hour first happens to catch it after midnight, not the hour the user configured.
      // Only send once we've actually reached that hour.
      const [schedHour] = (sched.time || '08:00').split(':').map(Number);
      if (nowHour < schedHour) continue;
      try {
        const result = await sendScheduleNow(sched);
        const nextSend = calcNextSend(sched.freq, sched.dayOfWeek, sched.dayOfMonth, sched.time, true);
        if (result.ok) {
          await query('UPDATE report_schedules SET last_sent=$1, next_send=$2 WHERE id=$3', [todayStr(), nextSend, sched.id]);
          console.log(`Scheduled report sent: ${sched.name} (${sched.type}) -- ${result.recipientCount} recipient(s)`);
        } else {
          // Push next_send forward anyway so a persistently-failing schedule (e.g. no data
          // this period) doesn't retry every single cron tick until someone notices.
          await query('UPDATE report_schedules SET next_send=$1 WHERE id=$2', [nextSend, sched.id]);
          console.error(`Scheduled report skipped: ${sched.name} (${sched.type}) -- ${result.error}`);
        }
      } catch (err) {
        console.error(`Scheduled report failed: ${sched.name} (${sched.type}) --`, err.message);
      }
    }
  } catch (err) {
    console.error('runDueSchedules error:', err.message);
  }
}

module.exports = { router, runDueSchedules };
