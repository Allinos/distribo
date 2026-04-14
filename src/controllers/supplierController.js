'use strict';
const { getPrisma } = require('../utils/prisma');

exports.index = async (req, res) => {
  const page = parseInt(req.query.page) || 1, limit = 15;
  const search = req.query.search || '', skip = (page - 1) * limit;
  const where = {
    isActive: true,
    ...(search && { OR: [{ name: { contains: search } }, { phone: { contains: search } }, { gstin: { contains: search } }] })
  };
  try {
    const prisma = await getPrisma();
    const [suppliers, total] = await Promise.all([
      prisma.supplier.findMany({ where, skip, take: limit, orderBy: { name: 'asc' } }),
      prisma.supplier.count({ where })
    ]);

    // Enrich with purchase stats
    const enriched = await Promise.all(suppliers.map(async s => {
      const [purchAgg, lastLedger] = await Promise.all([
        prisma.purchase.aggregate({
          where: { supplierId: s.id, status: { not: 'CANCELLED' } },
          _sum: { total: true }, _count: true
        }),
        prisma.supplierLedger.findFirst({ where: { supplierId: s.id }, orderBy: { createdAt: 'desc' } })
      ]);
      const totalPurchased = parseFloat(purchAgg._sum.total || 0);
      // Balance due = what we owe the supplier
      const balanceDue = lastLedger ? Math.max(0, parseFloat(lastLedger.balance)) : 0;
      return {
        ...s,
        purchaseCount:  purchAgg._count,
        totalPurchased,
        amountPaid:     totalPurchased - balanceDue,
        balanceDue
      };
    }));

    res.render('pages/suppliers/index', {
      title: 'Suppliers', suppliers: enriched,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      search
    });
  } catch (err) {
    console.error(err); req.flash('error', 'Failed to load suppliers.'); res.redirect('/');
  }
};

exports.create = async (req, res) => {
  const { name, phone, email, gstin, address } = req.body;
  try {
    const prisma = await getPrisma();
    await prisma.supplier.create({ data: { name, phone: phone||null, email: email||null, gstin: gstin||null, address: address||null } });
    req.flash('success', 'Supplier added.');
  } catch (err) { req.flash('error', 'Failed to add supplier.'); }
  res.redirect('/suppliers');
};

exports.update = async (req, res) => {
  const { name, phone, email, gstin, address } = req.body;
  try {
    const prisma = await getPrisma();
    await prisma.supplier.update({ where: { id: parseInt(req.params.id) }, data: { name, phone: phone||null, email: email||null, gstin: gstin||null, address: address||null } });
    req.flash('success', 'Supplier updated.');
  } catch (err) { req.flash('error', 'Failed to update supplier.'); }
  res.redirect('/suppliers');
};

exports.delete = async (req, res) => {
  try {
    const prisma = await getPrisma();
    await prisma.supplier.update({ where: { id: parseInt(req.params.id) }, data: { isActive: false } });
    req.flash('success', 'Supplier deactivated.');
  } catch (err) { req.flash('error', 'Cannot delete supplier with purchase records.'); }
  res.redirect('/suppliers');
};

// Supplier ledger page
exports.ledger = async (req, res) => {
  const supplierId = parseInt(req.params.id);
  const from = req.query.from || '', to = req.query.to || '';
  try {
    const prisma = await getPrisma();
    const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) { req.flash('error', 'Supplier not found.'); return res.redirect('/suppliers'); }

    const dateFilter = from && to ? { gte: new Date(from), lte: new Date(to + 'T23:59:59') } : undefined;

    const [purchases, ledger] = await Promise.all([
      prisma.purchase.findMany({
        where: { supplierId, ...(dateFilter && { purchaseDate: dateFilter }) },
        include: { items: { include: { product: { select: { name: true, unit: true } } } }, warehouse: { select: { name: true } } },
        orderBy: { purchaseDate: 'desc' }
      }),
      prisma.supplierLedger.findMany({
        where: { supplierId, ...(dateFilter && { createdAt: dateFilter }) },
        orderBy: { createdAt: 'asc' }
      })
    ]);

    const activePurchases = purchases.filter(p => p.status !== 'CANCELLED');
    const totalPurchased  = activePurchases.reduce((s, p) => s + parseFloat(p.total), 0);
    const lastEntry       = ledger.length ? parseFloat(ledger[ledger.length - 1].balance) : 0;
    const balanceDue      = Math.max(0, lastEntry);

    res.render('pages/suppliers/ledger', {
      title: `${supplier.name} — Ledger`,
      supplier, purchases, ledger,
      summary: { totalPurchased, balanceDue, amountPaid: totalPurchased - balanceDue },
      from, to
    });
  } catch (err) {
    console.error(err); req.flash('error', 'Failed.'); res.redirect('/suppliers');
  }
};

// Record payment to supplier
exports.recordPayment = async (req, res) => {
  const supplierId = parseInt(req.params.id);
  const { purchaseId, amount, mode, reference } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.json({ success: false, message: 'Enter a valid amount.' });
  try {
    const prisma = await getPrisma();
    await prisma.$transaction(async (tx) => {
      const last = await tx.supplierLedger.findFirst({ where: { supplierId }, orderBy: { createdAt: 'desc' } });
      const currentBal = last ? parseFloat(last.balance) : 0;
      await tx.supplierLedger.create({
        data: {
          supplierId,
          purchaseId: purchaseId ? parseInt(purchaseId) : null,
          type:    'PAYMENT',
          amount:  amt,
          balance: Math.max(0, currentBal - amt),
          note:    `Payment${reference ? ` · ${reference}` : ''}`
        }
      });
    });
    res.json({ success: true, message: `Payment of ₹${amt.toFixed(2)} recorded.` });
  } catch (err) { res.json({ success: false, message: err.message }); }
};
