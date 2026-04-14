'use strict';
const { getPrisma } = require('../utils/prisma');

async function addCustomerLedgerEntry(tx, customerId, saleId, type, amount, note) {
  if (!customerId) return;
  const last = await tx.customerLedger.findFirst({ where: { customerId }, orderBy: { createdAt: 'desc' } });
  const currentBalance = last ? parseFloat(last.balance) : 0;
  const newBalance = type === 'SALE' ? currentBalance + amount : currentBalance - amount;
  await tx.customerLedger.create({ data: { customerId, saleId, type, amount, balance: newBalance, note } });
}

exports.index = async (req, res) => {
  const page = parseInt(req.query.page) || 1, limit = parseInt(req.query.limit) || 15;
  const search = req.query.search || '', from = req.query.from || '', to = req.query.to || '';
  const saleType = req.query.type || 'all';
  const skip = (page - 1) * limit;
  const dateFilter = from && to ? { gte: new Date(from), lte: new Date(to + 'T23:59:59') } : undefined;
  const baseWhere = {
    ...(search && { OR: [{ invoiceNo: { contains: search } }, { customer: { name: { contains: search } } }] }),
    ...(dateFilter && { saleDate: dateFilter })
  };
  try {
    const prisma = await getPrisma();
    let normalSales = [], vanSales = [], normalTotal = 0, vanTotal = 0;
    if (saleType !== 'van') {
      [normalSales, normalTotal] = await Promise.all([
        prisma.sale.findMany({ where: baseWhere, include: { customer: true, items: true, user: { select: { name: true } }, warehouse: { select: { name: true } }, payments: true }, orderBy: { createdAt: 'desc' } }),
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
    res.render('pages/sales/index', {
      title: 'Sales', sales: paginated,
      pagination: { page, limit, total: tagged.length, totalPages: Math.ceil(tagged.length / limit) },
      search, from, to, saleType,
      summary: { normalCount: normalTotal, vanCount: vanTotal, normalTotal: parseFloat(normalSum._sum.total || 0), vanTotal: parseFloat(vanSum._sum.total || 0) }
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
    const sm = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const count = await prisma.sale.count();
    const invoiceNo = `${sm.invoice_prefix || 'INV'}-${new Date().getFullYear()}-${String(count + 2).padStart(4, '0')}`;
    const defaultWarehouse = warehouses.find(w => w.isDefault) || warehouses[0] || null;
    res.render('pages/sales/create', {
      title: 'New Invoice', customers, warehouses, invoiceNo,
      preSelectedVehicleId: req.query.vehicleId || null ,
      defaultWarehouseId: defaultWarehouse ? defaultWarehouse.id : null,
      currency: sm.currency || '₹', companyName: sm.company_name || 'My Company'
    });
  } catch (err) { req.flash('error', 'Failed to load form.'); res.redirect('/sales'); }
};

exports.create = async (req, res) => {
  const { customerId, notes, items, invoiceNo, warehouseId, saleDate, payments } = req.body;
  if (!items || !Array.isArray(items) || !items.length)
    return res.json({ success: false, message: 'No items in invoice.' });
  if (!payments || !Array.isArray(payments) || !payments.length)
    return res.json({ success: false, message: 'At least one payment entry is required.' });

  const wId = warehouseId ? parseInt(warehouseId) : null;
  try {
    const prisma = await getPrisma();
    let subtotal = 0, taxAmount = 0, discount = 0;
    const saleItems = [];

    for (const item of items) {
      const productId = parseInt(item.productId);
      const qty       = parseInt(item.quantity);
      discount += parseFloat(item.discount || 0);

      // Stock validation
      if (wId) {
        const ws = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: wId, productId } } });
        const available = ws ? ws.quantity : 0;
        if (available < qty) {
          const p = await prisma.product.findUnique({ where: { id: productId }, select: { name: true } });
          return res.json({ success: false, message: `Insufficient stock for "${p.name}" in warehouse. Available: ${available}` });
        }
      } else {
        const product = await prisma.product.findUnique({ where: { id: productId } });
        if (!product || product.stock < qty)
          return res.json({ success: false, message: `Insufficient stock for product ${productId}` });
      }

      const product = await prisma.product.findUnique({ where: { id: productId }, select: { avgCostPrice: true } });
      const base = parseFloat(item.price) * qty;
      const tax  = (base * parseFloat(item.tax || 0)) / 100;
      subtotal += base; taxAmount += tax;
      saleItems.push({ productId, quantity: qty, price: parseFloat(item.price), costPrice: parseFloat(product?.avgCostPrice || 0), tax: parseFloat(item.tax || 0), total: base + tax });
    }

    const total = subtotal + taxAmount - discount;
    const paymentRows = payments.map(p => ({ mode: p.mode, amount: parseFloat(p.amount), reference: p.reference || null }));
    const amountPaid = paymentRows.reduce((s, p) => s + p.amount, 0);
    if (amountPaid > total + 0.01) return res.json({ success: false, message: `Total payments (₹${amountPaid.toFixed(2)}) exceed invoice total (₹${total.toFixed(2)}).` });
    const creditAmount = total - amountPaid;
    const status = amountPaid <= 0 ? 'UNPAID' : creditAmount > 0.01 ? 'PARTIAL' : 'PAID';
    const primaryMode = paymentRows.sort((a, b) => b.amount - a.amount)[0]?.mode || 'CASH';

    const sale = await prisma.$transaction(async (tx) => {
      const s = await tx.sale.create({
        data: {
          invoiceNo: invoiceNo || `INV-${Date.now()}`,
          customerId: customerId ? parseInt(customerId) : null,
          userId: req.session.user.id,
          warehouseId: wId,
          subtotal, taxAmount, discount, total,
          amountPaid,
          paymentMode: primaryMode,
          status,
          notes,
          saleDate: saleDate ? new Date(saleDate) : new Date(),
          items:    { create: saleItems },
          payments: { create: paymentRows }
        }
      });

      // Deduct stock
      for (const item of saleItems) {
        if (wId) {
          await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } }, data: { quantity: { decrement: item.quantity } } });
          const allStocks = await tx.warehouseStock.findMany({ where: { productId: item.productId } });
          const vsStocks  = await tx.vehicleStock.findMany({ where: { productId: item.productId } });
          const newTotal  = [...allStocks, ...vsStocks].reduce((a, s) => a + s.quantity, 0);
          await tx.product.update({ where: { id: item.productId }, data: { stock: newTotal } });
        } else {
          await tx.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.quantity } } });
        }
      }

      // Customer ledger
      if (customerId) {
        const cId = parseInt(customerId);
        await addCustomerLedgerEntry(tx, cId, s.id, 'SALE', total, `Invoice ${s.invoiceNo}`);
        if (amountPaid > 0) await addCustomerLedgerEntry(tx, cId, s.id, 'PAYMENT', amountPaid, `Payment on ${s.invoiceNo}`);
      }
      return s;
    });

    res.json({ success: true, saleId: sale.id, message: `Invoice created. ${creditAmount > 0 ? `Credit: ₹${creditAmount.toFixed(2)}` : 'Fully paid.'}` });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.code === 'P2002' ? 'Invoice number exists.' : 'Failed: ' + err.message });
  }
};

exports.show = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const sale = await prisma.sale.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { customer: true, warehouse: true, items: { include: { product: { include: { category: true } } } }, user: { select: { name: true } }, updatedBy: { select: { name: true } }, payments: true }
    });
    if (!sale) { req.flash('error', 'Invoice not found.'); return res.redirect('/sales'); }
    const settings = await prisma.setting.findMany();
    const sm = Object.fromEntries(settings.map(s => [s.key, s.value]));
    res.render('pages/sales/show', { title: `Invoice ${sale.invoiceNo}`, sale, currency: sm.currency || '₹', companyName: sm.company_name || 'My Company' });
  } catch (err) { req.flash('error', 'Failed to load invoice.'); res.redirect('/sales'); }
};

exports.addPayment = async (req, res) => {
  const saleId = parseInt(req.params.id);
  const { mode, amount, reference } = req.body;
  const amt = parseFloat(amount);
  try {
    const prisma = await getPrisma();
    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    if (!sale) return res.json({ success: false, message: 'Sale not found.' });
    if (sale.status === 'CANCELLED') return res.json({ success: false, message: 'Cannot add payment to cancelled sale.' });
    const remaining = parseFloat(sale.total) - parseFloat(sale.amountPaid || 0);
    if (amt > remaining + 0.01) return res.json({ success: false, message: `Payment ₹${amt} exceeds remaining ₹${remaining.toFixed(2)}` });

    await prisma.$transaction(async (tx) => {
      await tx.salePayment.create({ data: { saleId, mode, amount: amt, reference: reference || null } });
      const newPaid   = parseFloat(sale.amountPaid || 0) + amt;
      const newStatus = newPaid >= parseFloat(sale.total) - 0.01 ? 'PAID' : 'PARTIAL';
      await tx.sale.update({ where: { id: saleId }, data: { amountPaid: newPaid, status: newStatus } });
      if (sale.customerId) await addCustomerLedgerEntry(tx, sale.customerId, saleId, 'PAYMENT', amt, `Payment on ${sale.invoiceNo}`);
    });
    res.json({ success: true, message: `Payment of ₹${amt} recorded.` });
  } catch (err) { res.json({ success: false, message: err.message }); }
};

exports.cancel = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const sale = await prisma.sale.findUnique({ where: { id: parseInt(req.params.id) }, include: { items: true } });
    if (!sale || sale.status === 'CANCELLED') { req.flash('error', 'Already cancelled.'); return res.redirect('/sales'); }
    await prisma.$transaction(async (tx) => {
      await tx.sale.update({ where: { id: sale.id }, data: { status: 'CANCELLED' } });
      for (const item of sale.items) {
        await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
        if (sale.warehouseId) {
          const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: sale.warehouseId, productId: item.productId } } });
          if (ws) await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: sale.warehouseId, productId: item.productId } }, data: { quantity: { increment: item.quantity } } });
        }
      }
      if (sale.customerId) await addCustomerLedgerEntry(tx, sale.customerId, sale.id, 'ADJUSTMENT', parseFloat(sale.total), `Cancellation of ${sale.invoiceNo}`);
    });
    req.flash('success', 'Invoice cancelled and stock restored.');
    res.redirect('/sales');
  } catch (err) { req.flash('error', 'Failed to cancel.'); res.redirect('/sales'); }
};

exports.showEdit = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const [sale, customers, warehouses, settings] = await Promise.all([
      prisma.sale.findUnique({ where: { id: parseInt(req.params.id) }, include: { customer: true, warehouse: true, items: { include: { product: { include: { category: true } } } }, user: { select: { name: true } }, updatedBy: { select: { name: true } }, payments: true } }),
      prisma.customer.findMany({ orderBy: { name: 'asc' } }),
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } }),
      prisma.setting.findMany()
    ]);
    if (!sale) { req.flash('error', 'Invoice not found.'); return res.redirect('/sales'); }
    if (sale.status === 'CANCELLED') { req.flash('error', 'Cannot edit cancelled invoice.'); return res.redirect(`/sales/${sale.id}`); }
    const sm = Object.fromEntries(settings.map(s => [s.key, s.value]));
    res.render('pages/sales/edit', { title: `Edit ${sale.invoiceNo}`, sale, customers, warehouses, currency: sm.currency || '₹', companyName: sm.company_name || 'My Company' });
  } catch (err) { req.flash('error', 'Failed to load edit form.'); res.redirect('/sales'); }
};

exports.update = async (req, res) => {
  const saleId = parseInt(req.params.id);
  const { customerId, notes, warehouseId, status, items, saleDate, payments } = req.body;
  if (!items || !Array.isArray(items) || !items.length) return res.json({ success: false, message: 'Invoice must have at least one item.' });
  try {
    const prisma = await getPrisma();
    const existing = await prisma.sale.findUnique({ where: { id: saleId }, include: { items: true } });
    if (!existing) return res.json({ success: false, message: 'Invoice not found.' });
    if (existing.status === 'CANCELLED') return res.json({ success: false, message: 'Cannot edit cancelled invoice.' });

    let subtotal = 0, taxAmount = 0, discount = 0;
    const newItems = [];
    for (const item of items) {
      const base = parseFloat(item.price) * parseInt(item.quantity);
      const tax  = (base * parseFloat(item.tax || 0)) / 100;
      discount += parseFloat(item.discount || 0);
      subtotal += base; taxAmount += tax;
      const prod = await prisma.product.findUnique({ where: { id: parseInt(item.productId) }, select: { avgCostPrice: true } });
      newItems.push({ productId: parseInt(item.productId), quantity: parseInt(item.quantity), price: parseFloat(item.price), costPrice: parseFloat(prod?.avgCostPrice || 0), tax: parseFloat(item.tax || 0), total: base + tax });
    }
    const total = subtotal + taxAmount - discount;
    const paymentRows = payments ? payments.map(p => ({ mode: p.mode, amount: parseFloat(p.amount), reference: p.reference || null })) : [];
    const newPaid = paymentRows.reduce((s, p) => s + p.amount, parseFloat(existing.amountPaid || 0));
    const newStatus = status || (newPaid >= total - 0.01 ? 'PAID' : newPaid > 0 ? 'PARTIAL' : 'UNPAID');
    const wId = warehouseId ? parseInt(warehouseId) : null;

    await prisma.$transaction(async (tx) => {
      for (const old of existing.items) {
        await tx.product.update({ where: { id: old.productId }, data: { stock: { increment: old.quantity } } });
        if (existing.warehouseId) {
          const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: existing.warehouseId, productId: old.productId } } });
          if (ws) await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: existing.warehouseId, productId: old.productId } }, data: { quantity: { increment: old.quantity } } });
        }
      }
      for (const item of newItems) {
        if (wId) {
          const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } } });
          if (!ws || ws.quantity < item.quantity) { const p = await tx.product.findUnique({ where: { id: item.productId }, select: { name: true } }); throw new Error(`Insufficient warehouse stock for "${p.name}"`); }
          await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } }, data: { quantity: { decrement: item.quantity } } });
        }
        await tx.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.quantity } } });
      }
      await tx.saleItem.deleteMany({ where: { saleId } });
      await tx.saleItem.createMany({ data: newItems.map(i => ({ ...i, saleId })) });
      if (paymentRows.length > 0) await tx.salePayment.createMany({ data: paymentRows.map(p => ({ ...p, saleId })) });
      await tx.sale.update({
        where: { id: saleId },
        data: { customerId: customerId ? parseInt(customerId) : null, warehouseId: wId, subtotal, taxAmount, discount, total, amountPaid: newPaid, status: newStatus, notes, saleDate: saleDate ? new Date(saleDate) : existing.saleDate, updatedById: req.session.user.id }
      });
    });
    res.json({ success: true, message: 'Invoice updated.', saleId });
  } catch (err) { console.error(err); res.json({ success: false, message: err.message || 'Failed to update.' }); }
};

exports.deleteSale = async (req, res) => {
  const saleId = parseInt(req.params.id);
  try {
    const prisma = await getPrisma();
    const sale = await prisma.sale.findUnique({ where: { id: saleId }, include: { items: true, returns: true } });
    if (!sale) { req.flash('error', 'Invoice not found.'); return res.redirect('/sales'); }
    if (sale.returns.length > 0) { req.flash('error', 'Cannot delete invoice with returns.'); return res.redirect(`/sales/${saleId}`); }
    await prisma.$transaction(async (tx) => {
      if (sale.status !== 'CANCELLED') {
        for (const item of sale.items) {
          await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
          if (sale.warehouseId) { const ws = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: sale.warehouseId, productId: item.productId } } }); if (ws) await tx.warehouseStock.update({ where: { warehouseId_productId: { warehouseId: sale.warehouseId, productId: item.productId } }, data: { quantity: { increment: item.quantity } } }); }
        }
      }
      await tx.salePayment.deleteMany({ where: { saleId } });
      await tx.saleItem.deleteMany({ where: { saleId } });
      await tx.sale.delete({ where: { id: saleId } });
    });
    req.flash('success', 'Invoice deleted and stock restored.');
    res.redirect('/sales');
  } catch (err) { console.error(err); req.flash('error', 'Failed to delete.'); res.redirect('/sales'); }
};
