'use strict';
const { getPrisma } = require('../utils/prisma');

exports.index = async (req, res) => {
  const page     = parseInt(req.query.page)  || 1;
  const limit    = parseInt(req.query.limit) || 15;
  const search   = req.query.search   || '';
  const from     = req.query.from     || '';
  const to       = req.query.to       || '';
  const saleType = req.query.type     || 'all';
  const skip = (page - 1) * limit;

  const dateFilter = from && to
    ? { gte: new Date(from), lte: new Date(to + 'T23:59:59') }
    : undefined;

  const baseWhere = {
    ...(search && { OR: [{ invoiceNo: { contains: search } }, { customer: { name: { contains: search } } }] }),
    ...(dateFilter && { saleDate: dateFilter })
  };

  try {
    const prisma = await getPrisma();
    let normalSales = [], vanSales = [], normalTotal = 0, vanTotal = 0;

    if (saleType !== 'van') {
      [normalSales, normalTotal] = await Promise.all([
        prisma.sale.findMany({ where: baseWhere, include: { customer: true, items: true, user: { select: { name: true } }, warehouse: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
        prisma.sale.count({ where: baseWhere })
      ]);
    }
    if (saleType !== 'normal') {
      [vanSales, vanTotal] = await Promise.all([
        prisma.vanSale.findMany({ where: baseWhere, include: { customer: true, items: true, user: { select: { name: true } }, vehicle: { select: { name: true, regNo: true } } }, orderBy: { createdAt: 'desc' } }),
        prisma.vanSale.count({ where: baseWhere })
      ]);
    }

    const tagged = [
      ...normalSales.map(s => ({ ...s, _type: 'normal' })),
      ...vanSales.map(s => ({ ...s, _type: 'van' }))
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const paginated = tagged.slice(skip, skip + limit);

    const [normalSum, vanSum] = await Promise.all([
      prisma.sale.aggregate({ where: { ...baseWhere, status: { not: 'CANCELLED' } }, _sum: { total: true } }),
      prisma.vanSale.aggregate({ where: { ...baseWhere, status: { not: 'CANCELLED' } }, _sum: { total: true } })
    ]);

    const customers = await prisma.customer.findMany({ orderBy: { name: 'asc' } });

    res.render('pages/sales/index', {
      title: 'Sales', sales: paginated, customers,
      pagination: { page, limit, total: tagged.length, totalPages: Math.ceil(tagged.length / limit) },
      search, from, to, saleType,
      summary: {
        normalCount: normalTotal, vanCount: vanTotal,
        normalTotal: parseFloat(normalSum._sum.total || 0),
        vanTotal:    parseFloat(vanSum._sum.total || 0),
      }
    });
  } catch (err) { console.error(err); req.flash('error', 'Failed to load sales.'); res.redirect('/'); }
};

exports.showCreate = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const [customers, warehouses, settings] = await Promise.all([
      prisma.customer.findMany({ orderBy: { name: 'asc' } }),
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } }),
      prisma.setting.findMany()
    ]);
    const settingMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const count = await prisma.sale.count();
    const invoiceNo = `${settingMap.invoice_prefix || 'INV'}-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
    const defaultWarehouse = warehouses.find(w => w.isDefault) || warehouses[0] || null;

    res.render('pages/sales/create', {
      title: 'New Invoice', customers, warehouses, invoiceNo,
      defaultWarehouseId: defaultWarehouse ? defaultWarehouse.id : null,
      currency: settingMap.currency || '₹',
      companyName: settingMap.company_name || 'My Company'
    });
  } catch (err) { req.flash('error', 'Failed to load form.'); res.redirect('/sales'); }
};

exports.create = async (req, res) => {
  const { customerId, paymentMode, discount, notes, items, invoiceNo, warehouseId } = req.body;
  if (!items || !Array.isArray(items) || !items.length)
    return res.json({ success: false, message: 'No items in invoice.' });

  const wId = warehouseId ? parseInt(warehouseId) : null;

  try {
    const prisma = await getPrisma();
    let subtotal = 0, taxAmount = 0;
    const saleItems = [];

    for (const item of items) {
      const productId = parseInt(item.productId);
      const qty       = parseInt(item.quantity);

      // Check stock: warehouse-level if warehouse selected, else product.stock
      if (wId) {
        const ws = await prisma.warehouseStock.findUnique({
          where: { warehouseId_productId: { warehouseId: wId, productId } }
        });
        const available = ws ? ws.quantity : 0;
        if (available < qty) {
          const p = await prisma.product.findUnique({ where: { id: productId }, select: { name: true } });
          return res.json({ success: false, message: `Insufficient stock for "${p.name}" in selected warehouse. Available: ${available}` });
        }
      } else {
        const product = await prisma.product.findUnique({ where: { id: productId } });
        if (!product) return res.json({ success: false, message: `Product not found.` });
        if (product.stock < qty) return res.json({ success: false, message: `Insufficient stock for "${product.name}". Available: ${product.stock}` });
      }

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { avgCostPrice: true }
      });
      const base = parseFloat(item.price) * qty;
      const tax  = (base * parseFloat(item.tax || 0)) / 100;
      subtotal += base; taxAmount += tax;
      saleItems.push({
        productId,
        quantity:  qty,
        price:     parseFloat(item.price),
        costPrice: parseFloat(product?.avgCostPrice || 0),
        tax:       parseFloat(item.tax || 0),
        total:     base + tax
      });
    }

    const discountAmt = parseFloat(discount || 0);

    const sale = await prisma.$transaction(async (tx) => {
      const s = await tx.sale.create({
        data: {
          invoiceNo: invoiceNo || `INV-${Date.now()}`,
          customerId: customerId ? parseInt(customerId) : null,
          userId: req.session.user.id,
          warehouseId: wId,
          subtotal, taxAmount, discount: discountAmt,
          total: subtotal + taxAmount - discountAmt,
          paymentMode: paymentMode || 'CASH', notes,
          items: { create: saleItems }
        }
      });

      for (const item of saleItems) {
        if (wId) {
          // 1. Deduct from warehouse stock
          await tx.warehouseStock.update({
            where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } },
            data: { quantity: { decrement: item.quantity } }
          });
          // 2. Sync product.stock = sum across ALL warehouses (already decremented above)
          const allStocks = await tx.warehouseStock.findMany({ where: { productId: item.productId } });
          const newTotal  = allStocks.reduce((a, s) => a + s.quantity, 0);
          await tx.product.update({ where: { id: item.productId }, data: { stock: newTotal } });
        } else {
          // No warehouse selected — deduct from product.stock directly
          await tx.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.quantity } } });
        }
      }
      return s;
    });

    res.json({ success: true, saleId: sale.id, message: 'Invoice created successfully.' });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.code === 'P2002' ? 'Invoice number already exists.' : 'Failed to create invoice.' });
  }
};

exports.show = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const sale = await prisma.sale.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        customer: true,
        warehouse: true,
        items: { include: { product: { include: { category: true } } } },
        user: { select: { name: true } }
      }
    });
    if (!sale) { req.flash('error', 'Invoice not found.'); return res.redirect('/sales'); }
    const settings = await prisma.setting.findMany();
    const sm = Object.fromEntries(settings.map(s => [s.key, s.value]));
    res.render('pages/sales/show', { title: `Invoice ${sale.invoiceNo}`, sale, currency: sm.currency || '₹', companyName: sm.company_name || 'My Company' });
  } catch (err) { req.flash('error', 'Failed to load invoice.'); res.redirect('/sales'); }
};

exports.cancel = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const sale = await prisma.sale.findUnique({ where: { id: parseInt(req.params.id) }, include: { items: true } });
    if (!sale || sale.status === 'CANCELLED') { req.flash('error', 'Already cancelled.'); return res.redirect('/sales'); }
    await prisma.$transaction(async (tx) => {
      await tx.sale.update({ where: { id: sale.id }, data: { status: 'CANCELLED' } });
      for (const item of sale.items) {
        // Restore stock
        await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
        // Restore warehouse stock too if sale was warehouse-linked
        if (sale.warehouseId) {
          const ws = await tx.warehouseStock.findUnique({
            where: { warehouseId_productId: { warehouseId: sale.warehouseId, productId: item.productId } }
          });
          if (ws) {
            await tx.warehouseStock.update({
              where: { warehouseId_productId: { warehouseId: sale.warehouseId, productId: item.productId } },
              data: { quantity: { increment: item.quantity } }
            });
          }
        }
      }
    });
    req.flash('success', 'Invoice cancelled and stock restored.');
    res.redirect('/sales');
  } catch (err) { req.flash('error', 'Failed to cancel.'); res.redirect('/sales'); }
};


// ─── Show edit form ────────────────────────────────────────────────────────────
exports.showEdit = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const [sale, customers, warehouses, settings] = await Promise.all([
      prisma.sale.findUnique({
        where: { id: parseInt(req.params.id) },
        include: {
          customer: true,
          warehouse: true,
          items: { include: { product: { include: { category: true } } } },
          user:      { select: { name: true } },
          updatedBy: { select: { name: true } },
        }
      }),
      prisma.customer.findMany({ orderBy: { name: 'asc' } }),
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } }),
      prisma.setting.findMany()
    ]);

    if (!sale) { req.flash('error', 'Invoice not found.'); return res.redirect('/sales'); }
    if (sale.status === 'CANCELLED') { req.flash('error', 'Cannot edit a cancelled invoice.'); return res.redirect(`/sales/${sale.id}`); }

    const sm = Object.fromEntries(settings.map(s => [s.key, s.value]));
    res.render('pages/sales/edit', {
      title: `Edit ${sale.invoiceNo}`,
      sale,
      customers,
      warehouses,
      currency: sm.currency || '₹',
      companyName: sm.company_name || 'My Company'
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load edit form.');
    res.redirect('/sales');
  }
};

// ─── Update sale ───────────────────────────────────────────────────────────────
exports.update = async (req, res) => {
  const saleId = parseInt(req.params.id);
  const { customerId, paymentMode, discount, notes, warehouseId, status, items, saleDate } = req.body;

  if (!items || !Array.isArray(items) || !items.length)
    return res.json({ success: false, message: 'Invoice must have at least one item.' });

  try {
    const prisma = await getPrisma();
    const existing = await prisma.sale.findUnique({ where: { id: saleId }, include: { items: true } });
    if (!existing) return res.json({ success: false, message: 'Invoice not found.' });
    if (existing.status === 'CANCELLED') return res.json({ success: false, message: 'Cannot edit a cancelled invoice.' });

    // Build new items
    let subtotal = 0, taxAmount = 0;
    const newItems = [];
    for (const item of items) {
      const base = parseFloat(item.price) * parseInt(item.quantity);
      const tax  = (base * parseFloat(item.tax || 0)) / 100;
      subtotal += base; taxAmount += tax;
      newItems.push({ productId: parseInt(item.productId), quantity: parseInt(item.quantity), price: parseFloat(item.price), tax: parseFloat(item.tax || 0), total: base + tax });
    }
    const discountAmt = parseFloat(discount || 0);
    const total = subtotal + taxAmount - discountAmt;

    await prisma.$transaction(async (tx) => {
      // 1. Restore stock from old items
      for (const old of existing.items) {
        await tx.product.update({ where: { id: old.productId }, data: { stock: { increment: old.quantity } } });
        if (existing.warehouseId) {
          const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: existing.warehouseId, productId: old.productId } } });
          if (ws) await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: existing.warehouseId, productId: old.productId } }, data: { quantity: { increment: old.quantity } } });
        }
      }

      // 2. Validate new item stock
      const wId = warehouseId ? parseInt(warehouseId) : null;
      for (const item of newItems) {
        if (wId) {
          const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } } });
          const avail = ws ? ws.quantity : 0;
          if (avail < item.quantity) {
            const p = await tx.product.findUnique({ where: { id: item.productId }, select: { name: true } });
            throw new Error(`Insufficient warehouse stock for "${p.name}". Available: ${avail}`);
          }
        } else {
          const p = await tx.product.findUnique({ where: { id: item.productId } });
          if (p.stock < item.quantity) throw new Error(`Insufficient stock for "${p.name}". Available: ${p.stock}`);
        }
      }

      // 3. Delete old items and create new ones
      await tx.saleItem.deleteMany({ where: { saleId } });
      await tx.saleItem.createMany({ data: newItems.map(i => ({ ...i, saleId })) });

      // 4. Deduct new stock
      for (const item of newItems) {
        await tx.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.quantity } } });
        if (wId) {
          await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } }, data: { quantity: { decrement: item.quantity } } });
        }
      }

      // 5. Update sale header
      await tx.sale.update({
        where: { id: saleId },
        data: {
          customerId:  customerId  ? parseInt(customerId)  : null,
          warehouseId: warehouseId ? parseInt(warehouseId) : null,
          paymentMode: paymentMode || 'CASH',
          status:      status      || existing.status,
          discount:    discountAmt,
          subtotal, taxAmount, total,
          notes,
          saleDate:    saleDate ? new Date(saleDate) : existing.saleDate,
          updatedById: req.session.user.id,
        }
      });
    });

    res.json({ success: true, message: 'Invoice updated successfully.', saleId });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.message || 'Failed to update invoice.' });
  }
};

// ─── Delete sale (hard delete — only allowed for ADMIN / if no returns) ────────
exports.deleteSale = async (req, res) => {
  const saleId = parseInt(req.params.id);
  try {
    const prisma = await getPrisma();
    const sale = await prisma.sale.findUnique({ where: { id: saleId }, include: { items: true, returns: true } });
    if (!sale) { req.flash('error', 'Invoice not found.'); return res.redirect('/sales'); }

    if (sale.returns.length > 0) {
      req.flash('error', 'Cannot delete an invoice that has return records.');
      return res.redirect(`/sales/${saleId}`);
    }

    await prisma.$transaction(async (tx) => {
      // Restore stock if not cancelled
      if (sale.status !== 'CANCELLED') {
        for (const item of sale.items) {
          await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
          if (sale.warehouseId) {
            const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: sale.warehouseId, productId: item.productId } } });
            if (ws) await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: sale.warehouseId, productId: item.productId } }, data: { quantity: { increment: item.quantity } } });
          }
        }
      }
      await tx.saleItem.deleteMany({ where: { saleId } });
      await tx.sale.delete({ where: { id: saleId } });
    });

    req.flash('success', 'Invoice deleted and stock restored.');
    res.redirect('/sales');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to delete invoice.');
    res.redirect('/sales');
  }
};
