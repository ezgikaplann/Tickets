// routes/users.js
const router = require('express').Router();
const pool   = require('../db');
const auth   = require('../middleware/auth');

// Yalnızca DISPATCHER atanabilir kullanıcıları görsün
router.get('/', auth(['dispatcher']), async (_req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, full_name
       FROM users
      WHERE is_active = 1
        AND role <> 'end_user'  -- sadece agent/admin gibi roller
      ORDER BY full_name ASC`
  );
  res.json(rows);
});

module.exports = router;
