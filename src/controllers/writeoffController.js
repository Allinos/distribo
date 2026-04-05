'use strict';
const { getPrisma } = require('../utils/prisma');

const REASON_LABELS = {
  INTERNAL_USE: { label: 'Internal / Office Use', icon: 'bi-building', color: 'primary' },
  DAMAGED:      { label: 'Damaged',                icon: 'bi-exclamation-triangle', color: 'danger' },
  EXPIRED:      { label: 'Expired',                icon: 'bi-clock-history', color: 'warning' },
  SAMPLE:       { label: 'Sample / Demo',          icon: 'bi-gift', color: 'info' },
  LOST:         { label: 'Lost / Missing',         icon: 'bi-question-circle', color: 'secondary' },
  OTHER:        { label: 'Other',                  icon: 'bi-three-dots', color: 'secondary' }
};

exports.index = async (req, res) => {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 15;
  const search = req.query.search || '';
  const reason = req.query.reason || '';
  const from   = req.query.from   || '';
  const to     = req.query.to     || '';
  const skip   = (page - 1) * limit;

  const where = {
    ...(search && { writeoffNo: { contains: search } }),
    ...(reason && { reason }),
    ...(from && to && { writeoffDate: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } })
  };

  try {
    const prisma = await getPrisma();
    const [writeoffs, total] = await Promise.all([
      prisma.stockWriteoff.findMany({
        where,
        include: {
          items: { include: { product: { include: { category: true } } } },
          user: { select: { name: true } },
          warehouse: { select: { name: true } }
        },
        skip, take: limit, orderBy: { createdAt: 'desc' }
      }),
      prisma.stockWriteoff.count({ where })
    ]);

    res.render('pages/writeoffs/index', {
      title: 'Stock Write-offs',
      writeoffs,
      REASON_LABELS,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      search, reason, from, to,
      reasons: Object.keys(REASON_LABELS)
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load write-offs.');
    res.redirect('/');
  }
};

exports.showCreate = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const [products, warehouses] = await Promise.all([
      prisma.product.findMany({
        where: { isActive: true, stock: { gt: 0 } },
        include: { category: true },
        orderBy: { name: 'asc' }
      }),
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } })
    ]);
    const count     = await prisma.stockWriteoff.count();
    const writeoffNo = `WO-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

    res.render('pages/writeoffs/create', {
      title: 'New Write-off',
      products,
      warehouses,
      writeoffNo,
      REASON_LABELS,
      reasons: Object.keys(REASON_LABELS)
    });
  } catch (err) {
    req.flash('error', 'Failed to load form.');
    res.redirect('/writeoffs');
  }
};

exports.create = async (req, res) => {
  const { writeoffNo, warehouseId, reason, notes, writeoffDate, items } = req.body;
  if (!reason) return res.json({ success: false, message: 'Select a reason for the write-off.' });
  if (!items || !Array.isArray(items) || !items.length) return res.json({ success: false, message: 'Add at least one product.' });

  try {
    const prisma = await getPrisma();
    const wId = warehouseId ? parseInt(warehouseId) : null;

    // Validate stock before transaction
    for (const item of items) {
      const qty     = parseInt(item.quantity);
      const product = await prisma.product.findUnique({ where: { id: parseInt(item.productId) } });
      if (!product) return res.json({ success: false, message: `Product not found.` });
      if (product.stock < qty) return res.json({ success: false, message: `Insufficient stock for "${product.name}". Available: ${product.stock}` });
      if (wId) {
        const ws = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: wId, productId: parseInt(item.productId) } } });
        const avail = ws ? ws.quantity : 0;
        if (avail < qty) return res.json({ success: false, message: `Insufficient warehouse stock for "${product.name}". Available: ${avail}` });
      }
    }

    const writeoffItems = items.map(i => ({
      productId: parseInt(i.productId),
      quantity:  parseInt(i.quantity),
      costValue: parseFloat(i.costValue || 0)
    }));

    await prisma.$transaction(async (tx) => {
      await tx.stockWriteoff.create({
        data: {
          writeoffNo:  writeoffNo || `WO-${Date.now()}`,
          userId:      req.session.user.id,
          warehouseId: wId,
          reason,
          notes,
          writeoffDate: writeoffDate ? new Date(writeoffDate) : new Date(),
          items: { create: writeoffItems }
        }
      });

      for (const item of writeoffItems) {
        let remaining = item.quantity;

        if (wId) {
          // Specific warehouse selected — deduct from it
          await tx.warehouseStock.update({
            where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } },
            data: { quantity: { decrement: item.quantity } }
          });
        } else {
          // No warehouse selected — deduct from warehouses in order (most stock first)
          const whStocks = await tx.warehouseStock.findMany({
            where: { productId: item.productId, quantity: { gt: 0 } },
            orderBy: { quantity: 'desc' }
          });
          for (const ws of whStocks) {
            if (remaining <= 0) break;
            const deduct = Math.min(ws.quantity, remaining);
            await tx.warehouseStock.update({
              where: { warehouseId_productId: { warehouseId: ws.warehouseId, productId: item.productId } },
              data: { quantity: { decrement: deduct } }
            });
            remaining -= deduct;
          }
          // If any remaining, deduct from vehicle stocks too
          if (remaining > 0) {
            const vsStocks = await tx.vehicleStock.findMany({
              where: { productId: item.productId, quantity: { gt: 0 } },
              orderBy: { quantity: 'desc' }
            });
            for (const vs of vsStocks) {
              if (remaining <= 0) break;
              const deduct = Math.min(vs.quantity, remaining);
              await tx.vehicleStock.update({
                where: { vehicleId_productId: { vehicleId: vs.vehicleId, productId: item.productId } },
                data: { quantity: { decrement: deduct } }
              });
              remaining -= deduct;
            }
          }
        }

        // Always deduct from product.stock
        await tx.product.update({
          where: { id: item.productId },
          data:  { stock: { decrement: item.quantity } }
        });
      }
    });

    res.json({ success: true, message: `Write-off ${writeoffNo} recorded successfully.` });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Failed to create write-off.' });
  }
};
