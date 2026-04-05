'use strict';
/**
 * Prisma utility — delegates to dynamic dbManager.
 * All controllers use: const { getPrisma } = require('../utils/prisma')
 */
const dbManager = require('./dbManager');

/**
 * Async getter — preferred for all controllers.
 * Usage:  const prisma = await getPrisma();
 */
async function getPrisma() {
  return dbManager.getPrismaClient();
}

/**
 * Initialize DB with config and persist it.
 */
async function initDb(config) {
  const client = await dbManager.initializeDatabase(config);
  dbManager.saveConfig(config);
  return client;
}

module.exports = { getPrisma, initDb, dbManager };
