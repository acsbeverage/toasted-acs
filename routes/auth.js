const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getOne, query } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const sgMail = require('@sendgrid/mail');

const FROM_EMAIL = process.env.FROM_EMAIL || 'accounting@acsbeverage.com';
const FROM_NAME  = process.env.FROM_NAME  || 'Toasted — ACS Beverage Co.';
const SIGNUP_NOTIFY_EMAILS = (process.env.SIGNUP_NOTIFY_EMAILS || 'accounting@acsbeverage.com,kevin@acsbeverage.com')
  .split(',').map(e => e.trim()).filter(Boolean);

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });
    const emailLower = email.toLowerCase().trim();
    let user = await getOne('SELECT * FROM users WHERE LOWER(email)=$1', [emailLower]);
    if (user) {
      const valid = await bcrypt.compare(password, user.pw_hash);
      if (!valid) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
      const token = signToken(user);
      return res.json({ ok: true, token, user: {
        id: user.id, fname: user.fname, lname: user.lname,
        email: user.email, role: user.role, commission: user.commission,
        pricing_admin: !!user.pricing_admin
      }});
    }
    let cust = await getOne('SELECT * FROM customer_users WHERE LOWER(email)=$1', [emailLower]);
    if (cust) {
      const valid = await bcrypt.compare(password, cust.pw_hash);
      if (!valid) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
      const acct = await getOne('SELECT is_active FROM accounts WHERE id=$1', [cust.acct_id]);
      if (!acct || acct.is_active === false) {
        return res.status(403).json({ ok: false, error: 'This account has been deactivated -- please contact your sales rep or accounting@acsbeverage.com' });
      }
      const token = signToken({ ...cust, role: 'customer' });
      return res.json({ ok: true, token, user: {
        id: cust.id, fname: cust.fname, lname: cust.lname,
        email: cust.email, role: 'customer', acctId: cust.acct_id
      }});
    }
    return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ ok: false, error: 'Missing fields' });
    if (newPassword.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    const table = req.user.role === 'customer' ? 'customer_users' : 'users';
    const user = await getOne(`SELECT * FROM ${table} WHERE id=$1`, [req.user.id]);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, user.pw_hash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await query(`UPDATE ${table} SET pw_hash=$1 WHERE id=$2`, [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ ok: false, error: 'Email required' });
    const emailLower = email.toLowerCase().trim();
    let user = await getOne('SELECT * FROM users WHERE LOWER(email)=$1', [emailLower]);
    let table = 'users';
    if (!user) {
      user = await getOne('SELECT * FROM customer_users WHERE LOWER(email)=$1', [emailLower]);
      table = 'customer_users';
    }
    if (!user) return res.json({ ok: true });
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 60 * 60 * 1000;
    await query(`UPDATE ${table} SET reset_token=$1, reset_expires=$2 WHERE id=$3`, [token, expires, user.id]);
    const appUrl = process.env.APP_URL || 'https://toasted.acsbeverageco.com';
    const resetUrl = `${appUrl}?reset=${token}`;
    if (process.env.SENDGRID_API_KEY) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({
        to: email,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: 'Toasted — Password Reset Request',
        text: `Hi ${user.fname||''},\n\nReset your password here (valid 1 hour):\n${resetUrl}\n\nIf you did not request this, ignore this email.\n\n---\nToasted | ACS Beverage Co. LLC`,
        html: `<div style="font-family:system-ui;max-width:500px;margin:32px auto;padding:32px;background:#fff;border-radius:12px">
          <div style="font-size:20px;font-weight:800;margin-bottom:20px">Toast<span style="color:#B8872C;font-weight:400;font-style:italic">ed</span></div>
          <h2 style="margin-top:0">Password Reset</h2>
          <p>Hi ${user.fname||''},</p>
          <p>Click below to reset your password. Link expires in <strong>1 hour</strong>.</p>
          <div style="text-align:center;margin:28px 0">
            <a href="${resetUrl}" style="background:#B8872C;color:#fff;padding:13px 32px;border-radius:8px;font-size:15px;font-weight:700;text-decoration:none">Reset my password</a>
          </div>
          <p style="color:#aaa;font-size:12px">If you did not request this, ignore this email.</p>
        </div>`
      });
    } else {
      console.log('RESET URL (dev):', resetUrl);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ ok: false, error: 'Missing fields' });
    if (newPassword.length < 6) return res.status(400).json({ ok: false, error: 'Password too short' });
    let user = await getOne('SELECT * FROM users WHERE reset_token=$1 AND reset_expires>$2', [token, Date.now()]);
    let table = 'users';
    if (!user) {
      user = await getOne('SELECT * FROM customer_users WHERE reset_token=$1 AND reset_expires>$2', [token, Date.now()]);
      table = 'customer_users';
    }
    if (!user) return res.status(400).json({ ok: false, error: 'Reset link is invalid or has expired' });
    const hash = await bcrypt.hash(newPassword, 10);
    await query(`UPDATE ${table} SET pw_hash=$1, reset_token=NULL, reset_expires=NULL WHERE id=$2`, [hash, user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset password error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/signup', async (req, res) => {
  try {
    const { fname, lname, email, password, custNum } = req.body;
    if (!fname||!lname||!email||!password||!custNum) {
      return res.status(400).json({ ok: false, error: 'All fields required' });
    }
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    const emailLower = email.toLowerCase().trim();
    const existing = await getOne('SELECT id FROM users WHERE LOWER(email)=$1', [emailLower]) ||
                     await getOne('SELECT id FROM customer_users WHERE LOWER(email)=$1', [emailLower]);
    if (existing) return res.status(400).json({ ok: false, error: 'An account with this email already exists' });
    const acct = await getOne('SELECT * FROM accounts WHERE id=$1 OR code=$1 OR abc_num=$1', [custNum.trim()]);
    if (!acct) return res.status(400).json({ ok: false, error: 'Customer number not found. Please check with your sales rep.' });
    const existingPortal = await getOne('SELECT id FROM customer_users WHERE acct_id=$1', [acct.id]);
    if (existingPortal) return res.status(400).json({ ok: false, error: 'A portal account already exists for this customer number' });
    const hash = await bcrypt.hash(password, 10);
    const id = 'c' + Date.now();
    await query(
      'INSERT INTO customer_users (id,fname,lname,email,pw_hash,acct_id,role) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, fname, lname, emailLower, hash, acct.id, 'customer']
    );
    const newUser = { id, fname, lname, email: emailLower, role: 'customer', acct_id: acct.id };
    const token = signToken({ ...newUser, role: 'customer' });
    res.json({ ok: true, token, user: { ...newUser, acctId: acct.id } });

    // Notify staff -- fire-and-forget, so a SendGrid hiccup can never delay or break the
    // customer's own signup, which has already succeeded and been responded to above.
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    sgMail.send({
      to: SIGNUP_NOTIFY_EMAILS,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: 'New customer portal signup: ' + acct.name,
      text: `A new customer has created a Toasted portal account.\n\n` +
            `Name: ${fname} ${lname}\nEmail: ${emailLower}\nAccount: ${acct.name}\nCustomer #: ${custNum.trim()}`,
      html: `<div style="font-family:system-ui;max-width:500px">
        <p>A new customer has created a Toasted portal account.</p>
        <p><strong>Name:</strong> ${fname} ${lname}<br>
        <strong>Email:</strong> ${emailLower}<br>
        <strong>Account:</strong> ${acct.name}<br>
        <strong>Customer #:</strong> ${custNum.trim()}</p>
      </div>`,
    }).catch(e => console.error('Signup notification email failed:', e.message));
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
