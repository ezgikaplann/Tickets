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
 * Agent/Admin/End_user bilet durum güncelleme
 */
router.post('/:id/status', auth(['agent', 'admin', 'end_user']), async (req, res) => {
  const { id } = req.params;
  const { status, note = null } = req.body || {};

  console.log('=== STATUS UPDATE BAŞLADI ===');
  console.log('Ticket ID:', id);
  console.log('New Status:', status);
  console.log('User Role:', req.user.role);
  console.log('User ID:', req.user.id);

  try {
    // 1) Ticket var mı?
    const [[ticket]] = await pool.execute(
      'SELECT id, status, created_by, assigned_to FROM tickets WHERE id = ?',
      [id]
    );
    
    if (!ticket) {
      console.log('Ticket not found');
      return res.status(404).json({ error: 'ticket_not_found' });
    }

    console.log('Ticket details:', {
      id: ticket.id,
      status: ticket.status,
      created_by: ticket.created_by,
      assigned_to: ticket.assigned_to
    });

    // 2) Yetki kontrolü - basitleştirildi
    console.log('=== YETKİ KONTROLÜ ===');
    console.log('User role:', req.user.role);
    console.log('User ID:', req.user.id);
    console.log('Ticket created_by:', ticket.created_by);
    console.log('Ticket assigned_to:', ticket.assigned_to);
    
    let canUpdate = false;
    let reason = '';

    if (req.user.role === 'admin' || req.user.role === 'agent') {
      canUpdate = true;
      reason = 'Admin/Agent role';
    } else if (req.user.role === 'end_user') {
      // End_user kendi oluşturduğu VEYA kendine atanan talepleri güncelleyebilir
      if (parseInt(ticket.created_by) === parseInt(req.user.id) || 
          parseInt(ticket.assigned_to) === parseInt(req.user.id)) {
        canUpdate = true;
        reason = 'Own or assigned ticket';
      } else {
        canUpdate = false;
        reason = 'Not own or assigned ticket';
      }
    }

    console.log('Can update:', canUpdate);
    console.log('Reason:', reason);

    if (!canUpdate) {
      console.log('Permission denied');
      return res.status(403).json({ 
        error: 'permission_denied', 
        message: 'Bu talebi tamamlama yetkiniz yok. Sadece kendi oluşturduğunuz veya size atanan talepleri tamamlayabilirsiniz.',
        debug: {
          userRole: req.user.role,
          userId: req.user.id,
          ticketCreatedBy: ticket.created_by,
          ticketAssignedTo: ticket.assigned_to,
          reason: reason
        }
      });
    }

    console.log('Permission granted:', reason);

    // 3) Durum güncelleme
    await pool.execute(
      `UPDATE tickets
         SET status = ?,
             closed_at = CASE WHEN ? IN ('RESOLVED','CLOSED','CANCELLED') THEN NOW() ELSE NULL END
       WHERE id = ?`,
      [status, status, id]
    );

    console.log('Status updated');

    // 4) History kaydı
    await pool.execute(
      `INSERT INTO ticket_status_history
          (ticket_id, old_status, new_status, changed_by, note)
       VALUES (?, ?, ?, ?, ?)`,
      [id, ticket.status, status, req.user.id, note]
    );

    console.log('History recorded');
    console.log('=== STATUS UPDATE BAŞARILI ===');

    res.json({ ok: true, message: 'Talep durumu başarıyla güncellendi' });
  } catch (error) {
    console.error('=== STATUS UPDATE HATASI ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    
    res.status(500).json({ 
      error: 'internal_server_error', 
      message: error.message 
    });
  }
});

/**
 * GET /tickets/categories
 * Aktif kategoriler
 */
router.get('/categories', auth(), async (_req, res) => {
  try {
    // Önce tablo yapısını kontrol et
    const [tables] = await pool.execute('SHOW TABLES LIKE "categories"');
    
    if (tables.length === 0) {
      console.log('categories tablosu yok, oluşturuluyor...');
      
      // Tabloyu oluştur
      await pool.execute(`
        CREATE TABLE categories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          is_active BOOLEAN DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Örnek veriler ekle
      await pool.execute(`
        INSERT INTO categories (name) VALUES 
        ('Bilgi Teknolojileri'),
        ('İnsan Kaynakları'),
        ('Muhasebe'),
        ('Satış'),
        ('Pazarlama'),
        ('Müşteri Hizmetleri')
      `);
      
      console.log('categories tablosu oluşturuldu ve örnek veriler eklendi');
    }

    const [rows] = await pool.execute(
      'SELECT id, name FROM categories WHERE is_active = 1 ORDER BY name'
    );
    
    console.log(`${rows.length} kategori bulundu:`, rows);
    res.json(rows);
  } catch (error) {
    console.error('Categories error:', error);
    res.status(500).json({ error: 'internal_server_error', message: error.message });
  }
});

/**
 * GET /tickets/subcategories?category_id=1
 * Bir kategorinin aktif alt kategorileri
 */
router.get('/subcategories', auth(), async (req, res) => {
  const { category_id } = req.query;
  
  console.log('=== ALT KATEGORİLER ENDPOINT ÇAĞRILDI ===');
  console.log('Query parametreleri:', req.query);
  console.log('category_id:', category_id);
  console.log('category_id type:', typeof category_id);
  
  if (!category_id) {
    console.log('category_id parametresi eksik, boş array döndürülüyor');
    return res.json([]);
  }

  try {
    // category_id'yi number'a çevir
    const categoryId = parseInt(category_id);
    if (isNaN(categoryId)) {
      console.log('category_id geçersiz sayı:', category_id);
      return res.status(400).json({ error: 'invalid_category_id', message: 'Geçersiz kategori ID' });
    }
    
    console.log('Parsed categoryId:', categoryId);
    
    // Önce tablo yapısını kontrol et
    const [tables] = await pool.execute('SHOW TABLES LIKE "subcategories"');
    console.log('subcategories tablosu mevcut mu:', tables.length > 0);
    
    if (tables.length === 0) {
      console.log('subcategories tablosu yok, oluşturuluyor...');
      
      // Tabloyu oluştur
      await pool.execute(`
        CREATE TABLE subcategories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          category_id INT NOT NULL,
          is_active BOOLEAN DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        )
      `);
      
      // Örnek veriler ekle
      await pool.execute(`
        INSERT INTO subcategories (name, category_id) VALUES 
        ('Teknik Destek', 1),
        ('Yazılım Sorunu', 1),
        ('Donanım Sorunu', 1),
        ('Ağ Sorunu', 1),
        ('Uygulama Sorunu', 1),
        ('Sistem Sorunu', 1),
        ('Güvenlik Sorunu', 1),
        ('Performans Sorunu', 1)
      `);
      
      console.log('subcategories tablosu oluşturuldu ve örnek veriler eklendi');
    }

    // SQL sorgusunu düzelt - named placeholder yerine positional placeholder kullan
    const [rows] = await pool.execute(
      'SELECT id, name FROM subcategories WHERE is_active = 1 AND category_id = ? ORDER BY name',
      [categoryId]  // Array olarak geç, named placeholder değil
    );
    
    console.log(`Category ${categoryId} için ${rows.length} alt kategori bulundu:`, rows);
    
    // SQL sorgusunu da logla
    const sql = 'SELECT id, name FROM subcategories WHERE is_active = 1 AND category_id = ? ORDER BY name';
    console.log('SQL sorgusu:', sql);
    console.log('SQL parametreleri (array):', [categoryId]);
    
    res.json(rows);
  } catch (error) {
    console.error('=== ALT KATEGORİLER HATASI ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'internal_server_error', message: error.message });
  }
});

/**
 * GET /tickets/subsubcategories?subcategory_id=1
 * Bir alt kategorinin aktif alt-alt kategorileri
 */
router.get('/subsubcategories', auth(), async (req, res) => {
  const { subcategory_id } = req.query;
  
  console.log('=== ALT-ALT KATEGORİLER ENDPOINT ÇAĞRILDI ===');
  console.log('Query parametreleri:', req.query);
  console.log('subcategory_id:', subcategory_id);
  console.log('subcategory_id type:', typeof subcategory_id);
  
  if (!subcategory_id) {
    console.log('subcategory_id parametresi eksik, boş array döndürülüyor');
    return res.json([]);
  }

  try {
    // subcategory_id'yi number'a çevir
    const subcategoryId = parseInt(subcategory_id);
    if (isNaN(subcategoryId)) {
      console.log('subcategory_id geçersiz sayı:', subcategory_id);
      return res.status(400).json({ error: 'invalid_subcategory_id', message: 'Geçersiz alt kategori ID' });
    }
    
    console.log('Parsed subcategoryId:', subcategoryId);
    
    // Önce tablo yapısını kontrol et
    const [tables] = await pool.execute('SHOW TABLES LIKE "sub_subcategories"');
    console.log('sub_subcategories tablosu mevcut mu:', tables.length > 0);
    
    if (tables.length === 0) {
      console.log('sub_subcategories tablosu yok, oluşturuluyor...');
      
      // Tabloyu oluştur
      await pool.execute(`
        CREATE TABLE sub_subcategories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          subcategory_id INT NOT NULL,
          is_active BOOLEAN DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE CASCADE
        )
      `);
      
      console.log('sub_subcategories tablosu oluşturuldu');
      
      // Örnek veriler ekle
      await pool.execute(`
        INSERT INTO sub_subcategories (name, subcategory_id) VALUES 
        -- Teknik Destek alt kategorileri
        ('Windows Sorunu', 1),
        ('Mac Sorunu', 1),
        ('Linux Sorunu', 1),
        ('Mobil Cihaz', 1),
        
        -- Yazılım Sorunu alt kategorileri
        ('Web Uygulaması', 2),
        ('Masaüstü Uygulama', 2),
        ('Veritabanı', 2),
        ('API Sorunu', 2),
        
        -- Donanım Sorunu alt kategorileri
        ('Sunucu', 3),
        ('Bilgisayar', 3),
        ('Yazıcı', 3),
        ('Tarayıcı', 3),
        
        -- Ağ Sorunu alt kategorileri
        ('Router', 4),
        ('Switch', 4),
        ('Modem', 4),
        ('WiFi', 4),
        
        -- Uygulama Sorunu alt kategorileri (ÖNEMLİ!)
        ('Web Tarayıcı', 5),
        ('Mobil Uygulama', 5),
        ('Masaüstü Program', 5),
        ('E-posta Uygulaması', 5),
        ('Ofis Uygulamaları', 5),
        ('Grafik Tasarım', 5),
        ('Video Düzenleme', 5),
        ('Oyun', 5),
        ('Antivirüs', 5),
        ('Yedekleme', 5),
        
        -- Sistem Sorunu alt kategorileri
        ('İşletim Sistemi', 6),
        ('Sürücü', 6),
        ('Servis', 6),
        ('Güncelleme', 6),
        
        -- Güvenlik Sorunu alt kategorileri
        ('Virüs', 7),
        ('Malware', 7),
        ('Spam', 7),
        ('Şifre', 7),
        
        -- Performans Sorunu alt kategorileri
        ('Yavaşlık', 8),
        ('Donma', 8),
        ('Çökme', 8),
        ('Bellek', 8)
      `);
      
      console.log('sub_subcategories tablosuna örnek veriler eklendi');
    } else {
      console.log('sub_subcategories tablosu zaten mevcut');
      
      // Mevcut verileri kontrol et
      const [existingData] = await pool.execute('SELECT * FROM sub_subcategories LIMIT 5');
      console.log('Mevcut alt-alt kategori verileri (ilk 5):', existingData);
      
      // Uygulama Sorunu için alt-alt kategorileri kontrol et
      const [appSubcategory] = await pool.execute(
        'SELECT id FROM subcategories WHERE name = "Uygulama Sorunu" LIMIT 1'
      );
      console.log('Uygulama Sorunu alt kategorisi:', appSubcategory);
      
      if (appSubcategory.length > 0) {
        const appSubcategoryId = appSubcategory[0].id;
        console.log('Uygulama Sorunu alt kategori ID:', appSubcategoryId);
        
        // Bu alt kategori için kaç tane alt-alt kategori var?
        const [appSubsubcategories] = await pool.execute(
          'SELECT COUNT(*) as count FROM sub_subcategories WHERE subcategory_id = ?',
          [appSubcategoryId]
        );
        console.log('Uygulama Sorunu için alt-alt kategori sayısı:', appSubsubcategories[0].count);
        
        if (appSubsubcategories[0].count === 0) {
          console.log('Uygulama Sorunu için alt-alt kategoriler ekleniyor...');
          
          // Uygulama Sorunu için alt-alt kategorileri ekle
          await pool.execute(`
            INSERT INTO sub_subcategories (name, subcategory_id) VALUES 
            ('Web Tarayıcı', ?),
            ('Mobil Uygulama', ?),
            ('Masaüstü Program', ?),
            ('E-posta Uygulaması', ?),
            ('Ofis Uygulamaları', ?),
            ('Grafik Tasarım', ?),
            ('Video Düzenleme', ?),
            ('Oyun', ?),
            ('Antivirüs', ?),
            ('Yedekleme', ?)
          `, [appSubcategoryId, appSubcategoryId, appSubcategoryId, appSubcategoryId, appSubcategoryId, 
               appSubcategoryId, appSubcategoryId, appSubcategoryId, appSubcategoryId, appSubcategoryId]);
          
          console.log('Uygulama Sorunu için alt-alt kategoriler eklendi');
        }
      }
    }

    // Şimdi istenen subcategory_id için alt-alt kategorileri getir
    console.log(`subcategoryId ${subcategoryId} için alt-alt kategoriler aranıyor...`);
    
    // SQL sorgusunu düzelt - named placeholder yerine positional placeholder kullan
    const [rows] = await pool.execute(
      'SELECT id, name FROM sub_subcategories WHERE is_active = 1 AND subcategory_id = ? ORDER BY name',
      [subcategoryId]  // Array olarak geç, named placeholder değil
    );
    
    console.log(`Subcategory ${subcategoryId} için ${rows.length} alt-alt kategori bulundu:`, rows);
    
    // SQL sorgusunu da logla
    const sql = 'SELECT id, name FROM sub_subcategories WHERE is_active = 1 AND subcategory_id = ? ORDER BY name';
    console.log('SQL sorgusu:', sql);
    console.log('SQL parametreleri (array):', [subcategoryId]);
    
    res.json(rows);
  } catch (error) {
    console.error('=== ALT-ALT KATEGORİLER HATASI ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'internal_server_error', message: error.message });
  }
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

/**
 * PUT /tickets/:id/unassign
 * DISPATCHER atamayı iptal eder
 */
router.put('/:id/unassign', auth(['dispatcher']), async (req, res) => {
  const { id } = req.params;

  // 1) Ticket var mı? kapalı mı?
  const [[t]] = await pool.execute(`SELECT id, status, assigned_to FROM tickets WHERE id = :id`, { id });
  if (!t) return res.status(404).json({ error: 'ticket_not_found' });
  if (['RESOLVED','CLOSED','CANCELLED'].includes(t.status)) {
    return res.status(409).json({ error: 'ticket_closed_or_resolved' });
  }
  if (!t.assigned_to) return res.status(400).json({ error: 'ticket_not_assigned' });

  // 2) Güncelle + history
  await pool.execute(
    `UPDATE tickets
        SET assigned_to = NULL,
            status = 'OPEN'
      WHERE id = :id`,
    { id }
  );

  await pool.execute(
    `INSERT INTO ticket_status_history
        (ticket_id, old_status, new_status, changed_by, note)
     VALUES (:id, :old, 'OPEN', :by, 'Assignment cancelled by dispatcher')`,
    { id, old: t.status, by: req.user.id }
  );

  res.json({ ok: true });
});

/**
 * PUT /tickets/:id/cancel
 * DISPATCHER talebi iptal eder
 */
router.put('/:id/cancel', auth(['dispatcher']), async (req, res) => {
  console.log('Cancel endpoint çağrıldı:', req.params.id);
  
  const { id } = req.params;

  try {
    // 1) Ticket var mı?
    const [[t]] = await pool.execute(`SELECT id, status FROM tickets WHERE id = :id`, { id });
    console.log('Ticket bulundu:', t);
    
    if (!t) return res.status(404).json({ error: 'ticket_not_found' });
    
    // 2) Eğer zaten iptal edilmişse başarılı döndür
    if (t.status === 'CANCELLED') {
      return res.json({ ok: true, already_cancelled: true });
    }
    
    // 3) Kapalı talepleri iptal etmeye izin ver
    // if (['RESOLVED','CLOSED','CANCELLED'].includes(t.status)) {
    //   return res.status(409).json({ error: 'ticket_closed_or_resolved' });
    // }

    // 4) Güncelle + history
    await pool.execute(
      `UPDATE tickets
          SET assigned_to = NULL,
              status = 'CANCELLED'
        WHERE id = :id`,
      { id }
    );
    console.log('Ticket güncellendi');

    await pool.execute(
      `INSERT INTO ticket_status_history
          (ticket_id, old_status, new_status, changed_by, note)
       VALUES (:id, :old, 'CANCELLED', :by, 'Cancelled by dispatcher')`,
      { id, old: t.status, by: req.user.id }
    );
    console.log('History eklendi');

    res.json({ ok: true });
  } catch (error) {
    console.error('Cancel endpoint hatası:', error);
    res.status(500).json({ error: 'internal_server_error', message: error.message });
  }
});

/**
 * GET /tickets/:id/priority
 * Test için öncelik bilgisini getir
 */
router.get('/:id/priority', auth(['dispatcher']), async (req, res) => {
  const { id } = req.params;
  
  try {
    const [[t]] = await pool.execute(`SELECT id, priority FROM tickets WHERE id = :id`, { id });
    if (!t) return res.status(404).json({ error: 'ticket_not_found' });
    
    res.json({ id: t.id, priority: t.priority });
  } catch (error) {
    console.error('Priority get error:', error);
    res.status(500).json({ error: 'internal_server_error', message: error.message });
  }
});

/**
 * PUT /tickets/:id/priority
 * DISPATCHER talebin önceliğini günceller
 */
router.put('/:id/priority', auth(['dispatcher']), async (req, res) => {
  try {
    const { id } = req.params;
    const { priority } = req.body || {};

    console.log('Priority update request received:', { id, priority });

    // Öncelik değerlerini kontrol et - LOW, MEDIUM, HIGH
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(priority)) {
      console.log('Invalid priority value:', priority);
      return res.status(400).json({ error: 'invalid_priority', message: 'Geçersiz öncelik değeri' });
    }

    // Ticket'ın var olup olmadığını kontrol et
    const [tickets] = await pool.execute('SELECT id FROM tickets WHERE id = ?', [id]);
    
    if (tickets.length === 0) {
      console.log('Ticket not found:', id);
      return res.status(404).json({ error: 'ticket_not_found', message: 'Talep bulunamadı' });
    }

    // Önceliği güncelle
    const [updateResult] = await pool.execute(
      'UPDATE tickets SET priority = ? WHERE id = ?',
      [priority, id]
    );

    console.log('Update completed:', updateResult);

    if (updateResult.affectedRows === 0) {
      return res.status(500).json({ error: 'update_failed', message: 'Güncelleme başarısız' });
    }

    console.log('Priority updated successfully');
    res.json({ 
      ok: true, 
      message: 'Öncelik başarıyla güncellendi',
      ticket_id: id,
      new_priority: priority 
    });

  } catch (error) {
    console.error('Priority update error:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'internal_server_error', 
      message: 'Sunucu hatası: ' + error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * GET /tickets/:id
 * Belirli bir talebin detaylarını getirir
 */
router.get('/:id', auth(), async (req, res) => {
  const { id } = req.params;

  try {
    const [tickets] = await pool.execute(`
      SELECT t.*, u.full_name AS creator_name, a.full_name AS assignee_name
      FROM tickets t
      JOIN users u ON u.id = t.created_by
      LEFT JOIN users a ON a.id = t.assigned_to
      WHERE t.id = ?
    `, [id]);

    if (tickets.length === 0) {
      return res.status(404).json({ error: 'ticket_not_found' });
    }

    res.json(tickets[0]);
  } catch (error) {
    console.error('Ticket get error:', error);
    res.status(500).json({ error: 'internal_server_error', message: error.message });
  }
});

/**
 * DELETE /tickets/:id
 * DISPATCHER talebi siler
 */
router.delete('/:id', auth(['dispatcher']), async (req, res) => {
  const { id } = req.params;

  try {
    // 1) Ticket var mı?
    const [[ticket]] = await pool.execute('SELECT id, status FROM tickets WHERE id = ?', [id]);
    if (!ticket) {
      return res.status(404).json({ error: 'ticket_not_found', message: 'Talep bulunamadı' });
    }

    // 2) Kapalı talepleri silmeye izin ver
    // if (['RESOLVED','CLOSED','CANCELLED'].includes(ticket.status)) {
    //   return res.status(409).json({ error: 'ticket_closed_or_resolved', message: 'Kapalı talepler silinemez' });
    // }

    // 3) Ticket'ı sil (CASCADE ile mesajlar da silinir)
    await pool.execute('DELETE FROM tickets WHERE id = ?', [id]);

    res.json({ ok: true, message: 'Talep başarıyla silindi' });
  } catch (error) {
    console.error('Ticket delete error:', error);
    res.status(500).json({ error: 'internal_server_error', message: error.message });
  }
});

/**
 * PUT /tickets/:id
 * DISPATCHER talebi düzenler
 */
router.put('/:id', auth(['dispatcher']), async (req, res) => {
  const { id } = req.params;
  const { subject, description, priority, category_id, subcategory_id, work_group_id } = req.body || {};

  try {
    // 1) Ticket var mı?
    const [[ticket]] = await pool.execute('SELECT id, status FROM tickets WHERE id = ?', [id]);
    if (!ticket) {
      return res.status(404).json({ error: 'ticket_not_found', message: 'Talep bulunamadı' });
    }

    // 2) Kapalı talepleri düzenlemeye izin ver
    // if (['RESOLVED','CLOSED','CANCELLED'].includes(ticket.status)) {
    //   return res.status(409).json({ error: 'ticket_closed_or_resolved', message: 'Kapalı talepler düzenlenemez' });
    // }

    // 3) Güncellenecek alanları hazırla
    const updateFields = [];
    const updateValues = [];
    
    if (subject !== undefined) {
      updateFields.push('subject = ?');
      updateValues.push(subject);
    }
    
    if (description !== undefined) {
      updateFields.push('description = ?');
      updateValues.push(description);
    }
    
    if (priority !== undefined && ['LOW', 'MEDIUM', 'HIGH'].includes(priority)) {
      updateFields.push('priority = ?');
      updateValues.push(priority);
    }
    
    if (category_id !== undefined) {
      updateFields.push('category_id = ?');
      updateValues.push(category_id);
    }
    
    if (subcategory_id !== undefined) {
      updateFields.push('subcategory_id = ?');
      updateValues.push(subcategory_id);
    }
    
    if (work_group_id !== undefined) {
      updateFields.push('work_group_id = ?');
      updateValues.push(work_group_id);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'no_fields_to_update', message: 'Güncellenecek alan bulunamadı' });
    }

    // 4) Güncelle
    updateValues.push(id);
    const updateSql = `UPDATE tickets SET ${updateFields.join(', ')} WHERE id = ?`;
    await pool.execute(updateSql, updateValues);

    res.json({ ok: true, message: 'Talep başarıyla güncellendi' });
  } catch (error) {
    console.error('Ticket update error:', error);
    res.status(500).json({ error: 'internal_server_error', message: error.message });
  }
});

/**
 * GET /tickets/test-table
 * Tablo yapısını test et
 */
router.get('/test-table', auth(), async (req, res) => {
  try {
    console.log('=== TABLO TEST BAŞLADI ===');
    
    // Tüm tabloları listele
    const [tables] = await pool.execute('SHOW TABLES');
    console.log('All tables:', tables);
    
    // ticket_messages tablosu var mı?
    const [messageTables] = await pool.execute('SHOW TABLES LIKE "ticket_messages"');
    console.log('Message tables found:', messageTables);
    
    if (messageTables.length > 0) {
      // Tablo varsa kolonları kontrol et
      const [columns] = await pool.execute('DESCRIBE ticket_messages');
      console.log('Message table columns:', columns);
      
      // Örnek veri var mı?
      const [sampleData] = await pool.execute('SELECT * FROM ticket_messages LIMIT 1');
      console.log('Sample data:', sampleData);
    }
    
    res.json({ 
      tables: tables, 
      messageTableExists: messageTables.length > 0,
      columns: messageTables.length > 0 ? await pool.execute('DESCRIBE ticket_messages') : []
    });
    
  } catch (error) {
    console.error('Table test error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /tickets/test-categories
 * Kategori sistemini test et
 */
router.get('/test-categories', auth(), async (req, res) => {
  try {
    console.log('=== KATEGORİ SİSTEMİ TEST BAŞLADI ===');
    
    // Tüm tabloları listele
    const [tables] = await pool.execute('SHOW TABLES');
    console.log('All tables:', tables);
    
    // Kategori tablolarını kontrol et
    const categoryTables = ['categories', 'subcategories', 'sub_subcategories'];
    const tableStatus = {};
    
    for (const tableName of categoryTables) {
      const [tableExists] = await pool.execute(`SHOW TABLES LIKE "${tableName}"`);
      tableStatus[tableName] = tableExists.length > 0;
      
      if (tableExists.length > 0) {
        // Tablo varsa kolonları ve veri sayısını kontrol et
        const [columns] = await pool.execute(`DESCRIBE ${tableName}`);
        const [count] = await pool.execute(`SELECT COUNT(*) as count FROM ${tableName}`);
        
        tableStatus[`${tableName}_columns`] = columns;
        tableStatus[`${tableName}_count`] = count[0].count;
        
        // Örnek veri
        const [sampleData] = await pool.execute(`SELECT * FROM ${tableName} LIMIT 3`);
        tableStatus[`${tableName}_sample`] = sampleData;
      }
    }
    
    console.log('Table status:', tableStatus);
    
    res.json({ 
      message: 'Kategori sistemi test edildi',
      tableStatus: tableStatus
    });
    
  } catch (error) {
    console.error('Category test error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /tickets/:id/messages
 * Bir talebe mesaj ekler
 */
router.post('/:id/messages', auth(), async (req, res) => {
  const { id } = req.params;
  const { content } = req.body || {};

  console.log('=== MESAJ GÖNDERME BAŞLADI ===');
  console.log('Ticket ID:', id);
  console.log('Content:', content);
  console.log('User ID:', req.user.id);

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'content_required' });
  }

  try {
    // Önce tablo yapısını kontrol et
    const [tables] = await pool.execute('SHOW TABLES LIKE "ticket_messages"');
    
    if (tables.length === 0) {
      console.log('ticket_messages tablosu yok, oluşturuluyor...');
      
      // Tabloyu oluştur
      await pool.execute(`
        CREATE TABLE ticket_messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ticket_id INT NOT NULL,
          sender_id INT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
          FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      
      console.log('Tablo oluşturuldu');
    } else {
      // Tablo varsa kolonları kontrol et
      const [columns] = await pool.execute('DESCRIBE ticket_messages');
      console.log('Mevcut kolonlar:', columns);
      
      // content kolonu var mı kontrol et
      const hasContentColumn = columns.some(col => col.Field === 'content');
      console.log('Content kolonu var mı:', hasContentColumn);
      
      if (!hasContentColumn) {
        console.log('Content kolonu ekleniyor...');
        await pool.execute('ALTER TABLE ticket_messages ADD COLUMN content TEXT AFTER sender_id');
        console.log('Content kolonu eklendi');
      }
    }

    // Ticket var mı kontrol et
    const [tickets] = await pool.execute('SELECT id FROM tickets WHERE id = ?', [id]);
    if (tickets.length === 0) {
      return res.status(404).json({ error: 'ticket_not_found' });
    }

    // Mesajı ekle
    const [result] = await pool.execute(`
      INSERT INTO ticket_messages (ticket_id, sender_id, content)
      VALUES (?, ?, ?)
    `, [id, req.user.id, content.trim()]);

    console.log('Message inserted, ID:', result.insertId);

    // Eklenen mesajı getir
    const [messages] = await pool.execute(`
      SELECT m.*, u.email AS sender_email, u.full_name AS sender_name
      FROM ticket_messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.id = ?
    `, [result.insertId]);

    console.log('=== MESAJ GÖNDERME BAŞARILI ===');
    res.json(messages[0]);
    
  } catch (error) {
    console.error('=== MESAJ GÖNDERME HATASI ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    
    res.status(500).json({ 
      error: 'internal_server_error', 
      message: error.message 
    });
  }
});

/**
 * GET /tickets/:id/messages
 * Bir talebe ait mesajları getirir
 */
router.get('/:id/messages', auth(), async (req, res) => {
  const { id } = req.params;

  try {
    // Mesajları email bilgisi ile getir
    const [messages] = await pool.execute(`
      SELECT m.*, u.email AS sender_email, u.full_name AS sender_name
      FROM ticket_messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.ticket_id = ?
      ORDER BY m.created_at ASC
    `, [id]);

    console.log('Messages loaded:', messages);
    res.json(messages);
  } catch (error) {
    console.error('Messages get error:', error);
    res.status(500).json({ error: 'internal_server_error', message: error.message });
  }
});

/**
 * GET /tickets/:id/check-permission
 * Test için yetki kontrolü
 */
router.get('/:id/check-permission', auth(['agent', 'admin', 'end_user']), async (req, res) => {
  const { id } = req.params;

  try {
    const [[ticket]] = await pool.execute(
      'SELECT id, status, created_by, assigned_to FROM tickets WHERE id = ?',
      [id]
    );
    
    if (!ticket) {
      return res.status(404).json({ error: 'ticket_not_found' });
    }

    const canUpdate = 
      req.user.role === 'admin' || 
      req.user.role === 'agent' || 
      parseInt(ticket.created_by) === parseInt(req.user.id) || 
      parseInt(ticket.assigned_to) === parseInt(req.user.id);

    res.json({
      ticket: ticket,
      user: {
        id: req.user.id,
        role: req.user.role
      },
      canUpdate: canUpdate,
      reason: canUpdate ? 'Permission granted' : 'Permission denied'
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /tickets/fix-categories
 * Kategori sistemini düzelt ve eksik verileri ekle
 */
router.get('/fix-categories', auth(['admin']), async (req, res) => {
  try {
    console.log('=== KATEGORİ SİSTEMİ DÜZELTİLİYOR ===');
    
    // 1. Kategorileri kontrol et ve ekle
    const [categories] = await pool.execute('SELECT * FROM categories');
    if (categories.length === 0) {
      await pool.execute(`
        INSERT INTO categories (name) VALUES 
        ('Bilgi Teknolojileri'),
        ('İnsan Kaynakları'),
        ('Muhasebe'),
        ('Satış'),
        ('Pazarlama'),
        ('Müşteri Hizmetleri')
      `);
      console.log('Ana kategoriler eklendi');
    }
    
    // 2. Alt kategorileri kontrol et ve ekle
    const [subcategories] = await pool.execute('SELECT * FROM subcategories');
    if (subcategories.length === 0) {
      await pool.execute(`
        INSERT INTO subcategories (name, category_id) VALUES 
        ('Teknik Destek', 1),
        ('Yazılım Sorunu', 1),
        ('Donanım Sorunu', 1),
        ('Ağ Sorunu', 1),
        ('Uygulama Sorunu', 1),
        ('Sistem Sorunu', 1),
        ('Güvenlik Sorunu', 1),
        ('Performans Sorunu', 1)
      `);
      console.log('Alt kategoriler eklendi');
    }
    
    // 3. Alt-alt kategorileri kontrol et ve ekle
    const [subsubcategories] = await pool.execute('SELECT * FROM sub_subcategories');
    if (subsubcategories.length === 0) {
      await pool.execute(`
        INSERT INTO sub_subcategories (name, subcategory_id) VALUES 
        -- Teknik Destek alt kategorileri
        ('Windows Sorunu', 1),
        ('Mac Sorunu', 1),
        ('Linux Sorunu', 1),
        ('Mobil Cihaz', 1),
        
        -- Yazılım Sorunu alt kategorileri
        ('Web Uygulaması', 2),
        ('Masaüstü Uygulama', 2),
        ('Veritabanı', 2),
        ('API Sorunu', 2),
        
        -- Donanım Sorunu alt kategorileri
        ('Sunucu', 3),
        ('Bilgisayar', 3),
        ('Yazıcı', 3),
        ('Tarayıcı', 3),
        
        -- Ağ Sorunu alt kategorileri
        ('Router', 4),
        ('Switch', 4),
        ('Modem', 4),
        ('WiFi', 4),
        
        -- Uygulama Sorunu alt kategorileri (ÖNEMLİ!)
        ('Web Tarayıcı', 5),
        ('Mobil Uygulama', 5),
        ('Masaüstü Program', 5),
        ('E-posta Uygulaması', 5),
        ('Ofis Uygulamaları', 5),
        ('Grafik Tasarım', 5),
        ('Video Düzenleme', 5),
        ('Oyun', 5),
        ('Antivirüs', 5),
        ('Yedekleme', 5),
        
        -- Sistem Sorunu alt kategorileri
        ('İşletim Sistemi', 6),
        ('Sürücü', 6),
        ('Servis', 6),
        ('Güncelleme', 6),
        
        -- Güvenlik Sorunu alt kategorileri
        ('Virüs', 7),
        ('Malware', 7),
        ('Spam', 7),
        ('Şifre', 7),
        
        -- Performans Sorunu alt kategorileri
        ('Yavaşlık', 8),
        ('Donma', 8),
        ('Çökme', 8),
        ('Bellek', 8)
      `);
      console.log('Alt-alt kategoriler eklendi');
    }
    
    // 4. Mevcut durumu raporla
    const [finalCategories] = await pool.execute('SELECT COUNT(*) as count FROM categories');
    const [finalSubcategories] = await pool.execute('SELECT COUNT(*) as count FROM subcategories');
    const [finalSubsubcategories] = await pool.execute('SELECT COUNT(*) as count FROM sub_subcategories');
    
    const report = {
      message: 'Kategori sistemi düzeltildi',
      categories: finalCategories[0].count,
      subcategories: finalSubcategories[0].count,
      subsubcategories: finalSubsubcategories[0].count,
      details: {
        categories: await pool.execute('SELECT * FROM categories'),
        subcategories: await pool.execute('SELECT * FROM subcategories'),
        subsubcategories: await pool.execute('SELECT * FROM sub_subcategories')
      }
    };
    
    console.log('Kategori sistemi düzeltildi:', report);
    res.json(report);
    
  } catch (error) {
    console.error('Kategori düzeltme hatası:', error);
    res.status(500).json({ error: 'internal_server_error', message: error.message });
  }
});

// Tablo oluşturma fonksiyonu
async function ensureMessagesTable() {
  try {
    console.log('=== TICKET_MESSAGES TABLOSU KONTROL EDİLİYOR ===');
    
    // Tablo var mı kontrol et
    const [tables] = await pool.execute('SHOW TABLES LIKE "ticket_messages"');
    
    if (tables.length === 0) {
      console.log('ticket_messages tablosu yok, oluşturuluyor...');
      
      await pool.execute(`
        CREATE TABLE ticket_messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ticket_id INT NOT NULL,
          sender_id INT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
          FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      
      console.log('ticket_messages tablosu başarıyla oluşturuldu');
    } else {
      console.log('ticket_messages tablosu zaten mevcut');
      
      // Kolonları kontrol et
      try {
        const [columns] = await pool.execute('DESCRIBE ticket_messages');
        console.log('Mevcut kolonlar:', columns);
      } catch (descError) {
        console.log('Kolon kontrol hatası:', descError.message);
      }
    }
  } catch (error) {
    console.error('Tablo kontrol/oluşturma hatası:', error);
  }
}

// Server başlangıcında tabloyu kontrol et
ensureMessagesTable();

module.exports = router;
