'use strict';
const { getPrisma } = require('../utils/prisma');

// List all batches with expiry alerts
exports.index = async (req, res) => {
  const search  = req.query.search  || '';
  const filter  = req.query.filter  || 'all'; // all | expiring | expired
  const now     = new Date();
  const in60days = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  try {
    const prisma = await getPrisma();

    const where = {
      quantity: { gt: 0 },
      product: {
        isActive: true,
        ...(search && { OR: [{ name: { contains: search } }, { sku: { contains: search } }] })
      },
      ...(filter === 'expiring' && { expiryDate: { gte: now, lte: in60days } }),
      ...(filter === 'expired'  && { expiryDate: { lt: now } })
    };

    const [batches, expiringCount, expiredCount] = await Promise.all([
      prisma.productBatch.findMany({
        where,
        include: { product: { include: { category: true } }, warehouse: { select: { name: true } } },
        orderBy: [{ expiryDate: 'asc' }, { createdAt: 'desc' }]
      }),
      prisma.productBatch.count({ where: { expiryDate: { gte: now, lte: in60days }, quantity: { gt: 0 } } }),
      prisma.productBatch.count({ where: { expiryDate: { lt: now }, quantity: { gt: 0 } } })
    ]);

    // Enrich each batch with days-to-expiry
    const enriched = batches.map(b => {
      let daysToExpiry = null;
      let expiryStatus = 'ok'; // ok | expiring | expired | none
      if (b.expiryDate) {
        daysToExpiry = Math.ceil((new Date(b.expiryDate) - now) / (1000 * 60 * 60 * 24));
        if (daysToExpiry < 0)    expiryStatus = 'expired';
        else if (daysToExpiry <= 60) expiryStatus = 'expiring';
      } else {
        expiryStatus = 'none';
      }
      return { ...b, daysToExpiry, expiryStatus };
    });

    res.render('pages/batches/index', {
      title: 'Product Batches & Expiry',
      batches: enriched,
      search, filter,
      expiringCount, expiredCount
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load batches.');
    res.redirect('/');
  }
};

exports.showCreate = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const [products, warehouses] = await Promise.all([
      prisma.product.findMany({ where: { isActive: true }, include: { category: true }, orderBy: { name: 'asc' } }),
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } })
    ]);
    res.render('pages/batches/create', { title: 'Add Product Batch', products, warehouses });
  } catch (err) {
    req.flash('error', 'Failed to load form.');
    res.redirect('/batches');
  }
};

exports.create = async (req, res) => {
  const { productId, warehouseId, batchNo, quantity, costPrice, mfgDate, expiryDate, notes } = req.body;
  if (!productId || !quantity) {
    req.flash('error', 'Product and quantity are required.');
    return res.redirect('/batches/new');
  }
  try {
    const prisma = await getPrisma();
    const qty = parseInt(quantity);
    const wId = warehouseId ? parseInt(warehouseId) : null;

    await prisma.$transaction(async (tx) => {
      // Create the batch record
      await tx.productBatch.create({
        data: {
          productId: parseInt(productId),
          warehouseId: wId,
          batchNo: batchNo || null,
          quantity: qty,
          costPrice: parseFloat(costPrice || 0),
          mfgDate:   mfgDate   ? new Date(mfgDate)   : null,
          expiryDate: expiryDate ? new Date(expiryDate) : null,
          notes: notes || null
        }
      });

      // Add to overall product stock
      await tx.product.update({ where: { id: parseInt(productId) }, data: { stock: { increment: qty } } });

      // Add to warehouse stock if specified
      if (wId) {
        const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: wId, productId: parseInt(productId) } } });
        if (ws) {
          await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: wId, productId: parseInt(productId) } }, data: { quantity: { increment: qty } } });
        } else {
          await tx.warehouseStock.create({ data: { warehouseId: wId, productId: parseInt(productId), quantity: qty } });
        }
      }
    });

    req.flash('success', 'Batch added and stock updated.');
    res.redirect('/batches');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to add batch.');
    res.redirect('/batches/new');
  }
};

// API: get expiry alerts count (used on dashboard)
exports.apiAlerts = async (req, res) => {
  const now      = new Date();
  const in60days = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const prisma   = await getPrisma();
  const [expiring, expired] = await Promise.all([
    prisma.productBatch.findMany({
      where: { expiryDate: { gte: now, lte: in60days }, quantity: { gt: 0 } },
      include: { product: { select: { name: true, sku: true } } },
      orderBy: { expiryDate: 'asc' },
      take: 10
    }),
    prisma.productBatch.count({ where: { expiryDate: { lt: now }, quantity: { gt: 0 } } })
  ]);
  res.json({ expiring, expiredCount: expired });
};
