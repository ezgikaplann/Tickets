// routes/messages.js
const router = require('express').Router();
const pool   = require('../db');
const auth   = require('../middleware/auth');

// GET /messages?ticket_id=123  → bir biletin mesajları (en eskiden yeniye)
router.get('/', auth(), async (req, res) => {
  const ticket_id = Number(req.query.ticket_id || 0);
  if (!ticket_id) return res.status(400).json({ error: 'ticket_id_required' });

  const [rows] = await pool.execute(`
    SELECT m.id, m.ticket_id, m.sender_id, m.body, m.is_internal, m.created_at,
           u.full_name AS sender_name
      FROM messages m
      JOIN users    u ON u.id = m.sender_id
     WHERE m.ticket_id = :tid
     ORDER BY m.created_at ASC, m.id ASC
  `, { tid: ticket_id });

  res.json(rows);
});

// POST /messages  { ticket_id, body, is_internal? }
router.post('/', auth(), async (req, res) => {
  const { ticket_id, body, is_internal = 0 } = req.body || {};
  if (!ticket_id) return res.status(400).json({ error: 'ticket_id_required' });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'body_required' });

  // Bilet var mı?
  const [[t]] = await pool.execute('SELECT id FROM tickets WHERE id=:id', { id: ticket_id });
  if (!t) return res.status(404).json({ error: 'ticket_not_found' });

  const [result] = await pool.execute(`
    INSERT INTO messages (ticket_id, sender_id, body, is_internal)
    VALUES (:tid, :uid, :body, :internal)
  `, { tid: ticket_id, uid: req.user.id, body: String(body).trim(), internal: is_internal ? 1 : 0 });

  const [[row]] = await pool.execute(`
    SELECT m.id, m.ticket_id, m.sender_id, m.body, m.is_internal, m.created_at,
           u.full_name AS sender_name
      FROM messages m
      JOIN users    u ON u.id = m.sender_id
     WHERE m.id = :id
  `, { id: result.insertId });

  // NEW: Aynı ticket odasına yayınla (gönderen dahil tüm katılımcılar anında görsün)
  const io = req.app.get('io');
  if (io) io.to(`ticket:${ticket_id}`).emit('message:new', row);

  res.status(201).json(row);
});

module.exports = router;
