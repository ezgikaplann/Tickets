const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
// const cron = require('node-cron'); // Bu satırı kaldırın
const pool = require('./db');

class EmailService {
    constructor() {
        // Gmail SMTP ayarları
        this.transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: 'emreerenk41@gmail.com', // Burayı güncelledik
                pass: process.env.GMAIL_APP_PASSWORD
            }
        });

        // IMAP ayarları (email okuma için)
        this.imapConfig = {
            user: 'emreerenk41@gmail.com', // Burayı da güncelledik
            password: process.env.GMAIL_APP_PASSWORD,
            host: 'imap.gmail.com',
            port: 993,
            tls: true,
            tlsOptions: {
                rejectUnauthorized: false,
                servername: 'imap.gmail.com'
            },
            connTimeout: 60000,
            authTimeout: 30000
        };

        this.startEmailPolling();
    }

    // Email polling başlat
    startEmailPolling() {
        console.log('Email polling başlatıldı');

        // Her 5 dakikada bir email kontrol et
        setInterval(() => {
            this.checkNewEmails();
        }, 300000);

        // İlk kontrolü hemen yap
        this.checkNewEmails();
    }

    // Yeni emailleri kontrol et
    async checkNewEmails() {
        try {
            console.log('Email kontrol ediliyor...');
            const imap = require('imap');
            const imapConnection = new imap(this.imapConfig);

            imapConnection.once('ready', () => {
                console.log('IMAP bağlantısı hazır');
                imapConnection.openBox('INBOX', false, (err, box) => {
                    if (err) {
                        console.error('INBOX açma hatası:', err);

                        imapConnection.end();
                        return;
                    }

                    // Son 10 dakikada gelen emailleri ara
                    const tenMinutesAgo = new Date();
                    tenMinutesAgo.setMinutes(tenMinutesAgo.getMinutes() - 10);

                    imapConnection.search([
                        ['SINCE', tenMinutesAgo],
                        ['UNSEEN']
                    ], (err, results) => {
                        if (err) {
                            console.error('Email arama hatası:', err);
                            imapConnection.end();
                            return;
                        }

                        if (results.length === 0) {
                            console.log('Yeni email bulunamadı');
                            imapConnection.end();
                            return;
                        }

                        console.log(`${results.length} yeni email bulundu`);

                        const fetch = imapConnection.fetch(results, { bodies: '' });
                        fetch.on('message', (msg, seqno) => {
                            let buffer = '';
                            msg.on('body', (stream, info) => {
                                stream.on('data', (chunk) => {
                                    buffer += chunk.toString('utf8');
                                });
                            });

                            msg.once('end', async () => {
                                try {
                                    await this.processEmail(buffer);
                                } catch (err) {
                                    console.error('Email işleme hatası:', err);
                                }
                            });
                        });

                        fetch.once('error', (err) => {
                            console.error('Fetch error:', err);
                        });

                        fetch.once('end', () => {
                            imapConnection.end();
                        });
                    });
                });
            });

            imapConnection.once('error', (err) => {
                console.error('IMAP error:', err);
            });

            imapConnection.once('end', () => {
                console.log('IMAP bağlantısı sonlandı');
            });

            imapConnection.connect();
        } catch (err) {
            console.error('Email kontrol hatası:', err);
        }
    }

    // Email'i işle ve ticket oluştur
    async processEmail(emailContent) {
        try {
            const parsed = await simpleParser(emailContent);

            // Email bilgilerini al
            const from = parsed.from.text;
            const subject = parsed.subject || 'Email ile gelen talep';
            const text = parsed.text || parsed.html || '';
            const date = parsed.date || new Date();

            // Email adresinden kullanıcı bilgilerini al veya oluştur
            const user = await this.getOrCreateUserFromEmail(from);

            // Ticket oluştur
            const ticket = await this.createTicketFromEmail(user, subject, text, date);

            console.log(`Email'den ticket oluşturuldu: #${ticket.id}`);

            // Email'i okundu olarak işaretle
            await this.markEmailAsRead(parsed.messageId);

        } catch (err) {
            console.error('Email işleme hatası:', err);
        }
    }

    // Email adresinden kullanıcı al veya oluştur
    async getOrCreateUserFromEmail(email) {
        try {
            // Önce mevcut kullanıcıyı ara
            const [existingUsers] = await pool.execute(
                'SELECT * FROM users WHERE email = ?',
                [email]
            );

            if (existingUsers.length > 0) {
                return existingUsers[0];
            }

            // Kullanıcı yoksa oluştur
            const [result] = await pool.execute(
                'INSERT INTO users (email, password_hash, full_name, role, created_at) VALUES (?, ?, ?, ?, NOW())',
                [email, "1", email.split('@')[0], 'end_user'] // password_hash'i null olarak ekleyin
            );

            return {
                id: result.insertId,
                email: email,
                full_name: email.split('@')[0],
                role: 'end_user'
            };

        } catch (err) {
            console.error('Kullanıcı oluşturma hatası:', err);
            throw err;
        }
    }

    // Email'den ticket oluştur
    async createTicketFromEmail(user, subject, description, date) {

        try {
            const [result] = await pool.execute(
                'INSERT INTO tickets (subject, description, created_by, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [subject, description, user.id, 'NEW', 'MEDIUM', date]
            );

            return {
                id: result.insertId,
                subject,
                description,
                user_id: user.id,
                status: 'NEW',
                priority: 'MEDIUM'
            };

        } catch (err) {
            console.error('Ticket oluşturma hatası:', err);
            throw err;
        }
    }

    // Email'i okundu olarak işaretle
    async markEmailAsRead(messageId) {
        // Bu kısım IMAP ile email'i okundu olarak işaretlemek için
        // Şimdilik basit tutuyoruz
    }
}

module.exports = EmailService;
