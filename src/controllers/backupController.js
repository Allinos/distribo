'use strict';
const { getPrisma } = require('../utils/prisma');
const backupService = require('../services/backupService');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

exports.index = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const backups = await prisma.backup.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    const dir = backupService.BACKUP_DIR;
    let files = [];
    if (fs.existsSync(dir)) {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'))
        .map(f => { const s = fs.statSync(path.join(dir, f)); return { name: f, size: s.size, mtime: s.mtime }; })
        .sort((a, b) => b.mtime - a.mtime);
    }
    res.render('pages/backup/index', { title: 'Backup & Restore', backups, files });
  } catch (err) { req.flash('error', 'Failed to load backup page.'); res.redirect('/'); }
};

exports.create = async (req, res) => {
  try { const result = await backupService.createBackup('manual'); req.flash('success', `Backup created: ${result.filename}`); }
  catch (err) { req.flash('error', `Backup failed: ${err.message}`); }
  res.redirect('/backup');
};

exports.download = (req, res) => {
  const filepath = path.join(backupService.BACKUP_DIR, req.params.filename);
  if (!fs.existsSync(filepath) || !req.params.filename.endsWith('.sql')) { req.flash('error', 'File not found.'); return res.redirect('/backup'); }
  res.download(filepath);
};

exports.delete = async (req, res) => {
  try {
    const filepath = path.join(backupService.BACKUP_DIR, req.params.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    const prisma = await getPrisma();
    await prisma.backup.deleteMany({ where: { filename: req.params.filename } });
    req.flash('success', 'Backup deleted.');
  } catch (err) { req.flash('error', 'Failed to delete backup.'); }
  res.redirect('/backup');
};

exports.restore = async (req, res) => {
  if (!req.files?.backupFile) { req.flash('error', 'No file uploaded.'); return res.redirect('/backup'); }
  const file = req.files.backupFile;
  if (!file.name.endsWith('.sql')) { req.flash('error', 'Only .sql files allowed.'); return res.redirect('/backup'); }
  const tmpPath = path.join(backupService.BACKUP_DIR, `restore_${Date.now()}.sql`);
  try {
    await file.mv(tmpPath);
    const dbUrl = process.env.DATABASE_URL || '';
    const match = dbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
    if (!match) throw new Error('Invalid DATABASE_URL');
    const [, user, password, host, port, database] = match;
    exec(`mysql -u${user} -p${password} -h${host} -P${port} ${database} < "${tmpPath}"`, (err, _, stderr) => {
      fs.unlinkSync(tmpPath);
      if (err) { req.flash('error', `Restore failed: ${stderr}`); } else { req.flash('success', 'Database restored successfully.'); }
      res.redirect('/backup');
    });
  } catch (err) { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); req.flash('error', `Restore failed: ${err.message}`); res.redirect('/backup'); }
};
