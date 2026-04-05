'use strict';
const { getPrisma } = require('../utils/prisma');

exports.index = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 15;
  const search = req.query.search || '';
  const category = req.query.category || '';
  const skip = (page - 1) * limit;
  const where = {
    isActive: true,
    ...(search && { OR: [{ name: { contains: search } }, { sku: { contains: search } }] }),
    ...(category && { categoryId: parseInt(category) })
  };
  try {
    const prisma = await getPrisma();
    const [products, total, categories] = await Promise.all([
      prisma.product.findMany({ where, include: { category: true }, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.product.count({ where }),
      prisma.category.findMany({ orderBy: { name: 'asc' } })
    ]);
    res.render('pages/products/index', {
      title: 'Products', products, categories,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      search, category
    });
  } catch (err) {
    console.error(err); req.flash('error', 'Failed to load products.'); res.redirect('/');
  }
};

exports.create = async (req, res) => {
  try {
    const { name, sku, categoryId, price, costPrice, tax, stock, minStock, unit } = req.body;
    const prisma = await getPrisma();
    const { boxUnit, pcsPerBox } = req.body;
    await prisma.product.create({ data: { name, sku, categoryId: parseInt(categoryId), price: parseFloat(price), costPrice: parseFloat(costPrice || 0), tax: parseFloat(tax || 0), stock: parseInt(stock || 0), minStock: parseInt(minStock || 5), unit: unit || 'pcs', boxUnit: boxUnit || null, pcsPerBox: pcsPerBox ? parseInt(pcsPerBox) : 1 } });
    req.flash('success', 'Product created successfully.');
  } catch (err) {
    req.flash('error', err.code === 'P2002' ? 'SKU already exists.' : 'Failed to create product.');
  }
  res.redirect('/products');
};

exports.update = async (req, res) => {
  try {
    const { name, sku, categoryId, price, costPrice, tax, stock, minStock, unit } = req.body;
    const prisma = await getPrisma();
    const { boxUnit, pcsPerBox } = req.body;
    await prisma.product.update({ where: { id: parseInt(req.params.id) }, data: { name, sku, categoryId: parseInt(categoryId), price: parseFloat(price), costPrice: parseFloat(costPrice || 0), tax: parseFloat(tax || 0), stock: parseInt(stock || 0), minStock: parseInt(minStock || 5), unit: unit || 'pcs', boxUnit: boxUnit || null, pcsPerBox: pcsPerBox ? parseInt(pcsPerBox) : 1 } });
    req.flash('success', 'Product updated.');
  } catch (err) { req.flash('error', 'Failed to update product.'); }
  res.redirect('/products');
};

exports.delete = async (req, res) => {
  try {
    const prisma = await getPrisma();
    await prisma.product.update({ where: { id: parseInt(req.params.id) }, data: { isActive: false } });
    req.flash('success', 'Product deleted.');
  } catch (err) { req.flash('error', 'Failed to delete product.'); }
  res.redirect('/products');
};

exports.apiList = async (req, res) => {
  const search = req.query.search || '';
  try {
    const prisma = await getPrisma();
    const products = await prisma.product.findMany({
      where: { isActive: true, stock: { gt: 0 }, ...(search && { OR: [{ name: { contains: search } }, { sku: { contains: search } }] }) },
      select: { id: true, name: true, sku: true, price: true, tax: true, stock: true, unit: true, boxUnit: true, pcsPerBox: true, costPrice: true },
      take: 20
    });
    res.json(products);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch products' }); }
};
