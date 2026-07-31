const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getOne, query } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const sgMail = require('@sendgrid/mail');

const FROM_EMAIL = process.env.FROM_EMAIL || 'accounting@acsbeverage.com';
const FROM_NAME  = process.env.FROM_NAME  || 'Toasted — ACS Beverage Co.';

// POST /api/auth/login
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
        email: user.email, role: user.role, commission: user.commission
      }});
    }

    let cust = await getOne('SELECT * FROM customer_users WHERE LOWER(email)=$1', [emailLower]);
    if (cust) {
      const valid = await bcrypt.compare(password, cust.pw_hash);
      if (!valid) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
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

// POST /api/auth/change-password
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

// POST /api/auth/forgot-password
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
        text: `Hi ${user.fname||''},\n\nReset your password here (valid 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email.\n\n---\nToasted | ACS Beverage Co. LLC`,
        html: `<div style="font-family:system-ui;max-width:500px;margin:32px auto;padding:32px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
          <div style="font-size:20px;font-weight:800;margin-bottom:20px">Toast<span style="color:#B8872C;font-weight:400;font-style:italic">ed</span></div>
          <h2 style="margin-top:0">Password Reset</h2>
          <p>Hi ${user.fname||''},</p>
          <p>Click below to reset your password. Link expires in <strong>1 hour</strong>.</p>
          <div style="text-align:center;margin:28px 0">
            <a href="${resetUrl}" style="background:#B8872C;color:#fff;padding:13px 32px;border-radius:8px;font-size:15px;font-weight:700;text-decoration:none">Reset my password</a>
          </div>
          <p style="color:#aaa;font-size:12px">If you didn't request this, ignore this email.</p>
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

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token,
