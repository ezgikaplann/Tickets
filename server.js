// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');

// NEW: socket server için
const http = require('http');
const { Server } = require('socket.io');
const cookie = require('cookie');

// NEW: Email servisini import et
const EmailService = require('./email-service');

const authRoutes    = require('./routes/auth');
const ticketRoutes  = require('./routes/tickets');
const messageRoutes = require('./routes/messages');
const uploadRoutes  = require('./routes/uploads');
const usersRoutes   = require('./routes/users');

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
app.get('/new-ticket.html',  guardPage('new-ticket.html'));  // end_user
app.get('/dispatcher.html',  guardPage('dispatcher.html'));  // dispatcher paneli
app.get('/ticket.html',      guardPage('ticket.html'));      // talep detay + chat

// ---- Statik dosyalar
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// ---- API router'ları
app.use('/auth',     authRoutes);
app.use('/tickets',  ticketRoutes);
app.use('/messages', messageRoutes);
app.use('/files',    uploadRoutes);
app.use('/users',    usersRoutes);

// Root → login
app.get('/', (req, res) => res.redirect('/login.html'));

// ---- Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});
app.set('io', io);

// Socket kimlik doğrulama (JWT cookie ile)
io.use((socket, next) => {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');
    const token = cookies.auth;
    if (!token) return next(new Error('unauthorized'));
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = payload; // { id, role, email }
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

// Basit oda mantığı: ticket bazlı
io.on('connection', (socket) => {
  socket.on('room:join', ({ ticketId }) => {
    if (!ticketId) return;
    socket.join(`ticket:${ticketId}`);
  });
});

// NEW: Email servisini başlat
let emailService;
try {
  emailService = new EmailService();
  console.log('Email servisi başarıyla başlatıldı');
} catch (err) {
  console.error('Email servisi başlatılamadı:', err.message);
  console.log('Email-to-ticket özelliği devre dışı');
}

const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`API listening on :${port}`);
  console.log(`Email-to-ticket sistemi: ${emailService ? 'Aktif' : 'Devre dışı'}`);
});
