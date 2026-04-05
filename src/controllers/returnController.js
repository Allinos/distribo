'use strict';
const { getPrisma } = require('../utils/prisma');

// List all returns
exports.index = async (req, res) => {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 15;
  const search = req.query.search || '';
  const from   = req.query.from   || '';
  const to     = req.query.to     || '';
  const skip   = (page - 1) * limit;

  const where = {
    ...(search && {
      OR: [
        { returnNo: { contains: search } },
        { sale: { invoiceNo: { contains: search } } },
        { sale: { customer: { name: { contains: search } } } }
      ]
    }),
    ...(from && to && { returnDate: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } })
  };

  try {
    const prisma = await getPrisma();
    const [returns, total] = await Promise.all([
      prisma.saleReturn.findMany({
        where,
        include: {
          sale: { include: { customer: true } },
          items: { include: { product: true } },
          user: { select: { name: true } },
          warehouse: { select: { name: true } }
        },
        skip, take: limit, orderBy: { createdAt: 'desc' }
      }),
      prisma.saleReturn.count({ where })
    ]);

    // Summary
    const summary = await prisma.saleReturn.aggregate({
      where: { status: { not: 'CANCELLED' } },
      _sum: { refundAmount: true },
      _count: true
    });

    res.render('pages/returns/index', {
      title: 'Sales Returns',
      returns,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      search, from, to,
      summary: {
        totalRefund: parseFloat(summary._sum.refundAmount || 0),
        totalCount: summary._count
      }
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load returns.');
    res.redirect('/');
  }
};

// Show form to create a return — can pre-load from invoice
exports.showCreate = async (req, res) => {
  const invoiceNo = req.query.invoice || '';
  try {
    const prisma = await getPrisma();

    let sale = null;
    if (invoiceNo) {
      sale = await prisma.sale.findUnique({
        where: { invoiceNo },
        include: {
          customer: true,
          items: { include: { product: true } },
          returns: { include: { items: true } }
        }
      });
    }

    const warehouses = await prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } });
    const count      = await prisma.saleReturn.count();
    const returnNo   = `RET-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

    res.render('pages/returns/create', {
      title: 'New Return',
      sale,
      warehouses,
      returnNo,
      invoiceNo
    });
  } catch (err) {
    req.flash('error', 'Failed to load form.');
    res.redirect('/returns');
  }
};

// Search invoice for return
exports.findInvoice = async (req, res) => {
  const { invoiceNo } = req.query;
  try {
    const prisma = await getPrisma();
    const sale = await prisma.sale.findUnique({
      where: { invoiceNo },
      include: {
        customer: true,
        items: { include: { product: true } },
        returns: { include: { items: true } }
      }
    });

    if (!sale) return res.json({ success: false, message: 'Invoice not found.' });
    if (sale.status === 'CANCELLED') return res.json({ success: false, message: 'Cannot return items from a cancelled invoice.' });

    // Calculate already returned quantities per product
    const returnedQty = {};
    sale.returns.forEach(ret => {
      if (ret.status !== 'CANCELLED') {
        ret.items.forEach(item => {
          returnedQty[item.productId] = (returnedQty[item.productId] || 0) + item.quantity;
        });
      }
    });

    const returnableItems = sale.items.map(item => ({
      id: item.id,
      productId: item.productId,
      name: item.product.name,
      sku: item.product.sku,
      unit: item.product.unit,
      originalQty: item.quantity,
      returnedQty: returnedQty[item.productId] || 0,
      availableQty: item.quantity - (returnedQty[item.productId] || 0),
      price: parseFloat(item.price),
      tax: parseFloat(item.tax),
      total: parseFloat(item.total)
    })).filter(i => i.availableQty > 0);

    res.json({
      success: true,
      sale: {
        id: sale.id,
        invoiceNo: sale.invoiceNo,
        customer: sale.customer,
        total: parseFloat(sale.total),
        saleDate: sale.saleDate,
        paymentMode: sale.paymentMode
      },
      items: returnableItems
    });
  } catch (err) {
    res.json({ success: false, message: 'Error finding invoice.' });
  }
};

// Create a return
exports.create = async (req, res) => {
  const { saleId, returnNo, warehouseId, reason, refundMode, notes, items } = req.body;

  if (!saleId) return res.json({ success: false, message: 'Invoice reference is required.' });
  if (!items || !Array.isArray(items) || !items.length) return res.json({ success: false, message: 'Add at least one item to return.' });

  try {
    const prisma = await getPrisma();
    const wId = warehouseId ? parseInt(warehouseId) : null;

    let refundTotal = 0;
    const returnItems = [];

    for (const item of items) {
      const qty   = parseInt(item.quantity);
      const price = parseFloat(item.price);
      const total = qty * price;
      refundTotal += total;
      returnItems.push({ productId: parseInt(item.productId), quantity: qty, price, total });
    }

    await prisma.$transaction(async (tx) => {
      const ret = await tx.saleReturn.create({
        data: {
          returnNo: returnNo || `RET-${Date.now()}`,
          saleId: parseInt(saleId),
          userId: req.session.user.id,
          warehouseId: wId,
          reason,
          refundMode,
          refundAmount: refundTotal,
          status: 'COMPLETED',
          notes,
          items: { create: returnItems }
        }
      });

      // Restore stock for each returned item
      for (const item of returnItems) {
        // Restore global product stock
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } }
        });
        // Restore warehouse stock if applicable
        if (wId) {
          const ws = await tx.warehouseStock.findUnique({
            where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } }
          });
          if (ws) {
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

      return ret;
    });

    res.json({ success: true, message: `Return ${returnNo} recorded. Refund: ₹${refundTotal.toLocaleString('en-IN')}` });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.code === 'P2002' ? 'Return number already exists.' : 'Failed to create return.' });
  }
};
