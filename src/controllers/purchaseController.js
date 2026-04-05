'use strict';
const { getPrisma } = require('../utils/prisma');

exports.index = async (req, res) => {
  const page = parseInt(req.query.page) || 1, limit = parseInt(req.query.limit) || 15;
  const search = req.query.search || '', from = req.query.from || '', to = req.query.to || '';
  const supplierId = req.query.supplier || '';
  const skip = (page - 1) * limit;
  const where = {
    ...(search && { OR: [{ poNo: { contains: search } }, { supplier: { name: { contains: search } } }] }),
    ...(supplierId && { supplierId: parseInt(supplierId) }),
    ...(from && to && { purchaseDate: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } })
  };
  try {
    const prisma = await getPrisma();
    const [purchases, total, suppliers] = await Promise.all([
      prisma.purchase.findMany({ where, include: { supplier: true, items: true }, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.purchase.count({ where }),
      prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } })
    ]);

    // Monthly chart data
    const now = new Date();
    const chartData = [];
    for (let i = 5; i >= 0; i--) {
      const ms = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const me = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const agg = await prisma.purchase.aggregate({ where: { purchaseDate: { gte: ms, lte: me }, status: { not: 'CANCELLED' } }, _sum: { total: true } });
      chartData.push({ month: ms.toLocaleString('default', { month: 'short' }), amount: parseFloat(agg._sum.total || 0) });
    }

    res.render('pages/purchases/index', {
      title: 'Purchases', purchases, suppliers,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      search, from, to, supplierId,
      chartData: JSON.stringify(chartData)
    });
  } catch (err) { console.error(err); req.flash('error', 'Failed to load purchases.'); res.redirect('/'); }
};

exports.showCreate = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const [suppliers, products, warehouses] = await Promise.all([
      prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      prisma.product.findMany({ where: { isActive: true }, include: { category: true }, orderBy: { name: 'asc' } }),
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } })
    ]);
    const count = await prisma.purchase.count();
    const poNo = `PO-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
    const defaultWarehouse = warehouses.find(w => w.isDefault) || warehouses[0] || null;
    res.render('pages/purchases/create', { title: 'New Purchase', suppliers, products, warehouses, poNo, defaultWarehouseId: defaultWarehouse ? defaultWarehouse.id : null });
  } catch (err) { req.flash('error', 'Failed to load form.'); res.redirect('/purchases'); }
};

exports.create = async (req, res) => {
  const { supplierId, status, notes, items, poNo, warehouseId } = req.body;
  const wId = warehouseId ? parseInt(warehouseId) : null;
  if (!items || !Array.isArray(items) || items.length === 0)
    return res.json({ success: false, message: 'No items in purchase order.' });
  if (!supplierId)
    return res.json({ success: false, message: 'Please select a supplier.' });

  try {
    const prisma = await getPrisma();
    let subtotal = 0, taxAmount = 0;
    const purchaseItems = [];

    for (const item of items) {
      const product = await prisma.product.findUnique({ where: { id: parseInt(item.productId) } });
      if (!product) return res.json({ success: false, message: `Product not found: ${item.productId}` });
      const base = parseFloat(item.price) * parseInt(item.quantity);
      const tax = (base * parseFloat(item.tax || 0)) / 100;
      subtotal += base; taxAmount += tax;
      purchaseItems.push({ productId: product.id, quantity: parseInt(item.quantity), price: parseFloat(item.price), tax: parseFloat(item.tax || 0), total: base + tax });
    }

    const purchase = await prisma.$transaction(async (tx) => {
      const p = await tx.purchase.create({
        data: {
          poNo: poNo || `PO-${Date.now()}`,
          supplierId: parseInt(supplierId),
          userId: req.session.user.id,
          warehouseId: wId,
          subtotal, taxAmount,
          total: subtotal + taxAmount,
          status: status || 'RECEIVED',
          notes,
          items: { create: purchaseItems }
        }
      });

      // Increase stock only if RECEIVED
      if ((status || 'RECEIVED') === 'RECEIVED') {
        for (const item of purchaseItems) {
          // Weighted Average Cost: newAvg = (oldStock * oldAvg + newQty * newCost) / (oldStock + newQty)
          const prod = await tx.product.findUnique({
            where: { id: item.productId },
            select: { stock: true, avgCostPrice: true }
          });
          const oldStock = prod.stock;
          const oldAvg   = parseFloat(prod.avgCostPrice || 0);
          const newAvg   = oldStock + item.quantity > 0
            ? (oldStock * oldAvg + item.quantity * item.price) / (oldStock + item.quantity)
            : item.price;

          await tx.product.update({
            where: { id: item.productId },
            data: {
              stock:        { increment: item.quantity },
              costPrice:    item.price,      // keep costPrice = last purchase price
              avgCostPrice: newAvg           // WAC for profit calculation
            }
          });

          // Also update warehouse stock if warehouse selected
          if (wId) {
            const existing = await tx.warehouseStock.findUnique({
              where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } }
            });
            if (existing) {
              await tx.warehouseStock.update({
                where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } },
                data: { quantity: { increment: item.quantity } }
              });
            } else {
              await tx.warehouseStock.create({
                data: { warehouseId: wId, productId: item.productId, quantity: item.quantity }
              });
            }
          }
        }
      }
      return p;
    });

    res.json({ success: true, purchaseId: purchase.id, message: 'Purchase order created.' });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.code === 'P2002' ? 'PO number already exists.' : 'Failed to create purchase.' });
  }
};

exports.show = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const purchase = await prisma.purchase.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { supplier: true, warehouse: true, updatedBy: { select: { name: true } }, items: { include: { product: { include: { category: true } } } } }
    });
    if (!purchase) { req.flash('error', 'Purchase not found.'); return res.redirect('/purchases'); }
    res.render('pages/purchases/show', { title: `PO ${purchase.poNo}`, purchase });
  } catch (err) { req.flash('error', 'Failed to load.'); res.redirect('/purchases'); }
};

exports.cancel = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const purchase = await prisma.purchase.findUnique({ where: { id: parseInt(req.params.id) }, include: { items: true } });
    if (!purchase || purchase.status === 'CANCELLED') { req.flash('error', 'Already cancelled.'); return res.redirect('/purchases'); }

    await prisma.$transaction(async (tx) => {
      await tx.purchase.update({ where: { id: purchase.id }, data: { status: 'CANCELLED' } });
      if (purchase.status === 'RECEIVED') {
        for (const item of purchase.items) {
          await tx.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.quantity } } });
        }
      }
    });
    req.flash('success', 'Purchase cancelled and stock reversed.');
    res.redirect('/purchases');
  } catch (err) { req.flash('error', 'Failed to cancel.'); res.redirect('/purchases'); }
};


// ─── Show edit form ────────────────────────────────────────────────────────────
exports.showEdit = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const [purchase, suppliers, warehouses] = await Promise.all([
      prisma.purchase.findUnique({
        where: { id: parseInt(req.params.id) },
        include: {
          supplier:  true,
          warehouse: true,
          items:     { include: { product: { include: { category: true } } } },
          updatedBy: { select: { name: true } },
        }
      }),
      prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } })
    ]);
    if (!purchase) { req.flash('error', 'Purchase not found.'); return res.redirect('/purchases'); }
    if (purchase.status === 'CANCELLED') { req.flash('error', 'Cannot edit a cancelled purchase.'); return res.redirect(`/purchases/${purchase.id}`); }

    res.render('pages/purchases/edit', { title: `Edit ${purchase.poNo}`, purchase, suppliers, warehouses });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load edit form.');
    res.redirect('/purchases');
  }
};

// ─── Update purchase ───────────────────────────────────────────────────────────
exports.update = async (req, res) => {
  const purchaseId = parseInt(req.params.id);
  const { supplierId, warehouseId, status, notes, purchaseDate, items } = req.body;

  if (!items || !Array.isArray(items) || !items.length)
    return res.json({ success: false, message: 'Purchase must have at least one item.' });

  try {
    const prisma = await getPrisma();
    const existing = await prisma.purchase.findUnique({ where: { id: purchaseId }, include: { items: true } });
    if (!existing) return res.json({ success: false, message: 'Purchase not found.' });
    if (existing.status === 'CANCELLED') return res.json({ success: false, message: 'Cannot edit a cancelled purchase.' });

    let subtotal = 0, taxAmount = 0;
    const newItems = [];
    for (const item of items) {
      const base = parseFloat(item.price) * parseInt(item.quantity);
      const tax  = (base * parseFloat(item.tax || 0)) / 100;
      subtotal += base; taxAmount += tax;
      newItems.push({ productId: parseInt(item.productId), quantity: parseInt(item.quantity), price: parseFloat(item.price), tax: parseFloat(item.tax || 0), total: base + tax });
    }

    const wasReceived = existing.status === 'RECEIVED';
    const willReceive = (status || existing.status) === 'RECEIVED';
    const wId = warehouseId ? parseInt(warehouseId) : null;
    const oldWId = existing.warehouseId;

    await prisma.$transaction(async (tx) => {
      // 1. Reverse old stock if was received
      if (wasReceived) {
        for (const old of existing.items) {
          await tx.product.update({ where: { id: old.productId }, data: { stock: { decrement: old.quantity } } });
          if (oldWId) {
            const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: oldWId, productId: old.productId } } });
            if (ws) await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: oldWId, productId: old.productId } }, data: { quantity: { decrement: old.quantity } } });
          }
        }
      }

      // 2. Replace items
      await tx.purchaseItem.deleteMany({ where: { purchaseId } });
      await tx.purchaseItem.createMany({ data: newItems.map(i => ({ ...i, purchaseId })) });

      // 3. Add new stock if will be received
      if (willReceive) {
        for (const item of newItems) {
          await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity }, costPrice: item.price } });
          if (wId) {
            const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } } });
            if (ws) { await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } }, data: { quantity: { increment: item.quantity } } }); }
            else    { await tx.warehouseStock.create({ data: { warehouseId: wId, productId: item.productId, quantity: item.quantity } }); }
          }
        }
      }

      // 4. Update purchase header
      await tx.purchase.update({
        where: { id: purchaseId },
        data: {
          supplierId:  parseInt(supplierId),
          warehouseId: wId,
          status:      status || existing.status,
          subtotal, taxAmount, total: subtotal + taxAmount,
          notes,
          purchaseDate: purchaseDate ? new Date(purchaseDate) : existing.purchaseDate,
          updatedById:  req.session.user.id,
        }
      });
    });

    res.json({ success: true, message: 'Purchase updated successfully.', purchaseId });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.message || 'Failed to update purchase.' });
  }
};

// ─── Delete purchase ───────────────────────────────────────────────────────────
exports.deletePurchase = async (req, res) => {
  const purchaseId = parseInt(req.params.id);
  try {
    const prisma = await getPrisma();
    const purchase = await prisma.purchase.findUnique({ where: { id: purchaseId }, include: { items: true } });
    if (!purchase) { req.flash('error', 'Purchase not found.'); return res.redirect('/purchases'); }

    await prisma.$transaction(async (tx) => {
      // Reverse stock if was received
      if (purchase.status === 'RECEIVED') {
        for (const item of purchase.items) {
          await tx.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.quantity } } });
          if (purchase.warehouseId) {
            const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: purchase.warehouseId, productId: item.productId } } });
            if (ws) await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: purchase.warehouseId, productId: item.productId } }, data: { quantity: { decrement: item.quantity } } });
          }
        }
      }
      await tx.purchaseItem.deleteMany({ where: { purchaseId } });
      await tx.purchase.delete({ where: { id: purchaseId } });
    });

    req.flash('success', 'Purchase deleted and stock reversed.');
    res.redirect('/purchases');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to delete purchase.');
    res.redirect('/purchases');
  }
};
