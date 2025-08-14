// routes/messages.js
const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

router.get('/:ticketId', auth(), async (req,res)=>{
  const { ticketId } = req.params;
  const [rows] = await pool.execute(
    `SELECT m.*, u.full_name AS sender_name
     FROM ticket_messages m
     JOIN users u ON u.id=m.sender_id
     WHERE m.ticket_id=:id ORDER BY m.created_at ASC`,
    { id: ticketId }
  );
  res.json(rows);
});

router.post('/:ticketId', auth(), async (req,res)=>{
  const { ticketId } = req.params;
  const sender_type = (req.user.role === 'end_user') ? 'USER' : 'AGENT';
  const { message } = req.body;
  const [result] = await pool.execute(
    `INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message)
     VALUES (:tid, :sid, :stype, :msg)`,
    { tid: ticketId, sid: req.user.id, stype: sender_type, msg: message }
  );
  res.json({ ok:true, id: result.insertId });
});

module.exports = router;
