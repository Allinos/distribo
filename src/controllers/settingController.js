'use strict';
const { getPrisma } = require('../utils/prisma');
exports.index = async (req, res) => {
  const prisma = await getPrisma();
  const settings = await prisma.setting.findMany();
  const settingMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
  res.render('pages/settings/index', { title: 'Settings', settings: settingMap });
};
exports.update = async (req, res) => {
  try {
    const prisma = await getPrisma();
    for (const [key, value] of Object.entries(req.body)) {
      await prisma.setting.upsert({ where: { key }, update: { value: String(value) }, create: { key, value: String(value) } });
    }
    req.flash('success', 'Settings saved.');
  } catch (err) { req.flash('error', 'Failed to save settings.'); }
  res.redirect('/settings');
};
