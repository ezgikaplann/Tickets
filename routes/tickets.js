// routes/tickets.js
const router = require('express').Router();
const pool   = require('../db');
const auth   = require('../middleware/auth');

/**
 * GET /tickets
 * Tüm biletleri listeler. İsteğe bağlı filtreler:
 *  - status
 *  - assigned_to
 *  - category_id
 *  - q  (subject/description LIKE aranır)
 */
router.get('/', auth(), async (req, res) => {
  const { status, assigned_to, category_id, q } = req.query;

  let sql = `
    SELECT t.*, u.full_name AS creator_name, a.full_name AS assignee_name
    FROM tickets t
    JOIN users u  ON u.id = t.created_by
    LEFT JOIN users a ON a.id = t.assigned_to
    WHERE 1=1
  `;
  const params = {};

  if (status)       { sql += ' AND t.status = :status';                 params.status = status; }
  if (assigned_to)  { sql += ' AND t.assigned_to = :ass';               params.ass = assigned_to; }
  if (category_id)  { sql += ' AND t.category_id = :cid';               params.cid = category_id; }
  if (q) {
    sql += ' AND (t.subject LIKE :qlike OR t.description LIKE :qlike)';
    params.qlike = `%${q}%`;
  }

  sql += ' ORDER BY t.created_at DESC LIMIT 200';

  const [rows] = await pool.execute(sql, params);
  res.json(rows);
});

/**
 * POST /tickets
 * Yeni bilet oluşturur.
 */
router.post('/', auth(), async (req, res) => {
  const {
    subject,
    description,
    priority = 'MEDIUM',
    category_id = null,
    subcategory_id = null,
    work_group_id = null
  } = req.body || {};

  if (!subject) return res.status(400).json({ error: 'subject_required' });

  const [result] = await pool.execute(
    `INSERT INTO tickets
      (subject, description, priority, category_id, subcategory_id, work_group_id, created_by)
     VALUES
      (:subject, :description, :priority, :category_id, :subcategory_id, :work_group_id, :uid)`,
    {
      subject,
      description,
      priority,
      category_id,
      subcategory_id,
      work_group_id,
      uid: req.user.id
    }
  );

  res.json({ ok: true, id: result.insertId });
});

/**
 * POST /tickets/:id/assign_to_me
 * Agent/Admin için "Bana Ata"
 */
router.post('/:id/assign_to_me', auth(['agent', 'admin']), async (req, res) => {
  const { id } = req.params;

  await pool.execute(
    `UPDATE tickets SET assigned_to = :uid, status = 'ASSIGNED' WHERE id = :id`,
    { uid: req.user.id, id }
  );

  await pool.execute(
    `INSERT INTO ticket_status_history
      (ticket_id, old_status, new_status, changed_by, note)
     VALUES (:id, NULL, 'ASSIGNED', :uid, 'Assign to me')`,
    { id, uid: req.user.id }
  );

  res.json({ ok: true });
});

/**
 * POST /tickets/:id/status
 * Agent/Admin bilet durum güncelleme
 */
router.post('/:id/status', auth(['agent', 'admin']), async (req, res) => {
  const { id } = req.params;
  const { status, note = null } = req.body || {};

  const [[old]] = await pool.execute(
    'SELECT status FROM tickets WHERE id = :id',
    { id }
  );
  if (!old) return res.status(404).json({ error: 'not_found' });

  await pool.execute(
    `UPDATE tickets
       SET status = :s,
           closed_at = CASE WHEN :s IN ('RESOLVED','CLOSED','CANCELLED') THEN NOW() ELSE NULL END
     WHERE id = :id`,
    { s: status, id }
  );

  await pool.execute(
    `INSERT INTO ticket_status_history
      (ticket_id, old_status, new_status, changed_by, note)
     VALUES (:id, :old, :new, :uid, :note)`,
    { id, old: old.status, new: status, uid: req.user.id, note }
  );

  res.json({ ok: true });
});

/**
 * GET /tickets/categories
 * Aktif kategoriler
 */
router.get('/categories', auth(), async (_req, res) => {
  const [rows] = await pool.execute(
    'SELECT id, name FROM categories WHERE is_active = 1 ORDER BY name'
  );
  res.json(rows);
});

/**
 * GET /tickets/subcategories?category_id=1
 * Bir kategorinin aktif alt kategorileri
 */
router.get('/subcategories', auth(), async (req, res) => {
  const { category_id } = req.query;
  if (!category_id) return res.json([]);

  const [rows] = await pool.execute(
    'SELECT id, name FROM subcategories WHERE is_active = 1 AND category_id = :id ORDER BY name',
    { id: category_id }
  );
  res.json(rows);
});

// 3. seviye: alt-alt kategoriler
router.get('/subsubcategories', auth(), async (req, res) => {
  const { subcategory_id } = req.query;
  if (!subcategory_id) return res.json([]);
  const [rows] = await pool.execute(
    'SELECT id, name FROM sub_subcategories WHERE is_active=1 AND subcategory_id=:sid ORDER BY name',
    { sid: subcategory_id }
  );
  res.json(rows);
});

/**
 * PUT /tickets/:id/assign
 * Yalnızca DISPATCHER herhangi bir kullanıcıya atar
 * Body: { assigned_to: number }
 */
router.put('/:id/assign', auth(['dispatcher']), async (req, res) => {
  const { id } = req.params;
  const { assigned_to } = req.body || {};

  if (!assigned_to) return res.status(400).json({ error: 'assigned_to_required' });

  // 1) Ticket var mı? kapalı mı?
  const [[t]] = await pool.execute(`SELECT id, status FROM tickets WHERE id = :id`, { id });
  if (!t) return res.status(404).json({ error: 'ticket_not_found' });
  if (['RESOLVED','CLOSED','CANCELLED'].includes(t.status)) {
    return res.status(409).json({ error: 'ticket_closed_or_resolved' });
  }

  // 2) Kullanıcı var mı ve atanabilir mi?
  const [[u]] = await pool.execute(
    `SELECT id, role, is_active FROM users WHERE id=:uid`,
    { uid: assigned_to }
  );
  if (!u || !u.is_active) return res.status(400).json({ error: 'invalid_assignee' });
  if (u.role === 'end_user') return res.status(400).json({ error: 'assignee_must_be_agent_or_admin' });

  // 3) Güncelle + history
  await pool.execute(
    `UPDATE tickets
        SET assigned_to = :uid,
            status = 'ASSIGNED'
      WHERE id = :id`,
    { uid: assigned_to, id }
  );

  await pool.execute(
    `INSERT INTO ticket_status_history
        (ticket_id, old_status, new_status, changed_by, note)
     VALUES (:id, :old, 'ASSIGNED', :by, 'Assigned by dispatcher')`,
    { id, old: t.status, by: req.user.id }
  );

  res.json({ ok: true });
});

module.exports = router;
