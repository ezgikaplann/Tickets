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
        }, 60000);

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

                    // Son 5 dakikada gelen emailleri ara
                    const fiveMinutesAgo = new Date();
                    fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);

                    imapConnection.search([
                        ['SINCE', fiveMinutesAgo],
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

                        // Her email'i ayrı ayrı işle ve okundu olarak işaretle
                        let processedCount = 0;

                        results.forEach((uid) => {
                            const fetch = imapConnection.fetch(uid, { bodies: '' });

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

                                        // Email'i okundu olarak işaretle (IMAP'de)
                                        imapConnection.addFlags(uid, '\\Seen', (err) => {
                                            if (err) {
                                                console.error(`Email işaretleme hatası (UID: ${uid}):`, err);
                                            } else {
                                                console.log(`Email okundu olarak işaretlendi (UID: ${uid})`);
                                            }

                                            processedCount++;
                                            if (processedCount === results.length) {
                                                // Tüm email'ler işlendikten sonra bağlantıyı kapat
                                                setTimeout(() => {
                                                    imapConnection.end();
                                                }, 1000);
                                            }
                                        });

                                    } catch (err) {
                                        console.error('Email işleme hatası:', err);
                                        processedCount++;
                                        if (processedCount === results.length) {
                                            setTimeout(() => {
                                                imapConnection.end();
                                            }, 1000);
                                        }
                                    }
                                });
                            });

                            fetch.once('error', (err) => {
                                console.error('Fetch error:', err);
                                processedCount++;
                                if (processedCount === results.length) {
                                    setTimeout(() => {
                                        imapConnection.end();
                                    }, 1000);
                                }
                            });
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

            // Bu email daha önce işlendi mi kontrol et
            if (parsed.messageId) {
                const [existingEmails] = await pool.execute(
                    'SELECT * FROM emails WHERE message_id = ?',
                    [parsed.messageId]
                );

                if (existingEmails.length > 0) {
                    console.log(`Email zaten işlenmiş: ${parsed.messageId}`);
                    return;
                }
            }

            // Email adresinden kullanıcı bilgilerini al veya oluştur
            const user = await this.getOrCreateUserFromEmail(from);

            // Ticket oluştur
            const ticket = await this.createTicketFromEmail(user, subject, text, date);

            // Email'i veritabanına kaydet
            if (parsed.messageId) {
                await pool.execute(
                    'INSERT INTO emails (message_id, from_email, subject, content, processed, ticket_id, received_at) VALUES (?, ?, ?, ?, TRUE, ?, NOW())',
                    [parsed.messageId, from, subject, text, ticket.id]
                );
            }

            console.log(`Email'den ticket oluşturuldu: #${ticket.id}`);

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
        console.log("elmalı turta", user);
        try {
            const [result] = await pool.execute(
                'INSERT INTO tickets (user_id, subject, description, created_by, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [user.id, subject, description, user.id, 'open', 'MEDIUM', date]
            );

            return {
                createdUser: user.id,
                id: result.insertId,
                subject,
                description,
                user: user.id,
                status: 'open',
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
