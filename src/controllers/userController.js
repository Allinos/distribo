'use strict';
const { getPrisma } = require('../utils/prisma');
const bcrypt = require('bcrypt');
exports.index = async (req, res) => {
  const prisma = await getPrisma();
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true } });
  res.render('pages/users/index', { title: 'Users', users });
};
exports.create = async (req, res) => {
  const { name, email, password, role } = req.body;
  try { const prisma = await getPrisma(); const hashed = await bcrypt.hash(password, 12); await prisma.user.create({ data: { name, email, password: hashed, role } }); req.flash('success', 'User created.'); }
  catch (err) { req.flash('error', err.code === 'P2002' ? 'Email exists.' : 'Failed.'); }
  res.redirect('/users');
};
exports.update = async (req, res) => {
  const { name, email, role, isActive } = req.body;
  try { const prisma = await getPrisma(); await prisma.user.update({ where: { id: parseInt(req.params.id) }, data: { name, email, role, isActive: isActive === 'on' } }); req.flash('success', 'Updated.'); }
  catch (err) { req.flash('error', 'Failed.'); }
  res.redirect('/users');
};
exports.resetPassword = async (req, res) => {
  try { const prisma = await getPrisma(); const hashed = await bcrypt.hash(req.body.password, 12); await prisma.user.update({ where: { id: parseInt(req.params.id) }, data: { password: hashed } }); req.flash('success', 'Password reset.'); }
  catch (err) { req.flash('error', 'Failed.'); }
  res.redirect('/users');
};
