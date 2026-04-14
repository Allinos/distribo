'use strict';
const { getPrisma } = require('../utils/prisma');

// Helper: add ledger entry with running balance
async function addLedgerEntry(tx, customerId, saleId, type, amount, note) {
  if (!customerId) return;
  const last = await tx.customerLedger.findFirst({
    where: { customerId }, orderBy: { createdAt: 'desc' }
  });
  const currentBalance = last ? parseFloat(last.balance) : 0;
  // SALE increases balance (customer owes more), PAYMENT decreases it
  const newBalance = (type === 'SALE')
    ? currentBalance + amount
    : currentBalance - amount;
  await tx.customerLedger.create({
    data: { customerId, saleId, type, amount, balance: newBalance, note }
  });
}
exports.addLedgerEntry = addLedgerEntry;

exports.index = async (req, res) => {
  const page = parseInt(req.query.page) || 1, limit = 15;
  const search = req.query.search || '', skip = (page - 1) * limit;
  const where = search ? { OR: [{ name: { contains: search } }, { email: { contains: search } }, { phone: { contains: search } }] } : {};
  try {
    const prisma = await getPrisma();
    const [customers, total] = await Promise.all([
      prisma.customer.findMany({ where, skip, take: limit, orderBy: { name: 'asc' } }),
      prisma.customer.count({ where })
    ]);
    // Enrich each customer with balance + purchase stats
    const enriched = await Promise.all(customers.map(async c => {
      const [lastLedger, saleAgg] = await Promise.all([
        prisma.customerLedger.findFirst({ where: { customerId: c.id }, orderBy: { createdAt: 'desc' } }),
        prisma.sale.aggregate({ where: { customerId: c.id, status: { not: 'CANCELLED' } }, _sum: { total: true }, _count: true })
      ]);
      return {
        ...c,
        balance:        lastLedger ? parseFloat(lastLedger.balance) : 0,
        totalPurchases: parseFloat(saleAgg._sum.total || 0),
        purchaseCount:  saleAgg._count
      };
    }));
    res.render('pages/customers/index', {
      title: 'Customers', customers: enriched,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      search
    });
  } catch (err) { req.flash('error', 'Failed to load customers.'); res.redirect('/'); }
};

exports.create = async (req, res) => {
  const { name, email, phone, address, gstin } = req.body;
  try {
    const prisma = await getPrisma();
    await prisma.customer.create({ data: { name, email: email || null, phone: phone || null, address: address || null, gstin: gstin || null } });
    req.flash('success', 'Customer added.');
  } catch (err) { req.flash('error', 'Failed to add customer.'); }
  res.redirect('/customers');
};

exports.update = async (req, res) => {
  const { name, email, phone, address, gstin } = req.body;
  try {
    const prisma = await getPrisma();
    await prisma.customer.update({ where: { id: parseInt(req.params.id) }, data: { name, email: email || null, phone: phone || null, address: address || null, gstin: gstin || null } });
    req.flash('success', 'Customer updated.');
  } catch (err) { req.flash('error', 'Failed to update.'); }
  res.redirect('/customers');
};

exports.delete = async (req, res) => {
  try {
    const prisma = await getPrisma();
    await prisma.customer.delete({ where: { id: parseInt(req.params.id) } });
    req.flash('success', 'Customer deleted.');
  } catch (err) { req.flash('error', 'Cannot delete customer with sales records.'); }
  res.redirect('/customers');
};

exports.apiList = async (req, res) => {
  const search = req.query.search || '';
  const prisma = await getPrisma();
  const customers = await prisma.customer.findMany({
    where: search ? { name: { contains: search } } : {},
    select: { id: true, name: true, email: true, phone: true },
    take: 20
  });
  res.json(customers);
};

// ─── Customer Ledger / Statement ───────────────────────────────────────────────
exports.ledger = async (req, res) => {
  const customerId = parseInt(req.params.id);
  const from = req.query.from || '';
  const to   = req.query.to   || '';
  try {
    const prisma = await getPrisma();
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) { req.flash('error', 'Customer not found.'); return res.redirect('/customers'); }

    const dateFilter = from && to
      ? { gte: new Date(from), lte: new Date(to + 'T23:59:59') }
      : undefined;

    const [sales, ledger] = await Promise.all([
      prisma.sale.findMany({
        where: { customerId, ...(dateFilter && { saleDate: dateFilter }) },
        include: { items: { include: { product: { select: { name: true } } } }, payments: true },
        orderBy: { saleDate: 'desc' }
      }),
      prisma.customerLedger.findMany({
        where: { customerId, ...(dateFilter && { createdAt: dateFilter }) },
        orderBy: { createdAt: 'asc' }
      })
    ]);

    const activeSales   = sales.filter(s => s.status !== 'CANCELLED');
    const totalSales    = activeSales.reduce((s, r) => s + parseFloat(r.total), 0);
    const totalPaid     = activeSales.reduce((s, r) => s + parseFloat(r.amountPaid || 0), 0);
    const pendingDue    = totalSales - totalPaid;
    const pendingInvoices = sales.filter(s => s.status === 'PARTIAL' || s.status === 'UNPAID');

    res.render('pages/customers/ledger', {
      title: `${customer.name} — Ledger`,
      customer, sales, ledger, pendingInvoices,
      summary: { totalSales, totalPaid, pendingDue },
      from, to
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load ledger.');
    res.redirect('/customers');
  }
};

// ─── Record payment against a specific invoice ─────────────────────────────────
exports.recordPayment = async (req, res) => {
  const customerId = parseInt(req.params.id);
  const { saleId, mode, amount, reference } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.json({ success: false, message: 'Enter a valid amount.' });
  try {
    const prisma = await getPrisma();
    const sale = await prisma.sale.findUnique({ where: { id: parseInt(saleId) } });
    if (!sale) return res.json({ success: false, message: 'Invoice not found.' });
    const remaining = parseFloat(sale.total) - parseFloat(sale.amountPaid || 0);
    if (amt > remaining + 0.01) return res.json({ success: false, message: `Amount ₹${amt} exceeds due ₹${remaining.toFixed(2)}` });

    await prisma.$transaction(async (tx) => {
      await tx.salePayment.create({ data: { saleId: parseInt(saleId), mode, amount: amt, reference: reference || null } });
      const newPaid   = parseFloat(sale.amountPaid || 0) + amt;
      const newStatus = newPaid >= parseFloat(sale.total) - 0.01 ? 'PAID' : 'PARTIAL';
      await tx.sale.update({ where: { id: parseInt(saleId) }, data: { amountPaid: newPaid, status: newStatus } });
      await addLedgerEntry(tx, customerId, parseInt(saleId), 'PAYMENT', amt, `Payment on ${sale.invoiceNo}`);
    });

    res.json({ success: true, message: `₹${amt.toFixed(2)} recorded successfully.` });
  } catch (err) { res.json({ success: false, message: err.message }); }
};
