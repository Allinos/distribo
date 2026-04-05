'use strict';
const { getPrisma } = require('../utils/prisma');
const path = require('path');
const fs = require('fs');

exports.index = async (req, res) => {
  const page = parseInt(req.query.page) || 1, limit = parseInt(req.query.limit) || 15;
  const search = req.query.search || '', category = req.query.category || '', from = req.query.from || '', to = req.query.to || '';
  const skip = (page - 1) * limit;
  const where = {
    ...(search && { title: { contains: search } }),
    ...(category && { categoryId: parseInt(category) }),
    ...(from && to && { date: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } })
  };
  try {
    const prisma = await getPrisma();
    const [expenses, total, categories] = await Promise.all([
      prisma.expense.findMany({ where, include: { category: true, user: { select: { name: true } } }, skip, take: limit, orderBy: { date: 'desc' } }),
      prisma.expense.count({ where }),
      prisma.category.findMany({ orderBy: { name: 'asc' } })
    ]);
    const now = new Date();
    const chartData = [];
    for (let i = 5; i >= 0; i--) {
      const ms = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const me = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const agg = await prisma.expense.aggregate({ where: { date: { gte: ms, lte: me } }, _sum: { amount: true } });
      chartData.push({ month: ms.toLocaleString('default', { month: 'short' }), amount: parseFloat(agg._sum.amount || 0) });
    }
    const categoryBreakdown = await prisma.expense.groupBy({ by: ['categoryId'], _sum: { amount: true }, orderBy: { _sum: { amount: 'desc' } } });
    const catIds = categoryBreakdown.map(c => c.categoryId);
    const cats = await prisma.category.findMany({ where: { id: { in: catIds } } });
    const catMap = Object.fromEntries(cats.map(c => [c.id, c.name]));
    const breakdown = categoryBreakdown.map(c => ({ name: catMap[c.categoryId] || 'Unknown', amount: parseFloat(c._sum.amount || 0) }));
    res.render('pages/expenses/index', { title: 'Expenses', expenses, categories, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, search, category, from, to, chartData: JSON.stringify(chartData), breakdown: JSON.stringify(breakdown) });
  } catch (err) { console.error(err); req.flash('error', 'Failed to load expenses.'); res.redirect('/'); }
};

exports.create = async (req, res) => {
  try {
    const { title, categoryId, amount, date, description } = req.body;
    let attachment = null;
    if (req.files && req.files.attachment) {
      const file = req.files.attachment;
      const filename = `exp_${Date.now()}${path.extname(file.name)}`;
      await file.mv(path.join(__dirname, '../../public/uploads', filename));
      attachment = filename;
    }
    const prisma = await getPrisma();
    await prisma.expense.create({ data: { title, categoryId: parseInt(categoryId), userId: req.session.user.id, amount: parseFloat(amount), date: new Date(date), description, attachment } });
    req.flash('success', 'Expense added successfully.');
  } catch (err) { console.error(err); req.flash('error', 'Failed to add expense.'); }
  res.redirect('/expenses');
};

exports.update = async (req, res) => {
  try {
    const { title, categoryId, amount, date, description } = req.body;
    const prisma = await getPrisma();
    const existing = await prisma.expense.findUnique({ where: { id: parseInt(req.params.id) } });
    let attachment = existing.attachment;
    if (req.files && req.files.attachment) {
      if (existing.attachment) { const op = path.join(__dirname, '../../public/uploads', existing.attachment); if (fs.existsSync(op)) fs.unlinkSync(op); }
      const filename = `exp_${Date.now()}${path.extname(req.files.attachment.name)}`;
      await req.files.attachment.mv(path.join(__dirname, '../../public/uploads', filename));
      attachment = filename;
    }
    await prisma.expense.update({ where: { id: parseInt(req.params.id) }, data: { title, categoryId: parseInt(categoryId), amount: parseFloat(amount), date: new Date(date), description, attachment } });
    req.flash('success', 'Expense updated.');
  } catch (err) { req.flash('error', 'Failed to update expense.'); }
  res.redirect('/expenses');
};

exports.delete = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const expense = await prisma.expense.findUnique({ where: { id: parseInt(req.params.id) } });
    if (expense?.attachment) { const fp = path.join(__dirname, '../../public/uploads', expense.attachment); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
    await prisma.expense.delete({ where: { id: parseInt(req.params.id) } });
    req.flash('success', 'Expense deleted.');
  } catch (err) { req.flash('error', 'Failed to delete expense.'); }
  res.redirect('/expenses');
};
