// db.js
require('dotenv').config(); // .env dosyasını yükle

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQL_PORT || 3306, // ekleyebilirsin
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
});

// Tabloları oluştur
async function createTables() {
  try {
    // Users tablosu
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) DEFAULT NULL, // Bu satırı ekleyin
        full_name VARCHAR(255) NOT NULL,
        role ENUM('end_user', 'dispatcher', 'admin') DEFAULT 'end_user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Categories tablosu
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS categories (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Subcategories tablosu
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS subcategories (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category_id BIGINT UNSIGNED NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
      )
    `);

    // Sub-subcategories tablosu
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS sub_subcategories (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        subcategory_id BIGINT UNSIGNED NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE CASCADE
      )
    `);

    // Tickets tablosu
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS tickets (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        subject VARCHAR(500) NOT NULL,
        description TEXT,
        user_id BIGINT UNSIGNED NOT NULL,
        assigned_to BIGINT UNSIGNED,
        status ENUM('NEW', 'ASSIGNED', 'RESOLVED', 'CANCELLED', 'CLOSED') DEFAULT 'NEW',
        priority ENUM('LOW', 'MEDIUM', 'HIGH') DEFAULT 'MEDIUM',
        category_id BIGINT UNSIGNED,
        subcategory_id BIGINT UNSIGNED,
        sub_subcategory_id BIGINT UNSIGNED,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
        FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL,
        FOREIGN KEY (sub_subcategory_id) REFERENCES sub_subcategories(id) ON DELETE SET NULL
      )
    `);

    // Messages tablosu
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        ticket_id BIGINT UNSIGNED NOT NULL,
        sender_id BIGINT UNSIGNED NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Files tablosu
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS files (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        ticket_id BIGINT UNSIGNED,
        message_id BIGINT UNSIGNED,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      )
    `);

    // Emails tablosu
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS emails (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(255) UNIQUE,
        from_email VARCHAR(255) NOT NULL,
        subject TEXT,
        content LONGTEXT,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed BOOLEAN DEFAULT FALSE,
        ticket_id BIGINT UNSIGNED,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL
      )
    `);

    console.log('Tüm tablolar başarıyla oluşturuldu');
  } catch (err) {
    console.error('Tablo oluşturma hatası:', err);
  }
}

// Email tablosu oluştur
async function createEmailTable() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS emails (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(255) UNIQUE,
        from_email VARCHAR(255) NOT NULL,
        subject TEXT,
        content LONGTEXT,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed BOOLEAN DEFAULT FALSE,
        ticket_id INT,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL
      )
    `);
    console.log('Emails tablosu oluşturuldu');
  } catch (err) {
    console.error('Emails tablosu oluşturma hatası:', err);
  }
}

// Tabloları oluştur
createTables();
createEmailTable();

module.exports = pool;
