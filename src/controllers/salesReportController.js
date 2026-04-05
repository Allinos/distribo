'use strict';
const { getPrisma } = require('../utils/prisma');

exports.index = async (req, res) => {
  try {
    const prisma = await getPrisma();

    // Month/Year from query, default to current month
    const now       = new Date();
    const year      = parseInt(req.query.year)  || now.getFullYear();
    const month     = parseInt(req.query.month) || (now.getMonth() + 1);
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd   = new Date(year, month, 0, 23, 59, 59);

    // ── 1. Month summary ────────────────────────────────────────────────────────
    const [normalAgg, vanAgg, expenseAgg] = await Promise.all([
      prisma.sale.aggregate({
        where: { saleDate: { gte: monthStart, lte: monthEnd }, status: { not: 'CANCELLED' } },
        _sum: { total: true, subtotal: true, taxAmount: true, discount: true },
        _count: true,
      }),
      prisma.vanSale.aggregate({
        where: { saleDate: { gte: monthStart, lte: monthEnd }, status: { not: 'CANCELLED' } },
        _sum: { total: true, subtotal: true, taxAmount: true, discount: true },
        _count: true,
      }),
      prisma.expense.aggregate({
        where: { date: { gte: monthStart, lte: monthEnd } },
        _sum: { amount: true },
      }),
    ]);

    const summary = {
      normalTotal:   parseFloat(normalAgg._sum.total    || 0),
      vanTotal:      parseFloat(vanAgg._sum.total       || 0),
      combinedTotal: parseFloat(normalAgg._sum.total || 0) + parseFloat(vanAgg._sum.total || 0),
      totalTax:      parseFloat(normalAgg._sum.taxAmount || 0) + parseFloat(vanAgg._sum.taxAmount || 0),
      totalDiscount: parseFloat(normalAgg._sum.discount  || 0) + parseFloat(vanAgg._sum.discount  || 0),
      normalCount:   normalAgg._count,
      vanCount:      vanAgg._count,
      totalCount:    normalAgg._count + vanAgg._count,
      expenses:      parseFloat(expenseAgg._sum.amount || 0),
    };
    summary.profit = summary.combinedTotal - summary.expenses;

    // ── 2. Daily sales for calendar (all days of the month) ─────────────────────
    const daysInMonth = new Date(year, month, 0).getDate();

    // Fetch all sales for the month (normal + van)
    const [normalSales, vanSales] = await Promise.all([
      prisma.sale.findMany({
        where: { saleDate: { gte: monthStart, lte: monthEnd }, status: { not: 'CANCELLED' } },
        select: { saleDate: true, total: true },
      }),
      prisma.vanSale.findMany({
        where: { saleDate: { gte: monthStart, lte: monthEnd }, status: { not: 'CANCELLED' } },
        select: { saleDate: true, total: true },
      }),
    ]);

    // Build day-by-day map
    const dailyMap = {};
    for (let d = 1; d <= daysInMonth; d++) dailyMap[d] = { day: d, normal: 0, van: 0, total: 0, count: 0 };

    normalSales.forEach(s => {
      const d = new Date(s.saleDate).getDate();
      if (dailyMap[d]) { dailyMap[d].normal += parseFloat(s.total); dailyMap[d].total += parseFloat(s.total); dailyMap[d].count++; }
    });
    vanSales.forEach(s => {
      const d = new Date(s.saleDate).getDate();
      if (dailyMap[d]) { dailyMap[d].van += parseFloat(s.total); dailyMap[d].total += parseFloat(s.total); dailyMap[d].count++; }
    });

    const dailyData = Object.values(dailyMap);
    const maxDailyTotal = Math.max(...dailyData.map(d => d.total), 1);

    // ── 3. Date-wise detail (all sales with full info, grouped by date) ──────────
    const [allNormal, allVan] = await Promise.all([
      prisma.sale.findMany({
        where: { saleDate: { gte: monthStart, lte: monthEnd } },
        include: { customer: true, items: { include: { product: true } }, user: { select: { name: true } } },
        orderBy: { saleDate: 'asc' },
      }),
      prisma.vanSale.findMany({
        where: { saleDate: { gte: monthStart, lte: monthEnd } },
        include: { customer: true, vehicle: true, items: { include: { product: true } }, user: { select: { name: true } } },
        orderBy: { saleDate: 'asc' },
      }),
    ]);

    // Merge and group by date string
    const allSalesTagged = [
      ...allNormal.map(s => ({ ...s, _type: 'normal' })),
      ...allVan.map(s => ({ ...s, _type: 'van' })),
    ].sort((a, b) => new Date(a.saleDate) - new Date(b.saleDate));

    const byDate = {};
    allSalesTagged.forEach(s => {
      const dateKey = new Date(s.saleDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      if (!byDate[dateKey]) byDate[dateKey] = { dateKey, sales: [], total: 0, count: 0 };
      byDate[dateKey].sales.push(s);
      if (s.status !== 'CANCELLED') { byDate[dateKey].total += parseFloat(s.total); byDate[dateKey].count++; }
    });

    // ── 4. Product-wise sales in the month ───────────────────────────────────────
    // Aggregate sale_items + van_sale_items
    const [normalItems, vanItems] = await Promise.all([
      prisma.saleItem.findMany({
        where: { sale: { saleDate: { gte: monthStart, lte: monthEnd }, status: { not: 'CANCELLED' } } },
        include: { product: { include: { category: true } } },
      }),
      prisma.vanSaleItem.findMany({
        where: { vanSale: { saleDate: { gte: monthStart, lte: monthEnd }, status: { not: 'CANCELLED' } } },
        include: { product: { include: { category: true } } },
      }),
    ]);

    const productMap = {};
    [...normalItems, ...vanItems].forEach(item => {
      const pid = item.productId;
      if (!productMap[pid]) {
        productMap[pid] = {
          id: pid,
          name: item.product.name,
          sku: item.product.sku,
          category: item.product.category.name,
          unit: item.product.unit,
          qty: 0,
          revenue: 0,
        };
      }
      productMap[pid].qty     += item.quantity;
      productMap[pid].revenue += parseFloat(item.total);
    });

    const productSales = Object.values(productMap)
      .sort((a, b) => b.revenue - a.revenue);

    // ── 5. Payment mode breakdown ────────────────────────────────────────────────
    const [normalPayments, vanPayments] = await Promise.all([
      prisma.sale.groupBy({
        by: ['paymentMode'],
        where: { saleDate: { gte: monthStart, lte: monthEnd }, status: { not: 'CANCELLED' } },
        _sum: { total: true }, _count: true,
      }),
      prisma.vanSale.groupBy({
        by: ['paymentMode'],
        where: { saleDate: { gte: monthStart, lte: monthEnd }, status: { not: 'CANCELLED' } },
        _sum: { total: true }, _count: true,
      }),
    ]);

    const payMap = {};
    [...normalPayments, ...vanPayments].forEach(p => {
      if (!payMap[p.paymentMode]) payMap[p.paymentMode] = { mode: p.paymentMode, total: 0, count: 0 };
      payMap[p.paymentMode].total += parseFloat(p._sum.total || 0);
      payMap[p.paymentMode].count += p._count;
    });
    const paymentBreakdown = Object.values(payMap);

    // ── 6. Month list for selector (last 24 months) ──────────────────────────────
    const monthOptions = [];
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthOptions.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: d.toLocaleString('default', { month: 'long', year: 'numeric' }) });
    }

    // ── 7. Week-wise breakdown ───────────────────────────────────────────────────
    const weeks = [
      { label: 'Week 1', days: [1,7] },
      { label: 'Week 2', days: [8,14] },
      { label: 'Week 3', days: [15,21] },
      { label: 'Week 4', days: [22, daysInMonth] },
    ];
    const weekData = weeks.map(w => {
      const total = dailyData.filter(d => d.day >= w.days[0] && d.day <= w.days[1]).reduce((s, d) => s + d.total, 0);
      return { label: w.label, total };
    });

    res.render('pages/sales/reports', {
      title: 'Sales Reports',
      year, month,
      monthLabel: monthStart.toLocaleString('default', { month: 'long', year: 'numeric' }),
      monthOptions,
      summary,
      dailyData:        JSON.stringify(dailyData),
      dailyDataRaw:     dailyData,
      maxDailyTotal,
      byDate,
      productSales,
      paymentBreakdown: JSON.stringify(paymentBreakdown),
      weekData:         JSON.stringify(weekData),
      daysInMonth,
      firstDayOfWeek:   new Date(year, month - 1, 1).getDay(), // 0=Sun
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load sales report.');
    res.redirect('/sales');
  }
};
