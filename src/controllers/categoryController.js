'use strict';
const { getPrisma } = require('../utils/prisma');
exports.index = async (req, res) => {
  const prisma = await getPrisma();
  const categories = await prisma.category.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { products: true, expenses: true } } } });
  res.render('pages/categories/index', { title: 'Categories', categories });
};
exports.create = async (req, res) => {
  try { const prisma = await getPrisma(); await prisma.category.create({ data: { name: req.body.name } }); req.flash('success', 'Category created.'); }
  catch (err) { req.flash('error', err.code === 'P2002' ? 'Already exists.' : 'Failed.'); }
  res.redirect('/categories');
};
exports.update = async (req, res) => {
  try { const prisma = await getPrisma(); await prisma.category.update({ where: { id: parseInt(req.params.id) }, data: { name: req.body.name } }); req.flash('success', 'Updated.'); }
  catch (err) { req.flash('error', 'Failed to update.'); }
  res.redirect('/categories');
};
exports.delete = async (req, res) => {
  try { const prisma = await getPrisma(); await prisma.category.delete({ where: { id: parseInt(req.params.id) } }); req.flash('success', 'Deleted.'); }
  catch (err) { req.flash('error', 'Cannot delete category in use.'); }
  res.redirect('/categories');
};
