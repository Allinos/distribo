'use strict';
const { getPrisma } = require('../utils/prisma');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Upsert warehouse stock — add qty if positive, subtract if negative */
async function adjustWarehouseStock(tx, warehouseId, productId, delta) {
  const existing = await tx.warehouseStock.findUnique({
    where: { warehouseId_productId: { warehouseId, productId } }
  });
  if (existing) {
    return tx.warehouseStock.update({
      where: { warehouseId_productId: { warehouseId, productId } },
      data: { quantity: { increment: delta } }
    });
  }
  return tx.warehouseStock.create({
    data: { warehouseId, productId, quantity: Math.max(0, delta) }
  });
}

// ─── Warehouse CRUD ───────────────────────────────────────────────────────────

exports.index = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const warehouses = await prisma.warehouse.findMany({
      where: { isActive: true },
      include: {
        _count: { select: { stocks: true, sales: true } },
        stocks: { include: { product: true } }
      },
      orderBy: { isDefault: 'desc' }
    });

    // Total stock value per warehouse
    const warehousesWithValue = warehouses.map(w => {
      const stockValue = w.stocks.reduce((sum, s) => {
        return sum + (s.quantity * parseFloat(s.product.price));
      }, 0);
      return { ...w, stockValue };
    });

    res.render('pages/warehouses/index', {
      title: 'Warehouses',
      warehouses: warehousesWithValue
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load warehouses.');
    res.redirect('/');
  }
};

exports.create = async (req, res) => {
  const { name, location, description, isDefault } = req.body;
  try {
    const prisma = await getPrisma();
    await prisma.$transaction(async (tx) => {
      if (isDefault === 'on') {
        await tx.warehouse.updateMany({ data: { isDefault: false } });
      }
      await tx.warehouse.create({
        data: { name, location, description, isDefault: isDefault === 'on' }
      });
    });
    req.flash('success', 'Warehouse created.');
  } catch (err) {
    req.flash('error', 'Failed to create warehouse.');
    console.error(err);
  }
  res.redirect('/warehouses');
};

exports.update = async (req, res) => {
  const { name, location, description, isDefault } = req.body;
  const id = parseInt(req.params.id);
  try {
    const prisma = await getPrisma();
    await prisma.$transaction(async (tx) => {
      if (isDefault === 'on') {
        await tx.warehouse.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
      }
      await tx.warehouse.update({
        where: { id },
        data: { name, location, description, isDefault: isDefault === 'on' }
      });
    });
    req.flash('success', 'Warehouse updated.');
  } catch (err) {
    req.flash('error', 'Failed to update warehouse.');
  }
  res.redirect('/warehouses');
};

exports.delete = async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const prisma = await getPrisma();
    const w = await prisma.warehouse.findUnique({ where: { id }, include: { _count: { select: { sales: true } } } });
    if (w.isDefault) {
      req.flash('error', 'Cannot delete the default warehouse. Set another as default first.');
      return res.redirect('/warehouses');
    }
    await prisma.warehouse.update({ where: { id }, data: { isActive: false } });
    req.flash('success', 'Warehouse deactivated.');
  } catch (err) {
    req.flash('error', 'Failed to delete warehouse.');
  }
  res.redirect('/warehouses');
};

// ─── Stock View ───────────────────────────────────────────────────────────────

exports.showStock = async (req, res) => {
  const id = parseInt(req.params.id);
  const search = req.query.search || '';
  const category = req.query.category || '';
  try {
    const prisma = await getPrisma();
    const [warehouse, warehouses, categories] = await Promise.all([
      prisma.warehouse.findUnique({
        where: { id },
        include: {
          stocks: {
            where: {
              product: {
                isActive: true,
                ...(search && { OR: [{ name: { contains: search } }, { sku: { contains: search } }] }),
                ...(category && { categoryId: parseInt(category) })
              }
            },
            include: { product: { include: { category: true } } },
            orderBy: { product: { name: 'asc' } }
          }
        }
      }),
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } }),
      prisma.category.findMany({ orderBy: { name: 'asc' } })
    ]);

    if (!warehouse) {
      req.flash('error', 'Warehouse not found.');
      return res.redirect('/warehouses');
    }

    // Also include products with zero stock in this warehouse
    const allProducts = await prisma.product.findMany({
      where: {
        isActive: true,
        ...(search && { OR: [{ name: { contains: search } }, { sku: { contains: search } }] }),
        ...(category && { categoryId: parseInt(category) })
      },
      include: { category: true }
    });

    const stockMap = Object.fromEntries(warehouse.stocks.map(s => [s.productId, s.quantity]));
    const stockRows = allProducts.map(p => ({
      product: p,
      quantity: stockMap[p.id] || 0,
      productId: p.id
    }));

    res.render('pages/warehouses/stock', {
      title: `Stock — ${warehouse.name}`,
      warehouse,
      warehouses,
      stockRows,
      search,
      categories,
      category
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load stock.');
    res.redirect('/warehouses');
  }
};

// Manually adjust stock for a product in a warehouse
exports.adjustStock = async (req, res) => {
  const warehouseId = parseInt(req.params.id);
  const { productId, quantity, mode } = req.body; // mode: 'set' | 'add' | 'subtract'
  const qty = parseInt(quantity);
  try {
    const prisma = await getPrisma();
    await prisma.$transaction(async (tx) => {
      const existing = await tx.warehouseStock.findUnique({
        where: { warehouseId_productId: { warehouseId, productId: parseInt(productId) } }
      });
      let newQty;
      const currentQty = existing ? existing.quantity : 0;
      if (mode === 'set')      newQty = qty;
      else if (mode === 'add') newQty = currentQty + qty;
      else                     newQty = Math.max(0, currentQty - qty);

      await tx.warehouseStock.upsert({
        where: { warehouseId_productId: { warehouseId, productId: parseInt(productId) } },
        update: { quantity: newQty },
        create: { warehouseId, productId: parseInt(productId), quantity: newQty }
      });

      // Keep product.stock in sync (total across all warehouses)
      const allStocks = await tx.warehouseStock.findMany({ where: { productId: parseInt(productId) } });
      const totalStock = allStocks.reduce((sum, s) => sum + s.quantity, 0);
      await tx.product.update({ where: { id: parseInt(productId) }, data: { stock: totalStock } });
    });
    req.flash('success', 'Stock adjusted successfully.');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to adjust stock.');
  }
  res.redirect(`/warehouses/${warehouseId}/stock`);
};

// ─── Stock Transfer ───────────────────────────────────────────────────────────

exports.showTransfer = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const [warehouses, transfers] = await Promise.all([
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } }),
      prisma.stockTransfer.findMany({
        include: {
          fromWarehouse: true,
          toWarehouse: true,
          items: { include: { product: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: 30
      })
    ]);
    res.render('pages/warehouses/transfer', {
      title: 'Stock Transfer',
      warehouses,
      transfers
    });
  } catch (err) {
    req.flash('error', 'Failed to load transfer page.');
    res.redirect('/warehouses');
  }
};

exports.createTransfer = async (req, res) => {
  const { fromWarehouseId, toWarehouseId, notes, items } = req.body;
  if (!fromWarehouseId || !toWarehouseId)
    return res.json({ success: false, message: 'Select both source and destination warehouses.' });
  if (fromWarehouseId === toWarehouseId)
    return res.json({ success: false, message: 'Source and destination warehouses must be different.' });
  if (!items || !Array.isArray(items) || items.length === 0)
    return res.json({ success: false, message: 'Add at least one product to transfer.' });

  try {
    const prisma = await getPrisma();
    const fromId = parseInt(fromWarehouseId);
    const toId   = parseInt(toWarehouseId);

    // Validate all items have enough stock before starting transaction
    for (const item of items) {
      const ws = await prisma.warehouseStock.findUnique({
        where: { warehouseId_productId: { warehouseId: fromId, productId: parseInt(item.productId) } }
      });
      const available = ws ? ws.quantity : 0;
      if (available < parseInt(item.quantity)) {
        const product = await prisma.product.findUnique({ where: { id: parseInt(item.productId) }, select: { name: true } });
        return res.json({ success: false, message: `Insufficient stock for "${product.name}". Available in source: ${available}` });
      }
    }

    const count = await prisma.stockTransfer.count();
    const transferNo = `TRF-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

    await prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.create({
        data: {
          transferNo,
          fromWarehouseId: fromId,
          toWarehouseId: toId,
          userId: req.session.user.id,
          notes,
          status: 'COMPLETED',
          items: {
            create: items.map(i => ({
              productId: parseInt(i.productId),
              quantity: parseInt(i.quantity)
            }))
          }
        }
      });

      // Move stock: deduct from source, add to destination
      for (const item of items) {
        const productId = parseInt(item.productId);
        const qty       = parseInt(item.quantity);

        await tx.warehouseStock.update({
          where: { warehouseId_productId: { warehouseId: fromId, productId } },
          data: { quantity: { decrement: qty } }
        });

        const destStock = await tx.warehouseStock.findUnique({
          where: { warehouseId_productId: { warehouseId: toId, productId } }
        });
        if (destStock) {
          await tx.warehouseStock.update({
            where: { warehouseId_productId: { warehouseId: toId, productId } },
            data: { quantity: { increment: qty } }
          });
        } else {
          await tx.warehouseStock.create({ data: { warehouseId: toId, productId, quantity: qty } });
        }
      }

      return transfer;
    });

    res.json({ success: true, message: `Transfer ${transferNo} completed successfully.` });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Transfer failed: ' + err.message });
  }
};

// API: list warehouses for dropdowns
exports.apiList = async (req, res) => {
  const prisma = await getPrisma();
  const warehouses = await prisma.warehouse.findMany({
    where: { isActive: true },
    select: { id: true, name: true, location: true, isDefault: true },
    orderBy: { isDefault: 'desc' }
  });
  res.json(warehouses);
};

// API: stock for a warehouse (used in sales form)
exports.apiStock = async (req, res) => {
  const warehouseId = parseInt(req.params.id);
  const search      = req.query.search || '';
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
      include: { product: { select: { id: true, name: true, sku: true, price: true, tax: true, unit: true } } },
      take: 25
    });
    res.json(stocks.map(s => ({ ...s.product, warehouseStock: s.quantity })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stock' });
  }
};

module.exports.adjustWarehouseStock = adjustWarehouseStock;
