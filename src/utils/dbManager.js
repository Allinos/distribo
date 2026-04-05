'use strict';
/**
 * Dynamic Database Manager
 * Supports per-client database switching at runtime.
 * Config stored in: <userData>/db-config.json (encrypted at rest)
 */

const { PrismaClient } = require('@prisma/client');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── Config paths ─────────────────────────────────────────────────────────────
const CONFIG_DIR = process.env.USER_DATA_PATH ||
  path.join(require('os').homedir(), '.erp-desktop');

const CONFIG_FILE = path.join(CONFIG_DIR, 'db-config.json');

// Simple XOR-based obfuscation key (use a real KMS in production)
const OBFUSCATION_KEY = process.env.DB_CONFIG_KEY || 'erp-config-secret-2024';

// ─── State ────────────────────────────────────────────────────────────────────
let _prismaInstance = null;
let _currentConfig = null;
let _isConnected = false;

// ─── Encryption helpers ───────────────────────────────────────────────────────
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(OBFUSCATION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decrypt(encryptedText) {
  const [ivHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const key = crypto.scryptSync(OBFUSCATION_KEY, 'salt', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ─── Config helpers ───────────────────────────────────────────────────────────
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Build a MySQL connection URL from config object
 */
function buildDatabaseUrl(config) {
  const { host, port, user, password, database } = config;
  const encodedPw = encodeURIComponent(password || '');
  return `mysql://${user}:${encodedPw}@${host}:${port || 3306}/${database}`;
}

/**
 * Save DB config encrypted to disk
 */
function saveConfig(config) {
  ensureConfigDir();
  const data = JSON.stringify(config);
  const encrypted = encrypt(data);
  fs.writeFileSync(CONFIG_FILE, encrypted, 'utf8');
}

/**
 * Load and decrypt DB config from disk
 * Returns null if not found or corrupted
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    const encrypted = fs.readFileSync(CONFIG_FILE, 'utf8');
    const data = decrypt(encrypted);
    return JSON.parse(data);
  } catch (err) {
    console.error('Failed to load DB config:', err.message);
    return null;
  }
}

/**
 * Delete stored config (used on deactivation/reset)
 */
function deleteConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
  }
  _currentConfig = null;
}

// ─── Prisma lifecycle ─────────────────────────────────────────────────────────
/**
 * Destroy current Prisma client gracefully
 */
async function destroyClient() {
  if (_prismaInstance) {
    try {
      await _prismaInstance.$disconnect();
    } catch (_) {}
    _prismaInstance = null;
    _isConnected = false;
    _currentConfig = null;
  }
}

/**
 * Initialize Prisma with a specific config.
 * @param {object} config - { host, port, user, password, database, dbUrl? }
 * @returns {PrismaClient}
 */
async function initializeDatabase(config) {
  // Destroy any existing instance
  await destroyClient();

  const dbUrl = config.dbUrl || buildDatabaseUrl(config);

  _prismaInstance = new PrismaClient({
    datasources: {
      db: { url: dbUrl },
    },
    log: process.env.NODE_ENV === 'development'
      ? ['warn', 'error']
      : ['error'],
  });

  // Test the connection
  await _prismaInstance.$connect();
  _isConnected = true;
  _currentConfig = { ...config, dbUrl };

  return _prismaInstance;
}

/**
 * Get the active Prisma client.
 * Tries to load from disk config if not initialized.
 * @throws if no DB is configured
 */
async function getPrismaClient() {
  if (_prismaInstance && _isConnected) {
    return _prismaInstance;
  }

  // Try to reload from saved config
  const savedConfig = loadConfig();
  if (savedConfig) {
    try {
      await initializeDatabase(savedConfig);
      return _prismaInstance;
    } catch (err) {
      _isConnected = false;
      throw new Error(`Database reconnection failed: ${err.message}`);
    }
  }

  throw new Error('No database configured. Please complete setup.');
}

/**
 * Test a connection without saving
 */
async function testConnection(config) {
  const dbUrl = config.dbUrl || buildDatabaseUrl(config);
  const testClient = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });
  try {
    await testClient.$connect();
    await testClient.$queryRaw`SELECT 1`;
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    try { await testClient.$disconnect(); } catch (_) {}
  }
}

/**
 * Check if DB is currently configured and reachable
 */
function isConfigured() {
  return _isConnected && _prismaInstance !== null;
}

/**
 * Get current config (without password)
 */
function getCurrentConfig() {
  if (!_currentConfig) return null;
  const { password, ...safe } = _currentConfig;
  return safe;
}

module.exports = {
  initializeDatabase,
  getPrismaClient,
  testConnection,
  saveConfig,
  loadConfig,
  deleteConfig,
  buildDatabaseUrl,
  isConfigured,
  getCurrentConfig,
  destroyClient,
};
