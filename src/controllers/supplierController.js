'use strict';
const { getPrisma } = require('../utils/prisma');

exports.index = async (req, res) => {
  const page = parseInt(req.query.page) || 1, limit = 15;
  const search = req.query.search || '';
  const skip = (page - 1) * limit;
  const where = search ? { OR: [{ name: { contains: search } }, { phone: { contains: search } }, { gstin: { contains: search } }] } : {};
  try {
    const prisma = await getPrisma();
    const [suppliers, total] = await Promise.all([
      prisma.supplier.findMany({ where, skip, take: limit, orderBy: { name: 'asc' }, include: { _count: { select: { purchases: true } } } }),
      prisma.supplier.count({ where })
    ]);
    res.render('pages/suppliers/index', {
      title: 'Suppliers', suppliers,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      search
    });
  } catch (err) { console.error(err); req.flash('error', 'Failed to load suppliers.'); res.redirect('/'); }
};

exports.create = async (req, res) => {
  const { name, phone, email, gstin, address } = req.body;
  try {
    const prisma = await getPrisma();
    await prisma.supplier.create({ data: { name, phone, email, gstin, address } });
    req.flash('success', 'Supplier added.');
  } catch (err) { req.flash('error', 'Failed to add supplier.'); }
  res.redirect('/suppliers');
};

exports.update = async (req, res) => {
  const { name, phone, email, gstin, address } = req.body;
  try {
    const prisma = await getPrisma();
    await prisma.supplier.update({ where: { id: parseInt(req.params.id) }, data: { name, phone, email, gstin, address } });
    req.flash('success', 'Supplier updated.');
  } catch (err) { req.flash('error', 'Failed to update.'); }
  res.redirect('/suppliers');
};

exports.delete = async (req, res) => {
  try {
    const prisma = await getPrisma();
    await prisma.supplier.update({ where: { id: parseInt(req.params.id) }, data: { isActive: false } });
    req.flash('success', 'Supplier deactivated.');
  } catch (err) { req.flash('error', 'Cannot delete supplier with purchases.'); }
  res.redirect('/suppliers');
};

exports.apiList = async (req, res) => {
  const search = req.query.search || '';
  const prisma = await getPrisma();
  const suppliers = await prisma.supplier.findMany({
    where: { isActive: true, ...(search && { name: { contains: search } }) },
    select: { id: true, name: true, phone: true, gstin: true }, take: 20
  });
  res.json(suppliers);
};
