require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' })); // large for doc uploads

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api',        require('./routes/data'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  time: new Date().toISOString(),
  db: !!process.env.DATABASE_URL,
  email: !!process.env.SENDGRID_API_KEY
}));

// ── Serve Toasted frontend ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Toasted v2 running on port ${PORT}`);
  console.log(`Database: ${process.env.DATABASE_URL ? 'connected' : 'NOT SET'}`);
  console.log(`Email: ${process.env.SENDGRID_API_KEY ? 'ready' : 'not configured'}`);

  // Auto-run migrations on startup
  if (process.env.DATABASE_URL) {
    try {
      const { query } = require('./db');
      // Quick check if tables exist
      await query(`SELECT 1 FROM users LIMIT 1`);
      console.log('Database tables OK');
    } catch (err) {
      console.log('Running initial migration...');
      require('child_process').execSync('node db/migrate.js', { stdio: 'inherit' });
    }
  }
});
