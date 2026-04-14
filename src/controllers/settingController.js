'use strict';
const { getPrisma } = require('../utils/prisma');
const path = require('path');
const fs   = require('fs');

exports.index = async (req, res) => {
  try {
    const prisma   = await getPrisma();
    const settings = await prisma.setting.findMany();
    const sm       = Object.fromEntries(settings.map(s => [s.key, s.value]));
    res.render('pages/settings/index', { title: 'Settings', settings: sm });
  } catch (err) {
    req.flash('error', 'Failed to load settings.');
    res.redirect('/');
  }
};

exports.update = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const allowed = [
      'company_name', 'company_address', 'company_phone', 'company_email',
      'gstin', 'currency', 'invoice_prefix', 'tax_rate',
      'auto_backup_enabled', 'auto_backup_interval_hours', 'auto_backup_path',
      'low_stock_alert', 'expiry_alert_days', 'footer_note'
    ];
    for (const key of allowed) {
      const value = req.body[key] !== undefined ? String(req.body[key]) : '';
      await prisma.setting.upsert({
        where:  { key },
        update: { value },
        create: { key, value }
      });
    }
    // If auto backup just enabled, schedule it
    if (req.body.auto_backup_enabled === 'true') {
      scheduleAutoBackup(parseInt(req.body.auto_backup_interval_hours) || 24);
    }
    req.flash('success', 'Settings saved.');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save settings.');
  }
  res.redirect('/settings');
};

// ── Auto Backup Scheduler ─────────────────────────────────────────────────────
let backupTimer = null;

async function runAutoBackup() {
  try {
    const prisma   = await getPrisma();
    const settings = await prisma.setting.findMany();
    const sm       = Object.fromEntries(settings.map(s => [s.key, s.value]));

    if (sm.auto_backup_enabled !== 'true') return;

    // Use configured path or default to app data dir
    const backupDir = sm.auto_backup_path
      ? sm.auto_backup_path
      : path.join(process.env.APPDATA || process.env.HOME || '.', 'erp-backups');

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename   = `auto-backup-${timestamp}.json`;
    const backupPath = path.join(backupDir, filename);

    // Export all key data as JSON
    const [products, customers, suppliers, sales, purchases, expenses] = await Promise.all([
      prisma.product.findMany({ include: { category: true } }),
      prisma.customer.findMany(),
      prisma.supplier.findMany(),
      prisma.sale.findMany({ include: { items: true, payments: true } }),
      prisma.purchase.findMany({ include: { items: true } }),
      prisma.expense.findMany()
    ]);

    const backup = {
      version:   '1.0',
      timestamp: new Date().toISOString(),
      type:      'auto',
      data:      { products, customers, suppliers, sales, purchases, expenses }
    };

    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

    // Record in DB
    const stats = fs.statSync(backupPath);
    await prisma.backup.create({
      data: {
        filename: `auto-backup-${timestamp}.json`,
        size:     stats.size,
        status:   'completed'
      }
    });

    // Keep only last 10 auto backups (cleanup)
    const autoFiles = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('auto-backup-'))
      .sort()
      .reverse();
    if (autoFiles.length > 10) {
      autoFiles.slice(10).forEach(f => {
        try { fs.unlinkSync(path.join(backupDir, f)); } catch {}
      });
    }

    console.log(`[AutoBackup] Saved: ${backupPath}`);
  } catch (err) {
    console.error('[AutoBackup] Failed:', err.message);
  }
}

function scheduleAutoBackup(intervalHours = 24) {
  if (backupTimer) clearInterval(backupTimer);
  const ms = intervalHours * 60 * 60 * 1000;
  backupTimer = setInterval(runAutoBackup, ms);
  console.log(`[AutoBackup] Scheduled every ${intervalHours}h`);
}

// Start auto-backup on app boot if enabled
async function initAutoBackup() {
  try {
    const prisma   = await getPrisma();
    const settings = await prisma.setting.findMany();
    const sm       = Object.fromEntries(settings.map(s => [s.key, s.value]));
    if (sm.auto_backup_enabled === 'true') {
      scheduleAutoBackup(parseInt(sm.auto_backup_interval_hours) || 24);
    }
  } catch (err) {
    console.log('[AutoBackup] Init skipped (DB not ready yet)');
  }
}

// Manual trigger endpoint
exports.runBackupNow = async (req, res) => {
  try {
    await runAutoBackup();
    res.json({ success: true, message: 'Backup completed successfully.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
};

exports.initAutoBackup = initAutoBackup;
exports.scheduleAutoBackup = scheduleAutoBackup;
