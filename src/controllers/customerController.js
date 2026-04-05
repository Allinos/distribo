'use strict';
const { getPrisma } = require('../utils/prisma');
exports.index = async (req, res) => {
  const page = parseInt(req.query.page) || 1; const limit = 15; const search = req.query.search || ''; const skip = (page - 1) * limit;
  const where = search ? { OR: [{ name: { contains: search } }, { email: { contains: search } }, { phone: { contains: search } }] } : {};
  try {
    const prisma = await getPrisma();
    const [customers, total] = await Promise.all([prisma.customer.findMany({ where, skip, take: limit, orderBy: { name: 'asc' } }), prisma.customer.count({ where })]);
    res.render('pages/customers/index', { title: 'Customers', customers, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, search });
  } catch (err) { req.flash('error', 'Failed.'); res.redirect('/'); }
};
exports.create = async (req, res) => {
  const { name, email, phone, address, gstin } = req.body;
  try { const prisma = await getPrisma(); await prisma.customer.create({ data: { name, email, phone, address, gstin } }); req.flash('success', 'Customer added.'); }
  catch (err) { req.flash('error', 'Failed to add customer.'); }
  res.redirect('/customers');
};
exports.update = async (req, res) => {
  const { name, email, phone, address, gstin } = req.body;
  try { const prisma = await getPrisma(); await prisma.customer.update({ where: { id: parseInt(req.params.id) }, data: { name, email, phone, address, gstin } }); req.flash('success', 'Updated.'); }
  catch (err) { req.flash('error', 'Failed.'); }
  res.redirect('/customers');
};
exports.delete = async (req, res) => {
  try { const prisma = await getPrisma(); await prisma.customer.delete({ where: { id: parseInt(req.params.id) } }); req.flash('success', 'Deleted.'); }
  catch (err) { req.flash('error', 'Cannot delete customer with sales.'); }
  res.redirect('/customers');
};
exports.apiList = async (req, res) => {
  const search = req.query.search || '';
  const prisma = await getPrisma();
  const customers = await prisma.customer.findMany({ where: search ? { name: { contains: search } } : {}, select: { id: true, name: true, email: true, phone: true }, take: 20 });
  res.json(customers);
};
