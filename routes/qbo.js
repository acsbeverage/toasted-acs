const express = require('express');
const router = express.Router();
const { query, getOne } = require('../db');
const { requireAdmin } = require('../middleware/auth');

// ─── CONFIG ───────────────────────────────────────────────────────────────
// Set these on Render (Environment tab), never in code or in the browser.
// Intuit issues SEPARATE, non-interchangeable Client ID/Secret pairs for Sandbox vs
// Production (two different tabs on the app's "Keys & OAuth" page in the developer portal) --
// using Sandbox credentials against the Production API (or vice versa) is rejected with 403.
//   QBO_CLIENT_ID_SANDBOX / QBO_CLIENT_SECRET_SANDBOX       -- from the app's Development keys
//   QBO_CLIENT_ID_PRODUCTION / QBO_CLIENT_SECRET_PRODUCTION -- from the app's Production keys
//   QBO_CLIENT_ID / QBO_CLIENT_SECRET -- fallback used for either environment if the
//                                        environment-specific vars above aren't set
//
// Intuit also requires each redirect URI to be globally unique across the whole app -- the
// same exact URI can't be registered under both the Sandbox and Production tabs. So Sandbox
// and Production each need their own callback path registered in the Intuit app's Redirect
// URIs (this file exposes both /api/qbo/callback and /api/qbo/callback-production):
//   QBO_REDIRECT_URI_SANDBOX    -- e.g. https://toasted-acs.onrender.com/api/qbo/callback
//   QBO_REDIRECT_URI_PRODUCTION -- e.g. https://toasted-acs.onrender.com/api/qbo/callback-production
//   QBO_REDIRECT_URI -- fallback used for either environment if the ones above aren't set

const OAUTH_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const OAUTH_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

function apiBase(environment) {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}
function clientCreds(environment) {
  const suffix = environment === 'production' ? 'PRODUCTION' : 'SANDBOX';
  return {
    id: process.env[`QBO_CLIENT_ID_${suffix}`] || process.env.QBO_CLIENT_ID,
    secret: process.env[`QBO_CLIENT_SECRET_${suffix}`] || process.env.QBO_CLIENT_SECRET,
  };
}
function redirectUri(environment) {
  // Intuit requires each redirect URI to be globally unique across the whole app -- the same
  // exact URI can't be registered under both the Sandbox and Production tabs. Falls back to a
  // single shared QBO_REDIRECT_URI if the environment-specific one isn't set.
  const suffix = environment === 'production' ? 'PRODUCTION' : 'SANDBOX';
  return process.env[`QBO_REDIRECT_URI_${suffix}`] || process.env.QBO_REDIRECT_URI;
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
  const creds = clientCreds(conn.environment);
  const basicAuth = Buffer.from(`${creds.id}:${creds.secret}`).toString('base64');
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
const RETRYABLE_STATUSES = [502, 503, 504]; // transient upstream/gateway issues, not real errors
async function qboApi(method, path, body, attempt = 1) {
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
  const rawText = await res.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch (e) { /* not JSON -- fall through, rawText still logged below */ }
  if (!res.ok) {
    // Transient upstream failure -- QBO's own servers were momentarily overloaded, not an
    // actual problem with this request. A short delay and retry resolves this most of the
    // time without the user ever needing to know it happened.
    if (RETRYABLE_STATUSES.includes(res.status) && attempt < 3) {
      const delayMs = attempt * 1000; // 1s, then 2s
      console.error(`QBO API ${res.status} on ${method} ${path.split('?')[0]} -- retrying in ${delayMs}ms (attempt ${attempt + 1}/3)`);
      await new Promise(r => setTimeout(r, delayMs));
      return qboApi(method, path, body, attempt + 1);
    }
    const msg = data.Fault?.Error?.[0]?.Message || data.Fault?.Error?.[0]?.Detail;
    if (!msg) {
      // The error didn't match QBO's usual Fault shape (common for 401/403s that come from
      // an auth/gateway layer before reaching the accounting API) -- log the raw body so the
      // real reason is visible in server logs instead of being silently lost.
      console.error(`QBO API error ${res.status} on ${method} ${path}:`, rawText.slice(0, 1000));
    }
    throw new Error(msg || `QBO API error ${res.status} on ${method} ${path.split('?')[0]}`);
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
    const environment = req.body.environment === 'production' ? 'production' : 'sandbox';
    const creds = clientCreds(environment);
    if (!creds.id) return res.status(500).json({ ok: false, message: `QBO_CLIENT_ID_${environment.toUpperCase()} (or QBO_CLIENT_ID) not configured on the server` });
    const state = Buffer.from(JSON.stringify({ environment, t: Date.now() })).toString('base64url');
    const params = new URLSearchParams({
      client_id: creds.id,
      redirect_uri: redirectUri(environment),
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
// Two separate routes, one per environment, since Intuit requires each redirect URI to be
// globally unique across the app -- the same URI can't be registered under both the Sandbox
// and Production tabs. Both routes share the same handler logic below.
async function handleOAuthCallback(req, res) {
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

    const creds = clientCreds(environment);
    const basicAuth = Buffer.from(`${creds.id}:${creds.secret}`).toString('base64');
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
        redirect_uri: redirectUri(environment),
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
}
router.get('/callback', handleOAuthCallback);
router.get('/callback-production', handleOAuthCallback);

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
        const creds = clientCreds(conn.environment);
        const basicAuth = Buffer.from(`${creds.id}:${creds.secret}`).toString('base64');
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
    const results = [];

    // Reconcile against QuickBooks first, in bulk -- for any order whose invoice already
    // exists there (DocNumber = Toasted's order ID), skip creating it entirely and just link
    // it. This is what actually stops "duplicate" errors from happening: the duplicate is
    // detected and handled before an attempt is ever made, rather than caught after
    // QuickBooks rejects it. Chunked so a batch of thousands doesn't build one huge query.
    const existingByDocNumber = {};
    const orderIds = invoices.map(inv => inv.orderId);
    const CHUNK_SIZE = 100;
    for (let i = 0; i < orderIds.length; i += CHUNK_SIZE) {
      const chunk = orderIds.slice(i, i + CHUNK_SIZE);
      const docNumberList = chunk.map(id => `'${id.replace(/'/g, "\\'")}'`).join(',');
      try {
        const existing = await qboQuery(null, `SELECT Id, DocNumber FROM Invoice WHERE DocNumber IN (${docNumberList}) MAXRESULTS 1000`);
        (existing.QueryResponse?.Invoice || []).forEach(qi => { existingByDocNumber[qi.DocNumber] = qi.Id; });
      } catch (lookupErr) {
        // If the reconciliation lookup itself fails, fall through to normal per-invoice
        // creation below -- QuickBooks' own duplicate check on create is still the backstop.
        console.error('QBO reconciliation lookup error:', lookupErr.message);
      }
    }

    for (const inv of invoices) {
      const existingId = existingByDocNumber[inv.orderId];
      if (existingId) {
        results.push({ orderId: inv.orderId, ok: true, invoiceId: existingId, alreadyExisted: true });
        continue;
      }
      try {
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
        results.push({ orderId: inv.orderId, ok: true, invoiceId: result.Invoice?.Id });
      } catch (invErr) {
        // One invoice failing should never stop the rest of the batch, and must never be
        // silently dropped -- the caller needs to know exactly which orders actually went
        // through versus which need attention. A genuine duplicate should be extremely rare
        // now that the check above runs first, but this remains the backstop if it happens.
        console.error(`QBO invoice creation error for order ${inv.orderId}:`, invErr.message);
        results.push({ orderId: inv.orderId, ok: false, error: invErr.message });
      }
    }

    const succeeded = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    const reconciled = results.filter(r => r.alreadyExisted);
    res.json({
      ok: true,
      results,
      invoiceIds: succeeded.map(r => r.invoiceId), // kept for backward compatibility
      succeededCount: succeeded.length,
      failedCount: failed.length,
      reconciledCount: reconciled.length,
    });
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
    const payments = result.QueryResponse?.Payment || [];

    // Collect every linked invoice TxnId across all payments, then look up each invoice's
    // DocNumber in one batch -- DocNumber always equals the Toasted order ID (set when the
    // invoice was created), so this lets the frontend match reliably even if Toasted's own
    // record of the invoice ID was never saved.
    const invoiceIds = new Set();
    payments.forEach(p => (p.Line || []).forEach(line =>
      (line.LinkedTxn || []).forEach(lt => { if (lt.TxnType === 'Invoice') invoiceIds.add(lt.TxnId); })
    ));
    const docNumberByInvoiceId = {};
    if (invoiceIds.size > 0) {
      const idList = [...invoiceIds].map(id => `'${id}'`).join(',');
      const invResult = await qboQuery(null, `SELECT Id, DocNumber FROM Invoice WHERE Id IN (${idList})`);
      (invResult.QueryResponse?.Invoice || []).forEach(inv => { docNumberByInvoiceId[inv.Id] = inv.DocNumber; });
    }

    res.json({ payments, docNumberByInvoiceId });
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
