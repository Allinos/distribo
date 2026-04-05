'use strict';
const { getPrisma, initDb, dbManager } = require('../utils/prisma');

exports.showActivation = async (req, res) => {
  const expired = req.query.expired === '1';
  let activation = null;
  try {
    const prisma = await getPrisma();
    activation = await prisma.activation.findFirst({ where: { isActive: true } });
  } catch (e) {}

  res.render('pages/activation', {
    title: 'Software Activation',
    layout: false,
    expired,
    activation
  });
};

exports.activate = async (req, res) => {
  const { applicationId, licenseKey } = req.body;
  if (!applicationId || !licenseKey) {
    return res.json({ success: false, message: 'Application ID and License Key are required.' });
  }

  const demoValid = licenseKey === 'DEMO-LICENSE-KEY' ||
    /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(licenseKey);

  if (!demoValid) {
    return res.json({ success: false, message: 'Invalid license key. Please check and try again.' });
  }

  try {
    const prisma = await getPrisma();
    const existing = await prisma.activation.findUnique({ where: { applicationId } });
    const data = {
      licenseKey,
      isActive: true,
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    };
    if (existing) {
      await prisma.activation.update({ where: { applicationId }, data });
    } else {
      await prisma.activation.create({ data: { applicationId, ...data } });
    }
    return res.json({ success: true, message: 'Application activated successfully!' });
  } catch (err) {
    console.error('Activation error:', err);
    return res.json({ success: false, message: 'Activation failed. Please check your database connection.' });
  }
};

exports.deactivate = async (req, res) => {
  try {
    const prisma = await getPrisma();
    await prisma.activation.updateMany({ data: { isActive: false } });
    req.session.destroy();
    res.redirect('/activation');
  } catch (err) {
    req.flash('error', 'Failed to deactivate.');
    res.redirect('/settings');
  }
};
