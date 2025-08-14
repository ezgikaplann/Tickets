// routes/uploads.js
const router = require('express').Router();
const multer = require('multer');
const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const auth = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuid()}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = /jpe?g$/i.test(file.originalname) && file.mimetype === 'image/jpeg';
    if(!ok) return cb(new Error('Only JPEG allowed'));
    cb(null, true);
  },
  limits: { fileSize: 4 * 1024 * 1024 } // 4MB
});

router.post('/ticket/:ticketId', auth(), upload.single('file'), async (req,res)=>{
  const { ticketId } = req.params;
  const file = req.file;
  if(!file) return res.status(400).json({error:'file_required'});

  const file_path = `/uploads/${file.filename}`;
  const file_name = file.originalname;
  const mime_type = 'image/jpeg';
  const file_size = file.size;

  const [result] = await pool.execute(
    `INSERT INTO ticket_attachments (ticket_id, message_id, file_name, file_path, mime_type, file_size)
     VALUES (:tid, NULL, :fname, :fpath, :mime, :fsize)`,
    { tid: ticketId, fname: file_name, fpath: file_path, mime: mime_type, fsize: file_size }
  );

  res.json({ ok:true, id: result.insertId, url: file_path });
});

module.exports = router;
