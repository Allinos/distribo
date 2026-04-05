'use strict';
const { getPrisma, dbManager } = require('../utils/prisma');

const isAuthenticated = (req, res, next) => {
  if (req.session.user) return next();
  req.flash('error', 'Please login to continue.');
  res.redirect('/auth/login');
};

const isDbConfigured = async (req, res, next) => {
  // DB-setup and activation routes are always allowed through
  if (req.path.startsWith('/db-setup') || req.path.startsWith('/activation')) {
    return next();
  }
  if (!dbManager.isConfigured()) {
    // Try to auto-load from saved config
    const saved = dbManager.loadConfig();
    if (saved) {
      try {
        await dbManager.initializeDatabase(saved);
        return next();
      } catch (err) {
        return res.redirect('/db-setup');
      }
    }
    return res.redirect('/db-setup');
  }
  next();
};

const isActivated = async (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/activation') || req.path.startsWith('/db-setup')) {
    return next();
  }
  try {
    const prisma = await getPrisma();
    const activation = await prisma.activation.findFirst({ where: { isActive: true } });
    if (!activation) return res.redirect('/activation');
    if (activation.expiresAt && new Date() > activation.expiresAt) {
      return res.redirect('/activation?expired=1');
    }
    next();
  } catch (err) {
    if (err.message.includes('No database configured')) {
      return res.redirect('/db-setup');
    }
    res.redirect('/activation');
  }
};

const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'ADMIN') return next();
  req.flash('error', 'Access denied. Admin only.');
  res.redirect('back');
};

const isManagerOrAbove = (req, res, next) => {
  const allowed = ['ADMIN', 'MANAGER'];
  if (req.session.user && allowed.includes(req.session.user.role)) return next();
  req.flash('error', 'Access denied. Manager or Admin only.');
  res.redirect('back');
};

module.exports = { isAuthenticated, isDbConfigured, isActivated, isAdmin, isManagerOrAbove };
