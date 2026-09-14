require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'troque-esta-chave-em-producao';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.DATABASE_URL) console.warn('DATABASE_URL não foi definida.');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10
});

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const q = (text, params = []) => pool.query(text, params);

function signUser(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '12h' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login necessário.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_err) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem executar esta ação.' });
  next();
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toItem(row) {
  const stock = Number(row.current_stock);
  const limit = Number(row.critical_limit);
  const avg = Number(row.average_daily_consumption);
  const days = avg > 0 ? Math.floor(stock / avg) : null;
  const expected = days === null ? null : new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  return {
    ...row,
    current_stock: stock,
    critical_limit: limit,
    average_daily_consumption: avg,
    low_stock: stock <= limit,
    urgent: stock <= limit,
    estimated_days_remaining: days,
    estimated_purchase_date: expected
  };
}

async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return;
  const result = await q('SELECT COUNT(*)::int AS count FROM users');
  if (result.rows[0].count === 0) {
    const hash = await bcrypt.hash(password, 12);
    await q('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)', ['Administrador', email.toLowerCase(), hash, 'admin']);
    console.log(`Administrador inicial criado: ${email}`);
  }
}

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const result = await q('SELECT * FROM users WHERE (email = $1 OR name = $1) AND active = TRUE', [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  res.json({ token: signUser(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

app.get('/api/me', auth, asyncRoute(async (req, res) => {
  const result = await q('SELECT id, name, email, role, active, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json(result.rows[0]);
}));

app.get('/api/stock', auth, asyncRoute(async (_req, res) => {
  const result = await q('SELECT * FROM inventory_items WHERE active = TRUE ORDER BY name');
  res.json(result.rows.map(toItem));
}));

app.post('/api/stock', auth, adminOnly, asyncRoute(async (req, res) => {
  const { name, category, specification_type, specification_value, unit_label, current_stock, critical_limit, average_daily_consumption, notes } = req.body;
  if (!name || !['liquid', 'tablet', 'unit'].includes(specification_type)) return res.status(400).json({ error: 'Nome e tipo de especificação são obrigatórios.' });
  const result = await q(`INSERT INTO inventory_items
    (name, category, specification_type, specification_value, unit_label, current_stock, critical_limit, average_daily_consumption, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [
    name.trim(), category || 'outro', specification_type, specification_value || null, unit_label || 'unidade',
    number(current_stock), number(critical_limit, 5), number(average_daily_consumption), notes || null
  ]);
  res.status(201).json(toItem(result.rows[0]));
}));

app.put('/api/stock/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const { name, category, specification_type, specification_value, unit_label, critical_limit, average_daily_consumption, notes } = req.body;
  const result = await q(`UPDATE inventory_items SET name=$1, category=$2, specification_type=$3, specification_value=$4,
    unit_label=$5, critical_limit=$6, average_daily_consumption=$7, notes=$8 WHERE id=$9 AND active=TRUE RETURNING *`, [
    name.trim(), category || 'outro', specification_type, specification_value || null, unit_label || 'unidade',
    number(critical_limit, 5), number(average_daily_consumption), notes || null, req.params.id
  ]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Item não encontrado.' });
  res.json(toItem(result.rows[0]));
}));

app.delete('/api/stock/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await q('UPDATE inventory_items SET active=FALSE WHERE id=$1 RETURNING id', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Item não encontrado.' });
  res.status(204).end();
}));

app.post('/api/stock/:id/movement', auth, adminOnly, asyncRoute(async (req, res) => {
  const { movement_type, quantity, reason } = req.body;
  const qty = number(quantity);
  if (!['entry', 'consumption', 'adjustment'].includes(movement_type) || qty <= 0) return res.status(400).json({ error: 'Movimentação inválida.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = await client.query('SELECT * FROM inventory_items WHERE id=$1 AND active=TRUE FOR UPDATE', [req.params.id]);
    if (!item.rows[0]) throw Object.assign(new Error('Item não encontrado.'), { status: 404 });
    const oldStock = Number(item.rows[0].current_stock);
    const newStock = movement_type === 'consumption' ? oldStock - qty : oldStock + qty;
    if (newStock < 0) throw Object.assign(new Error('O estoque não pode ficar negativo.'), { status: 400 });
    await client.query('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, req.params.id]);
    await client.query(`INSERT INTO stock_movements (item_id,user_id,movement_type,quantity,stock_after,reason)
      VALUES ($1,$2,$3,$4,$5,$6)`, [req.params.id, req.user.id, movement_type, qty, newStock, reason || null]);
    await client.query('COMMIT');
    res.json({ message: 'Movimentação registrada.', stock_after: newStock });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}));

app.get('/api/users', auth, adminOnly, asyncRoute(async (_req, res) => {
  const result = await q('SELECT id,name,email,role,active,created_at FROM users ORDER BY name');
  res.json(result.rows);
}));

app.post('/api/users', auth, adminOnly, asyncRoute(async (req, res) => {
  const { name, email, password, role = 'viewer' } = req.body;
  if (!name || !email || !password || !['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Nome, e-mail, senha e perfil são obrigatórios.' });
  const hash = await bcrypt.hash(password, 12);
  try {
    const result = await q('INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role,active', [name.trim(), email.trim().toLowerCase(), hash, role]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    throw err;
  }
}));

app.patch('/api/users/:id/status', auth, adminOnly, asyncRoute(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Você não pode desativar sua própria conta.' });
  const result = await q('UPDATE users SET active = NOT active WHERE id=$1 RETURNING id,name,email,role,active', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.json(result.rows[0]);
}));

app.get('/api/admin/backup', auth, adminOnly, asyncRoute(async (_req, res) => {
  const tables = {
    users: await q('SELECT id,name,email,password_hash,role,active,created_at,updated_at FROM users ORDER BY created_at'),
    inventory_items: await q('SELECT * FROM inventory_items ORDER BY created_at'),
    stock_movements: await q('SELECT * FROM stock_movements ORDER BY created_at'),
    purchases: await q('SELECT * FROM purchases ORDER BY created_at'),
    purchase_items: await q('SELECT * FROM purchase_items ORDER BY id'),
    attachments: await q('SELECT * FROM attachments ORDER BY created_at')
  };
  const backup = { format: 'care-stock-backup', version: 1, generated_at: new Date().toISOString() };
  for (const [name, result] of Object.entries(tables)) backup[name] = result.rows;
  res.set('Content-Disposition', `attachment; filename=care-stock-backup-${new Date().toISOString().slice(0,10)}.json`);
  res.json(backup);
}));

app.post('/api/admin/restore', auth, adminOnly, asyncRoute(async (req, res) => {
  const backup = req.body;
  const required = ['users', 'inventory_items', 'stock_movements', 'purchases', 'purchase_items', 'attachments'];
  if (!backup || backup.format !== 'care-stock-backup' || backup.version !== 1 || required.some((key) => !Array.isArray(backup[key]))) {
    return res.status(400).json({ error: 'Arquivo de backup inválido ou incompatível.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE attachments, purchase_items, purchases, stock_movements, inventory_items, users RESTART IDENTITY CASCADE');
    for (const u of backup.users) await client.query('INSERT INTO users (id,name,email,password_hash,role,active,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [u.id,u.name,u.email,u.password_hash,u.role,u.active,u.created_at,u.updated_at]);
    for (const i of backup.inventory_items) await client.query('INSERT INTO inventory_items (id,name,category,specification_type,specification_value,unit_label,current_stock,critical_limit,average_daily_consumption,notes,active,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [i.id,i.name,i.category,i.specification_type,i.specification_value,i.unit_label,i.current_stock,i.critical_limit,i.average_daily_consumption,i.notes,i.active,i.created_at,i.updated_at]);
    for (const p of backup.purchases) await client.query('INSERT INTO purchases (id,user_id,supplier,total_amount,purchased_at,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [p.id,p.user_id,p.supplier,p.total_amount,p.purchased_at,p.notes,p.created_at]);
    for (const pi of backup.purchase_items) await client.query('INSERT INTO purchase_items (id,purchase_id,item_id,item_name,quantity,unit_price) VALUES ($1,$2,$3,$4,$5,$6)', [pi.id,pi.purchase_id,pi.item_id,pi.item_name,pi.quantity,pi.unit_price]);
    for (const m of backup.stock_movements) await client.query('INSERT INTO stock_movements (id,item_id,user_id,movement_type,quantity,stock_after,reason,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [m.id,m.item_id,m.user_id,m.movement_type,m.quantity,m.stock_after,m.reason,m.created_at]);
    for (const a of backup.attachments) await client.query('INSERT INTO attachments (id,purchase_id,original_name,stored_name,mime_type,file_size,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [a.id,a.purchase_id,a.original_name,a.stored_name,a.mime_type,a.file_size,a.created_at]);
    await client.query('COMMIT');
    res.json({ message: 'Backup restaurado. Copie também a pasta uploads/ do backup manual para recuperar os arquivos.' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}));

app.get('/api/purchases', auth, asyncRoute(async (_req, res) => {
  const result = await q(`SELECT p.id,p.supplier,p.total_amount,p.purchased_at,p.notes,p.created_at,
    u.name AS created_by,
    COALESCE((SELECT json_agg(json_build_object('id',pi.id,'item_name',pi.item_name,'quantity',pi.quantity,'unit_price',pi.unit_price,'line_total',pi.line_total) ORDER BY pi.id) FROM purchase_items pi WHERE pi.purchase_id=p.id), '[]') AS items,
    COALESCE((SELECT json_agg(json_build_object('id',a.id,'original_name',a.original_name,'mime_type',a.mime_type) ORDER BY a.created_at) FROM attachments a WHERE a.purchase_id=p.id), '[]') AS attachments
    FROM purchases p JOIN users u ON u.id=p.user_id ORDER BY p.purchased_at DESC,p.created_at DESC`);
  res.json(result.rows);
}));

app.post('/api/purchases', auth, adminOnly, upload.single('receipt'), asyncRoute(async (req, res) => {
  let items;
  try { items = JSON.parse(req.body.items || '[]'); } catch (_err) { return res.status(400).json({ error: 'Itens da compra inválidos.' }); }
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Informe pelo menos um item comprado.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const total = items.reduce((sum, item) => sum + number(item.quantity) * number(item.unit_price), 0);
    const purchase = await client.query('INSERT INTO purchases (user_id,supplier,total_amount,purchased_at,notes) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.user.id, req.body.supplier || null, total, req.body.purchased_at || new Date().toISOString().slice(0,10), req.body.notes || null]);
    for (const item of items) {
      const quantity = number(item.quantity);
      if (!item.item_name || quantity <= 0) throw Object.assign(new Error('Item de compra inválido.'), { status: 400 });
      await client.query('INSERT INTO purchase_items (purchase_id,item_id,item_name,quantity,unit_price) VALUES ($1,$2,$3,$4,$5)', [purchase.rows[0].id, item.item_id || null, item.item_name, quantity, number(item.unit_price)]);
      if (item.item_id) {
        const stock = await client.query('UPDATE inventory_items SET current_stock=current_stock+$1 WHERE id=$2 AND active=TRUE RETURNING current_stock', [quantity, item.item_id]);
        if (stock.rows[0]) await client.query('INSERT INTO stock_movements (item_id,user_id,movement_type,quantity,stock_after,reason) VALUES ($1,$2,\'entry\',$3,$4,$5)', [item.item_id, req.user.id, quantity, stock.rows[0].current_stock, `Compra ${purchase.rows[0].id}`]);
      }
    }
    if (req.file) await client.query('INSERT INTO attachments (purchase_id,original_name,stored_name,mime_type,file_size) VALUES ($1,$2,$3,$4,$5)', [purchase.rows[0].id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size]);
    await client.query('COMMIT');
    res.status(201).json({ id: purchase.rows[0].id, message: 'Compra registrada e estoque atualizado.' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (req.file) fs.rmSync(path.join(UPLOAD_DIR, req.file.filename), { force: true });
    throw err;
  } finally { client.release(); }
}));

app.get('/api/attachments/:id', auth, asyncRoute(async (req, res) => {
  const result = await q('SELECT * FROM attachments WHERE id=$1', [req.params.id]);
  const attachment = result.rows[0];
  if (!attachment) return res.status(404).json({ error: 'Comprovante não encontrado.' });
  const filePath = path.join(UPLOAD_DIR, attachment.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado no servidor.' });
  res.set('Content-Type', attachment.mime_type).download(filePath, attachment.original_name);
}));

app.get('/api/dashboard', auth, asyncRoute(async (_req, res) => {
  const [consumption, spending, evolution] = await Promise.all([
    q(`SELECT i.name, COALESCE(SUM(m.quantity) FILTER (WHERE m.movement_type='consumption'),0) AS consumed
       FROM inventory_items i LEFT JOIN stock_movements m ON m.item_id=i.id AND m.created_at >= NOW()-INTERVAL '30 days'
       WHERE i.active=TRUE GROUP BY i.id ORDER BY consumed DESC`),
    q(`SELECT purchased_at::text AS date, SUM(total_amount) AS total FROM purchases WHERE purchased_at >= CURRENT_DATE-30 GROUP BY purchased_at ORDER BY purchased_at`),
    q(`SELECT date_trunc('day', created_at)::date::text AS date, SUM(CASE WHEN movement_type='entry' THEN quantity ELSE -quantity END) AS net_change
       FROM stock_movements WHERE created_at >= NOW()-INTERVAL '30 days' GROUP BY 1 ORDER BY 1`)
  ]);
  res.json({ consumption: consumption.rows, spending: spending.rows, evolution: evolution.rows });
}));

app.get('/api/report/today', auth, asyncRoute(async (_req, res) => {
  const result = await q(`SELECT p.id,p.supplier,p.total_amount,p.purchased_at,COALESCE(json_agg(json_build_object('item_name',pi.item_name,'quantity',pi.quantity,'unit_price',pi.unit_price)) FILTER (WHERE pi.id IS NOT NULL),'[]') items
    FROM purchases p LEFT JOIN purchase_items pi ON pi.purchase_id=p.id WHERE p.purchased_at=CURRENT_DATE GROUP BY p.id ORDER BY p.created_at`);
  const total = result.rows.reduce((sum, row) => sum + Number(row.total_amount), 0);
  const lines = [`*Relatório de cuidados — ${new Date().toLocaleDateString('pt-BR')}*`, '', `Total comprado hoje: *R$ ${total.toFixed(2).replace('.', ',')}*`];
  result.rows.forEach((p) => { lines.push(`\n• ${p.supplier || 'Compra'} — R$ ${Number(p.total_amount).toFixed(2).replace('.', ',')}`); p.items.forEach((i) => lines.push(`  - ${i.item_name}: ${i.quantity} unidade(s)`)); });
  res.json({ text: lines.join('\n') });
}));

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof multer.MulterError || err.message === 'Unexpected field') return res.status(400).json({ error: 'Falha no upload. Use PDF, JPG, PNG ou WEBP de até 10 MB.' });
  res.status(err.status || 500).json({ error: err.message || 'Erro interno do servidor.' });
});

(async () => {
  try {
    await pool.query('SELECT 1');
    await bootstrapAdmin();
    app.listen(PORT, '0.0.0.0', () => console.log(`Care Stock rodando em http://localhost:${PORT}`));
  } catch (err) {
    console.error('Não foi possível conectar ao Postgres:', err.message);
    process.exit(1);
  }
})();
