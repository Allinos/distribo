'use strict';
require('dotenv').config();
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const morgan = require('morgan');
const methodOverride = require('method-override');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { dbManager } = require('./utils/prisma');

// Routes
const authRoutes       = require('./routes/auth');
const activationRoutes = require('./routes/activation');
const dbSetupRoutes    = require('./routes/dbSetup');
const dashboardRoutes  = require('./routes/dashboard');
const productRoutes    = require('./routes/products');
const saleRoutes       = require('./routes/sales');
const expenseRoutes    = require('./routes/expenses');
const backupRoutes     = require('./routes/backup');
const customerRoutes   = require('./routes/customers');
const categoryRoutes   = require('./routes/categories');
const userRoutes       = require('./routes/users');
const settingRoutes    = require('./routes/settings');
const supplierRoutes   = require('./routes/suppliers');
const purchaseRoutes   = require('./routes/purchases');
const vehicleRoutes    = require('./routes/vehicles');
const warehouseRoutes  = require('./routes/warehouses');
const salesReportRoutes = require('./routes/salesReports');
const returnRoutes      = require('./routes/returns');
const writeoffRoutes    = require('./routes/writeoffs');
const batchRoutes       = require('./routes/batches');



const { isAuthenticated, isDbConfigured, isActivated } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure directories exist
['public/uploads', 'backups'].forEach(dir => {
  const p = path.join(__dirname, '..', dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// Auto-load saved DB config on startup
(async () => {
  const saved = dbManager.loadConfig();
  if (saved) {
    try { await dbManager.initializeDatabase(saved); console.log('✅ Database auto-connected.'); }
    catch (e) { console.warn('⚠️  Auto DB connect failed:', e.message); }
  }
})();

// Security
// app.use(helmet({
//   contentSecurityPolicy: {
//     directives: {
//       defaultSrc: ["'self'"],
//       styleSrc:   ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
//       scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
//       fontSrc:    ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
//       imgSrc:     ["'self'", "data:", "blob:"],
//     }
//   }
// }));

if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride('_method'));
app.use(fileUpload({ limits: { fileSize: 10 * 1024 * 1024 }, createParentPath: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(session({
  secret: process.env.SESSION_SECRET || 'erp-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: parseInt(process.env.SESSION_MAX_AGE) || 86400000 }
}));

app.use(flash());

app.use((req, res, next) => {
  res.locals.user        = req.session.user || null;
  res.locals.success     = req.flash('success');
  res.locals.error       = req.flash('error');
  res.locals.appName     = process.env.APP_NAME || 'ERP System';
  res.locals.currentPath = req.path;
  next();
});

// Public routes (no DB / auth required)
app.use('/db-setup',    dbSetupRoutes);
app.use('/activation',  activationRoutes);
app.use('/auth',        authRoutes);

// Protected routes (require DB + activation + authentication)
const protect = [isDbConfigured, isActivated, isAuthenticated];
app.use('/',            ...protect, dashboardRoutes);
app.use('/products',    ...protect, productRoutes);
app.use('/sales',       ...protect, saleRoutes);
app.use('/expenses',    ...protect, expenseRoutes);
app.use('/backup',      ...protect, backupRoutes);
app.use('/customers',   ...protect, customerRoutes);
app.use('/categories',  ...protect, categoryRoutes);
app.use('/users',       ...protect, userRoutes);
app.use('/settings',    ...protect, settingRoutes);
app.use('/suppliers',   ...protect, supplierRoutes);
app.use('/purchases',   ...protect, purchaseRoutes);
app.use('/vehicles',    ...protect, vehicleRoutes);
app.use('/warehouses',  ...protect, warehouseRoutes);
app.use('/sales-reports', ...protect, salesReportRoutes);
app.use('/returns',        ...protect, returnRoutes);
app.use('/writeoffs',      ...protect, writeoffRoutes);
app.use('/batches',        ...protect, batchRoutes);


// 404
app.use((req, res) => {
  res.status(404).render('pages/error', { title: '404', message: 'Page not found.', code: 404, layout: req.session.user ? 'layout' : false });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('pages/error', { title: '500', message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong.', code: 500, layout: req.session.user ? 'layout' : false });
});

// Auto backup cron
cron.schedule('0 2 * * *', async () => {
  try { const bs = require('./services/backupService'); await bs.createBackup('auto'); console.log('Auto backup done.'); }
  catch (e) { console.error('Auto backup failed:', e); }
});

const { initAutoBackup } = require('./controllers/settingController');
setTimeout(initAutoBackup, 5000);

app.listen(PORT, () => {
  console.log(`\n🚀 ERP Server running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
