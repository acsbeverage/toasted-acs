const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

async function getOne(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function getAll(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

module.exports = { query, getOne, getAll, pool };
