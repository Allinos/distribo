'use strict';
const { initDb, dbManager } = require('../utils/prisma');
const { exec } = require('child_process');
const path = require('path');
const mysql = require('mysql2/promise');

exports.showSetup = (req, res) => {
  const dbType = req.query.dbType || 'local';
  const error = req.query.error ? decodeURIComponent(req.query.error) : '';
  // Load saved config (without password) to display current connection info
  const rawConfig = dbManager.getCurrentConfig() || dbManager.loadConfig();
  // Strip sensitive fields before passing to view
  let saved = null;
  if (rawConfig) {
    const { password, dbUrl, ...rest } = rawConfig;
    saved = rest;
  }
  res.render('pages/db-setup/index', {
    title: 'Database Setup',
    layout: false,
    dbType,
    error,
    saved,
    isConfigured: dbManager.isConfigured()
  });
};

exports.testConnection = async (req, res) => {
  const { host, port, user, password, database } = req.body;
  if (!host || !user || !database)
    return res.json({ success: false, message: 'Host, user, and database name are required.' });
  const result = await dbManager.testConnection({ host, port: port || '3306', user, password: password || '', database });
  res.json(result);
};

exports.setupCloud = async (req, res) => {
  const { dbUrl } = req.body;
  if (!dbUrl) return res.json({ success: false, message: 'Database URL is required for cloud setup.' });
  try {
    await initDb({ dbUrl });
    await runMigrations();
    return res.json({ success: true, message: 'Cloud database connected and ready.' });
  } catch (err) {
    return res.json({ success: false, message: 'Connection failed: ' + err.message });
  }
};

exports.setupLocal = async (req, res) => {
  const { host, port, user, password, database } = req.body;
  if (!host || !user || !database)
    return res.json({ success: false, message: 'Host, username, and database name are required.' });
  const config = { host, port: port || '3306', user, password: password || '', database };
  try {
    const rootConn = await mysql.createConnection({
      host, port: parseInt(port || 3306), user, password: password || '', multipleStatements: true,
    });
    await rootConn.execute(
      'CREATE DATABASE IF NOT EXISTS `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
    );
    await rootConn.end();
    await initDb(config);
    await runMigrations();
    return res.json({ success: true, message: 'Database created and schema applied successfully.' });
  } catch (err) {
    console.error('DB setup error:', err);
    return res.json({ success: false, message: 'Setup failed: ' + err.message });
  }
};

exports.resetConfig = async (req, res) => {
  dbManager.deleteConfig();
  await dbManager.destroyClient();
  req.session.destroy();
  res.redirect('/db-setup');
};

function runMigrations() {
  return new Promise((resolve) => {
    const config = dbManager.getCurrentConfig();
    if (!config) return resolve();
    const dbUrl = config.dbUrl || dbManager.buildDatabaseUrl(config);
    const env = { ...process.env, DATABASE_URL: dbUrl };
    const prismaBin = path.join(__dirname, '../../node_modules/.bin/prisma');
    exec('"' + prismaBin + '" db push --accept-data-loss', { env }, (err, stdout, stderr) => {
      if (err) console.warn('Migration warning (continuing):', err.message);
      console.log('Migration output:', stdout);
      resolve();
    });
  });
}
