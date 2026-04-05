'use strict';
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { dbManager } = require('../utils/prisma');

const BACKUP_DIR = path.join(__dirname, '../../backups');

const createBackup = (triggeredBy = 'manual') => {
  return new Promise(async (resolve, reject) => {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // Get DB URL from dynamic manager or env fallback
    const config = dbManager.getCurrentConfig();
    const dbUrl = config?.dbUrl || process.env.DATABASE_URL;

    if (!dbUrl) return reject(new Error('No database configured'));

    const match = dbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
    if (!match) return reject(new Error('Invalid DATABASE_URL format'));

    const [, user, password, host, port, database] = match;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup_${triggeredBy}_${timestamp}.sql`;
    const filepath = path.join(BACKUP_DIR, filename);

    const cmd = `mysqldump -u${user} -p${password} -h${host} -P${port} ${database} > "${filepath}"`;

    exec(cmd, async (err, stdout, stderr) => {
      if (err) { console.error('Backup error:', stderr); return reject(new Error(`Backup failed: ${stderr}`)); }
      const stats = fs.statSync(filepath);
      try {
        const { getPrisma } = require('../utils/prisma');
        const prisma = await getPrisma();
        await prisma.backup.create({ data: { filename, size: stats.size, status: 'completed' } });
      } catch (_) {}
      resolve({ filename, size: stats.size, path: filepath });
    });
  });
};

module.exports = { createBackup, BACKUP_DIR };
