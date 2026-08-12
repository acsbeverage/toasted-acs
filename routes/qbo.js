const express = require('express');
const router = express.Router();
const { query, getOne } = require('../db');
const { requireAdmin } = require('../middleware/auth');

// ─── CONFIG ───────────────────────────────────────────────────────────────
// Set these on Render (Environment tab), never in code or in the browser:
//   QBO_CLIENT_ID       -- from your Intuit Developer app
//   QBO_CLIENT_SECRET   -- from your Intuit Developer app
//   QBO_REDIRECT_URI    -- e.g. https://toasted-acs.onrender.com/api/qbo/callback
//                          (must exactly match what's registered in the Intuit app's Redirect URIs)

const OAUTH_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const OAUTH_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

function apiBase(environment) {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

// ─── CONNECTION STORAGE (single row) ─────────────────────────────────────
async function getConnection() {
  return await getOne('SELECT * FROM qbo_connection WHERE id=1');
}
async function saveConnection(fields) {
  const existing = await getConnection();
  if (existing) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
    await query(`UPDATE qbo_connection SET ${sets}, updated_at=NOW() WHERE id=1`, keys.map(k => fields[k]));
  } else {
    const keys = ['id', ...Object.keys(fields)];
    const vals = [1, ...Object.values(fields)];
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    await query(`INSERT INTO qbo_connection (${keys.join(', ')}) VALUES (${placeholders})`, vals);
  }
}
async function clearConnection() {
  await query('DELETE FROM qbo_connection WHERE id=1');
}

// ─── TOKEN REFRESH ────────────────────────────────────────────────────────
async function ensureFreshToken() {
  const conn = await getConnection();
  if (!conn || !conn.access_token) throw new Error('Not connected to QuickBooks');

  const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 60000) return conn; // still valid for at least another minute

  // Refresh
  const basicAuth = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refresh_token }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Token refresh failed: ' + (data.error_description || data.error || res.status));

  const newExpiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
  const newRefreshExpiresAt = new Date(Date.now() + (data.x_refresh_token_expires_in || 8640000) * 1000);
  await saveConnection({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expires_at: newExpiresAt,
    refresh_token_expires_at: newRefreshExpiresAt,
  });
  return await getConnection();
}

// ─── AUTHENTICATED QBO API CALL ──────────────────────────────────────────
async function qboApi(method, path, body) {
  const conn = await ensureFreshToken();
  const url = `${apiBase(conn.environment)}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${conn.access_token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.Fault?.Error?.[0]?.Message || data.Fault?.Error?.[0]?.Detail || `QBO API error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}
async function qboQuery(realmId, sql) {
  const conn = await ensureFreshToken();
  return await qboApi('GET', `/v3/company/${conn.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=65`);
}

// ─── OAUTH: START ─────────────────────────────────────────────────────────
router.post('/auth-url', requireAdmin, async (req, res) => {
  try {
    if (!process.env.QBO_CLIENT_ID) return res.status(500).json({ ok: false, message: 'QBO_CLIENT_ID not configured on the server' });
    const environment = req.body.environment === 'production' ? 'production' : 'sandbox';
    const state = Buffer.from(JSON.stringify({ environment, t: Date.now() })).toString('base64url');
    const params = new URLSearchParams({
      client_id: process.env.QBO_CLIENT_ID,
      redirect_uri: process.env.QBO_REDIRECT_URI,
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      state,
    });
    res.json({ url: `${OAUTH_AUTHORIZE_URL}?${params.toString()}` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ─── OAUTH: CALLBACK (Intuit redirects the browser here directly) ────────
router.get('/callback', async (req, res) => {
  const respondToPopup = (success, payload) => {
    const msg = success
      ? { type: 'QBO_OAUTH_SUCCESS', companyName: payload.companyName, realmId: payload.realmId }
      : { type: 'QBO_OAUTH_ERROR', message: payload.message };
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <p>${success ? 'Connected! You can close this window.' : 'Connection failed: ' + payload.message}</p>
      <script>
        if (window.opener) { window.opener.postMessage(${JSON.stringify(msg)}, '*'); }
        setTimeout(() => window.close(), success ? 1200 : 4000);
      </script>
    </body></html>`);
  };

  try {
    const { code, realmId, state } = req.query;
    if (!code || !realmId) return respondToPopup(false, { message: 'Missing code or realmId from QuickBooks' });

    let environment = 'sandbox';
    try { environment = JSON.parse(Buffer.from(state, 'base64url').toString()).environment || 'sandbox'; } catch (e) {}

    const basicAuth = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.QBO_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) return respondToPopup(false, { message: tokenData.error_description || 'Token exchange failed' });

    const tokenExpiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
    const refreshExpiresAt = new Date(Date.now() + (tokenData.x_refresh_token_expires_in || 8640000) * 1000);

    await saveConnection({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      realm_id: realmId,
      environment,
      token_expires_at: tokenExpiresAt,
      refresh_token_expires_at: refreshExpiresAt,
      company_name: '',
    });

    // Fetch company name for display
    let companyName = '';
    try {
      const info = await qboApi('GET', `/v3/company/${realmId}/companyinfo/${realmId}?minorversion=65`);
      companyName = info.CompanyInfo?.CompanyName || '';
      await saveConnection({ company_name: companyName });
    } catch (e) { /* non-fatal -- connection still succeeds without a display name */ }

    respondToPopup(true, { companyName, realmId });
  } catch (err) {
    console.error('QBO callback error:', err.message);
    respondToPopup(false, { message: err.message });
  }
});

// ─── STATUS ───────────────────────────────────────────────────────────────
router.get('/status', requireAdmin, async (req, res) => {
  try {
    const conn = await getConnection();
    if (!conn || !conn.access_token) return res.json({ connected: false });
    res.json({ connected: true, companyName: conn.company_name || '', realmId: conn.realm_id, environment: conn.environment });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ─── DISCONNECT ───────────────────────────────────────────────────────────
router.post('/disconnect', requireAdmin, async (req, res) => {
  try {
    const conn = await getConnection();
    if (conn && conn.access_token) {
      try {
        const basicAuth = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
        await fetch(OAUTH_REVOKE_URL, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
          body: new URLSearchParams({ token: conn.refresh_token }),
        });
      } catch (e) { /* revoke best-effort -- still clear local connection either way */ }
    }
    await clearConnection();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ─── RESOLVE OR CREATE A CUSTOMER ────────────────────────────────────────
async function resolveCustomer(inv) {
  const safeName = inv.customerName.replace(/'/g, "\\'");
  const found = await qboQuery(null, `SELECT * FROM Customer WHERE DisplayName = '${safeName}'`);
  if (found.QueryResponse?.Customer?.length) return found.QueryResponse.Customer[0];

  const created = await qboApi('POST', `/v3/company/${(await getConnection()).realm_id}/customer?minorversion=65`, {
    DisplayName: inv.customerName,
    PrimaryEmailAddr: inv.customerEmail ? { Address: inv.customerEmail } : undefined,
  });
  return created.Customer;
}

// ─── RESOLVE OR CREATE AN ITEM (non-inventory, so this never fights with QBO's own stock tracking) ─
async function resolveItem(name) {
  const safeName = name.replace(/'/g, "\\'");
  const found = await qboQuery(null, `SELECT * FROM Item WHERE Name = '${safeName}'`);
  if (found.QueryResponse?.Item?.length) return found.QueryResponse.Item[0];

  const conn = await getConnection();
  // Every QBO company has an Income account -- find one to attach new items to
  const incomeAccts = await qboQuery(null, `SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1`);
  const incomeAcct = incomeAccts.QueryResponse?.Account?.[0];
  const created = await qboApi('POST', `/v3/company/${conn.realm_id}/item?minorversion=65`, {
    Name: name,
    Type: 'Service',
    IncomeAccountRef: incomeAcct ? { value: incomeAcct.Id } : undefined,
  });
  return created.Item;
}

// ─── CREATE INVOICE(S) ────────────────────────────────────────────────────
router.post('/invoices', requireAdmin, async (req, res) => {
  try {
    const invoices = req.body.invoices || [];
    if (!invoices.length) return res.status(400).json({ ok: false, message: 'No invoices provided' });
    const conn = await getConnection();
    const invoiceIds = [];

    for (const inv of invoices) {
      const customer = await resolveCustomer(inv);
      const lines = [];
      for (const line of inv.lines) {
        const item = await resolveItem(line.qboItemName || line.description);
        const rate = line.discountPct ? line.unitPrice * (1 - line.discountPct / 100) : line.unitPrice;
        lines.push({
          DetailType: 'SalesItemLineDetail',
          Amount: Math.round(rate * line.qty * 100) / 100,
          Description: line.description,
          SalesItemLineDetail: {
            ItemRef: { value: item.Id, name: item.Name },
            Qty: line.qty,
            UnitPrice: Math.round(rate * 10000) / 10000,
          },
        });
      }

      const payload = {
        CustomerRef: { value: customer.Id, name: customer.DisplayName },
        TxnDate: inv.invoiceDate,
        DueDate: inv.dueDate,
        DocNumber: inv.orderId,
        PrivateNote: inv.memo || '',
        CustomerMemo: inv.poNumber ? { value: 'PO #: ' + inv.poNumber } : undefined,
        Line: lines,
      };

      const result = await qboApi('POST', `/v3/company/${conn.realm_id}/invoice?minorversion=65`, payload);
      invoiceIds.push(result.Invoice?.Id);
    }

    res.json({ ok: true, invoiceIds });
  } catch (err) {
    console.error('QBO invoice creation error:', err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ─── FETCH PAYMENTS ────────────────────────────────────────────────────────
router.get('/payments', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const result = await qboQuery(null, `SELECT * FROM Payment WHERE TxnDate >= '${since}' MAXRESULTS 200`);
    res.json({ payments: result.QueryResponse?.Payment || [] });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ─── FETCH CUSTOMERS ────────────────────────────────────────────────────────
router.get('/customers', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const result = await qboQuery(null, `SELECT * FROM Customer WHERE Metadata.LastUpdatedTime >= '${since}' MAXRESULTS 200`);
    res.json({ customers: result.QueryResponse?.Customer || [] });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ─── FETCH ITEMS ────────────────────────────────────────────────────────────
router.get('/items', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const result = await qboQuery(null, `SELECT * FROM Item WHERE Metadata.LastUpdatedTime >= '${since}' MAXRESULTS 200`);
    res.json({ items: result.QueryResponse?.Item || [] });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ─── FETCH CONFIG (payment methods, terms, classes, departments) ──────────
router.get('/config', requireAdmin, async (req, res) => {
  try {
    const entityMap = { 'payment-methods': 'PaymentMethod', 'terms': 'Term', 'classes': 'Class', 'departments': 'Department' };
    const entity = entityMap[req.query.type];
    if (!entity) return res.status(400).json({ ok: false, message: 'Unknown config type' });
    const result = await qboQuery(null, `SELECT * FROM ${entity} MAXRESULTS 200`);
    res.json({ items: result.QueryResponse?.[entity] || [] });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ─── SYNC ONE ACCOUNT TO QUICKBOOKS AS A CUSTOMER ─────────────────────────
router.post('/customers/sync', requireAdmin, async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ ok: false, message: 'accountId required' });

    const acct = await getOne('SELECT * FROM accounts WHERE id=$1', [accountId]);
    if (!acct) return res.status(404).json({ ok: false, message: 'Account not found in Toasted' });

    const conn = await getConnection();
    if (!conn || !conn.access_token) return res.status(400).json({ ok: false, message: 'Not connected to QuickBooks' });

    const addr = (acct.ship_street || acct.ship_city) ? {
      Line1: acct.ship_street || '',
      City: acct.ship_city || '',
      CountrySubDivisionCode: acct.ship_state || '',
      PostalCode: acct.ship_zip || '',
    } : undefined;

    let qboCustomer;

    if (acct.qbo_id) {
      // Already linked -- fetch current SyncToken (required by QBO for any update) and push changes
      const current = await qboApi('GET', `/v3/company/${conn.realm_id}/customer/${acct.qbo_id}?minorversion=65`);
      const result = await qboApi('POST', `/v3/company/${conn.realm_id}/customer?minorversion=65`, {
        Id: current.Customer.Id,
        SyncToken: current.Customer.SyncToken,
        sparse: true,
        DisplayName: acct.name,
        PrimaryEmailAddr: acct.email ? { Address: acct.email } : undefined,
        PrimaryPhone: acct.phone ? { FreeFormNumber: acct.phone } : undefined,
        BillAddr: addr,
      });
      qboCustomer = result.Customer;
    } else {
      // Not linked yet -- check QBO for an existing customer with this exact name first, to avoid creating a duplicate
      const safeName = acct.name.replace(/'/g, "\\'");
      const found = await qboQuery(null, `SELECT * FROM Customer WHERE DisplayName = '${safeName}'`);
      if (found.QueryResponse?.Customer?.length) {
        qboCustomer = found.QueryResponse.Customer[0];
      } else {
        const created = await qboApi('POST', `/v3/company/${conn.realm_id}/customer?minorversion=65`, {
          DisplayName: acct.name,
          PrimaryEmailAddr: acct.email ? { Address: acct.email } : undefined,
          PrimaryPhone: acct.phone ? { FreeFormNumber: acct.phone } : undefined,
          BillAddr: addr,
        });
        qboCustomer = created.Customer;
      }
    }

    await query('UPDATE accounts SET qbo_id=$1 WHERE id=$2', [qboCustomer.Id, accountId]);
    res.json({ ok: true, qboId: qboCustomer.Id, displayName: qboCustomer.DisplayName });
  } catch (err) {
    console.error('QBO customer sync error:', err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
});

module.exports = router;
