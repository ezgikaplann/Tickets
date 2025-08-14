// routes/auth.js
const express = require('express');
const router = express.Router();

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const authMw = require('../middleware/auth');

// yardımcı
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

// REGISTER (opsiyonel)
router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name, role = 'end_user' } = req.body || {};
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.execute(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES (:email,:hash,:name,:role)',
      { email, hash, name: full_name, role }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'duplicate_or_invalid', details: e.code || String(e) });
  }
});

// LOGIN (+ remember me)
router.post('/login', async (req, res) => {
  try {
    const { email, password, remember = false } = req.body || {};
    const [[user]] = await pool.execute(
      'SELECT * FROM users WHERE email=:email AND is_active=1',
      { email }
    );
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    // JWT (2 saat)
    const jwtToken = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    res.cookie('auth', jwtToken, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 2 * 60 * 60 * 1000, // 2 saat
      path: '/',
    });

    // Remember cookie (opsiyonel)
    if (remember) {
      const raw = crypto.randomBytes(32).toString('hex');       // 64 hex
      const token_hash = crypto.createHash('sha256').update(raw).digest('hex');
      const expires = daysFromNow(Number(process.env.SESSION_TOKEN_TTL_DAYS || 30));
      await pool.execute(
        'INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (:uid,:hash,:exp)',
        { uid: user.id, hash: token_hash, exp: expires.toISOString().slice(0,19).replace('T',' ') }
      );
      res.cookie('remember', raw, {
        httpOnly: true,
        sameSite: 'lax',
        expires,
        path: '/',
      });
    }

    res.json({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// REMEMBER ile oturum tazele
router.post('/refresh', async (req, res) => {
  try {
    const remember = req.cookies?.remember;
    if (!remember) return res.status(401).json({ error: 'no_remember_cookie' });

    const token_hash = crypto.createHash('sha256').update(remember).digest('hex');
    const [[sess]] = await pool.execute(
      `SELECT s.*, u.email, u.role
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = :h AND s.revoked = 0 AND s.expires_at > NOW()`,
      { h: token_hash }
    );
    if (!sess) return res.status(401).json({ error: 'invalid_or_expired' });

    await pool.execute('UPDATE auth_sessions SET last_used_at = NOW() WHERE id = :id', { id: sess.id });

    const newJwt = jwt.sign(
      { id: sess.user_id, role: sess.role, email: sess.email },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    res.cookie('auth', newJwt, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 2 * 60 * 60 * 1000,
      path: '/',
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ME (aktif kullanıcı)
router.get('/me', authMw(), async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      'SELECT id, email, full_name, role FROM users WHERE id = :id',
      { id: req.user.id }
    );
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ user: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// LOGOUT
router.post('/logout', async (req, res) => {
  try {
    const remember = req.cookies?.remember;
    if (remember) {
      const token_hash = crypto.createHash('sha256').update(remember).digest('hex');
      await pool.execute('UPDATE auth_sessions SET revoked = 1 WHERE token_hash = :h', { h: token_hash });
    }
    res.clearCookie('auth',     { httpOnly: true, sameSite: 'lax', path: '/' });
    res.clearCookie('remember', { httpOnly: true, sameSite: 'lax', path: '/' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
