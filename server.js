// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const authRoutes    = require('./routes/auth');
const ticketRoutes  = require('./routes/tickets');
const messageRoutes = require('./routes/messages');
const uploadRoutes  = require('./routes/uploads');
const usersRoutes   = require('./routes/users'); // <<< kullanıcı listesi için

const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: true }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Basit sağlık ucu
app.get('/health', (_, res) => res.json({ ok: true }));

// ---- HTML sayfalarını (JWT ile) koru: statik servisten ÖNCE tanımla
function guardPage(fileName) {
  return (req, res) => {
    try {
      const token =
        req.cookies?.auth ||
        (req.headers.authorization || '').replace('Bearer ', '');
      if (!token) throw new Error('no token');
      jwt.verify(token, process.env.JWT_SECRET);
      return res.sendFile(path.join(__dirname, 'public', fileName));
    } catch {
      return res.redirect('/login.html');
    }
  };
}

app.get('/dashboard.html',   guardPage('dashboard.html'));   // admin/agent/dispatcher
app.get('/assigned.html',    guardPage('assigned.html'));    // admin/agent
app.get('/done.html',        guardPage('done.html'));        // admin/agent
app.get('/user.html',        guardPage('user.html'));        // end_user
app.get('/new-ticket.html',  guardPage('new-ticket.html'));  // end_user (talep oluştur)
app.get('/dispatcher.html',  guardPage('dispatcher.html'));  // <<< DISPATCHER sayfasını da koru

// ---- Statik dosyalar
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // görsel ekleri
app.use(express.static(path.join(__dirname, 'public')));              // html/css/js

// ---- API router'ları
app.use('/auth',     authRoutes);
app.use('/tickets',  ticketRoutes);
app.use('/messages', messageRoutes);
app.use('/files',    uploadRoutes);
app.use('/users',    usersRoutes); // <<< /users API

// Root → login
app.get('/', (req, res) => res.redirect('/login.html'));

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API listening on :${port}`));
