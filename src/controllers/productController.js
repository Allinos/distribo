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
    const { name, sku, categoryId, price, costPrice, tax, stock, minStock, unit, boxUnit, pcsPerBox } = req.body;
    const prisma = await getPrisma();
    // FIX: avgCostPrice = costPrice on first create (not 0)
    const cp = parseFloat(costPrice || 0);
    await prisma.product.create({
      data: {
        name, sku,
        categoryId:   parseInt(categoryId),
        price:        parseFloat(price),
        costPrice:    cp,
        avgCostPrice: cp,          // ← FIX: was missing, caused "0.00" display
        tax:          parseFloat(tax || 0),
        stock:        parseInt(stock || 0),
        minStock:     parseInt(minStock || 5),
        unit:         unit || 'pcs',
        boxUnit:      boxUnit || null,
        pcsPerBox:    pcsPerBox ? parseInt(pcsPerBox) : 1
      }
    });
    req.flash('success', 'Product created successfully.');
  } catch (err) {
    req.flash('error', err.code === 'P2002' ? 'SKU already exists.' : 'Failed to create product.');
  }
  res.redirect('/products');
};

exports.update = async (req, res) => {
  try {
    const { name, sku, categoryId, price, costPrice, tax, stock, minStock, unit, boxUnit, pcsPerBox } = req.body;
    const prisma = await getPrisma();
    const cpU = parseFloat(costPrice || 0);
    // If product has zero stock, reset avgCostPrice to new costPrice
    const existing = await prisma.product.findUnique({ where: { id: parseInt(req.params.id) }, select: { stock: true, avgCostPrice: true } });
    const newAvgCost = existing && existing.stock === 0 ? cpU : (existing ? parseFloat(existing.avgCostPrice) : cpU);
    await prisma.product.update({
      where: { id: parseInt(req.params.id) },
      data: {
        name, sku,
        categoryId:   parseInt(categoryId),
        price:        parseFloat(price),
        costPrice:    cpU,
        avgCostPrice: newAvgCost,
        tax:          parseFloat(tax || 0),
        stock:        parseInt(stock || 0),
        minStock:     parseInt(minStock || 5),
        unit:         unit || 'pcs',
        boxUnit:      boxUnit || null,
        pcsPerBox:    pcsPerBox ? parseInt(pcsPerBox) : 1
      }
    });
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

// General product list API (no warehouse filter)
exports.apiList = async (req, res) => {
  const search = req.query.search || '';
  try {
    const prisma = await getPrisma();
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        stock: { gt: 0 },
        ...(search && { OR: [{ name: { contains: search } }, { sku: { contains: search } }] })
      },
      select: { id: true, name: true, sku: true, price: true, tax: true, stock: true, unit: true, boxUnit: true, pcsPerBox: true, costPrice: true, avgCostPrice: true },
      take: 20
    });
    res.json(products);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch products' }); }
};

// Warehouse-specific product list for POS grid
exports.apiListForWarehouse = async (req, res) => {
  const warehouseId = parseInt(req.query.warehouseId);
  const search = req.query.search || '';
  if (!warehouseId) return exports.apiList(req, res);
  try {
    const prisma = await getPrisma();
    const stocks = await prisma.warehouseStock.findMany({
      where: {
        warehouseId,
        quantity: { gt: 0 },
        product: {
          isActive: true,
          ...(search && { OR: [{ name: { contains: search } }, { sku: { contains: search } }] })
        }
      },
      include: {
        product: {
          select: {
            id: true, name: true, sku: true, price: true, tax: true,
            unit: true, avgCostPrice: true, costPrice: true,
            category: { select: { name: true } }
          }
        }
      },
      take: 100,
      orderBy: { product: { name: 'asc' } }
    });
    res.json(stocks.map(s => ({
      ...s.product,
      stock: s.quantity,
      categoryName: s.product.category?.name
    })));
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
};
