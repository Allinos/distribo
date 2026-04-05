'use strict';
const bcrypt = require('bcrypt');
const { getPrisma } = require('../utils/prisma');

exports.showLogin = (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('pages/auth/login', { title: 'Login', layout: false });
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    req.flash('error', 'Email and password are required.');
    return res.redirect('/auth/login');
  }
  try {
    const prisma = await getPrisma();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      req.flash('error', 'Invalid credentials or account disabled.');
      return res.redirect('/auth/login');
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      req.flash('error', 'Invalid email or password.');
      return res.redirect('/auth/login');
    }
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    req.flash('success', `Welcome back, ${user.name}!`);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Login failed. Please try again.');
    res.redirect('/auth/login');
  }
};

exports.logout = (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
};

exports.showProfile = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const user = await prisma.user.findUnique({
      where: { id: req.session.user.id },
      select: { id: true, name: true, email: true, role: true, createdAt: true }
    });
    res.render('pages/auth/profile', { title: 'My Profile', user });
  } catch (err) {
    req.flash('error', 'Failed to load profile.');
    res.redirect('/');
  }
};

exports.updateProfile = async (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body;
  try {
    const prisma = await getPrisma();
    const user = await prisma.user.findUnique({ where: { id: req.session.user.id } });
    const updateData = { name, email };
    if (newPassword) {
      const valid = await bcrypt.compare(currentPassword, user.password);
      if (!valid) { req.flash('error', 'Current password is incorrect.'); return res.redirect('/auth/profile'); }
      updateData.password = await bcrypt.hash(newPassword, 12);
    }
    const updated = await prisma.user.update({ where: { id: req.session.user.id }, data: updateData });
    req.session.user = { ...req.session.user, name: updated.name, email: updated.email };
    req.flash('success', 'Profile updated successfully.');
    res.redirect('/auth/profile');
  } catch (err) {
    req.flash('error', 'Failed to update profile.');
    res.redirect('/auth/profile');
  }
};
