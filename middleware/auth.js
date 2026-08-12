const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'toasted-dev-secret-change-in-production';

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  }
  try {
    const token = header.slice(7);
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin access required' });
    }
    next();
  });
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, fname: user.fname, lname: user.lname, pricing_admin: !!user.pricing_admin },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

module.exports = { requireAuth, requireAdmin, signToken };
