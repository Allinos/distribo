'use strict';
const { getPrisma } = require('../utils/prisma');

exports.index = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const [
      monthlySales, monthlyVanSales,
      monthlyExpenses,
      lastMonthSales, lastMonthVanSales, lastMonthExpenses,
      totalProducts, totalCustomers,
      recentSales, recentVanSales,
      paymentBreakdown, vanPaymentBreakdown
    ] = await Promise.all([
      // Normal sales this month
      prisma.sale.aggregate({
        where: { saleDate: { gte: startOfMonth }, status: { not: 'CANCELLED' } },
        _sum: { total: true }, _count: true
      }),
      // Van sales this month
      prisma.vanSale.aggregate({
        where: { saleDate: { gte: startOfMonth }, status: { not: 'CANCELLED' } },
        _sum: { total: true }, _count: true
      }),
      // Expenses
      prisma.expense.aggregate({ where: { date: { gte: startOfMonth } }, _sum: { amount: true } }),
      // Last month normal sales
      prisma.sale.aggregate({
        where: { saleDate: { gte: startOfLastMonth, lte: endOfLastMonth }, status: { not: 'CANCELLED' } },
        _sum: { total: true }
      }),
      // Last month van sales
      prisma.vanSale.aggregate({
        where: { saleDate: { gte: startOfLastMonth, lte: endOfLastMonth }, status: { not: 'CANCELLED' } },
        _sum: { total: true }
      }),
      // Last month expenses
      prisma.expense.aggregate({
        where: { date: { gte: startOfLastMonth, lte: endOfLastMonth } },
        _sum: { amount: true }
      }),
      prisma.product.count({ where: { isActive: true } }),
      prisma.customer.count(),
      // Recent normal sales
      prisma.sale.findMany({
        include: { customer: true, items: true },
        orderBy: { createdAt: 'desc' }, take: 5
      }),
      // Recent van sales
      prisma.vanSale.findMany({
        include: { customer: true, items: true, vehicle: { select: { name: true, regNo: true } } },
        orderBy: { createdAt: 'desc' }, take: 5
      }),
      // Payment breakdown — normal
      prisma.sale.groupBy({
        by: ['paymentMode'],
        where: { saleDate: { gte: startOfMonth }, status: { not: 'CANCELLED' } },
        _sum: { total: true }, _count: true
      }),
      // Payment breakdown — van
      prisma.vanSale.groupBy({
        by: ['paymentMode'],
        where: { saleDate: { gte: startOfMonth }, status: { not: 'CANCELLED' } },
        _sum: { total: true }, _count: true
      })
    ]);

    const normalSalesTotal = parseFloat(monthlySales._sum.total || 0);
    const vanSalesTotal    = parseFloat(monthlyVanSales._sum.total || 0);
    const combinedSales    = normalSalesTotal + vanSalesTotal;
    const expensesTotal    = parseFloat(monthlyExpenses._sum.amount || 0);

    const lastNormalTotal  = parseFloat(lastMonthSales._sum.total || 0);
    const lastVanTotal     = parseFloat(lastMonthVanSales._sum.total || 0);
    const lastCombined     = lastNormalTotal + lastVanTotal;
    const lastExpenses     = parseFloat(lastMonthExpenses._sum.amount || 0);

    // Merge payment breakdowns
    const paymentMap = {};
    for (const p of paymentBreakdown) {
      paymentMap[p.paymentMode] = { paymentMode: p.paymentMode, total: parseFloat(p._sum.total || 0), count: p._count };
    }
    for (const p of vanPaymentBreakdown) {
      if (paymentMap[p.paymentMode]) {
        paymentMap[p.paymentMode].total += parseFloat(p._sum.total || 0);
        paymentMap[p.paymentMode].count += p._count;
      } else {
        paymentMap[p.paymentMode] = { paymentMode: p.paymentMode, total: parseFloat(p._sum.total || 0), count: p._count };
      }
    }
    const mergedPayments = Object.values(paymentMap);

    // Low stock
    const lowStockProducts = await prisma.$queryRaw`
      SELECT p.id, p.name, p.sku, p.stock, p.min_stock, c.name as category_name
      FROM products p LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.stock <= p.min_stock AND p.is_active = 1 ORDER BY p.stock ASC LIMIT 10`;

    // 6-month chart data (combined)
    const chartData = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const [mS, mVS, mE] = await Promise.all([
        prisma.sale.aggregate({
          where: { saleDate: { gte: monthStart, lte: monthEnd }, status: { not: 'CANCELLED' } },
          _sum: { total: true }
        }),
        prisma.vanSale.aggregate({
          where: { saleDate: { gte: monthStart, lte: monthEnd }, status: { not: 'CANCELLED' } },
          _sum: { total: true }
        }),
        prisma.expense.aggregate({
          where: { date: { gte: monthStart, lte: monthEnd } },
          _sum: { amount: true }
        })
      ]);
      const normalAmt = parseFloat(mS._sum.total || 0);
      const vanAmt    = parseFloat(mVS._sum.total || 0);
      const expAmt    = parseFloat(mE._sum.amount || 0);
      chartData.push({
        month:    monthStart.toLocaleString('default', { month: 'short' }),
        sales:    normalAmt + vanAmt,
        normal:   normalAmt,
        van:      vanAmt,
        expenses: expAmt,
        profit:   normalAmt + vanAmt - expAmt
      });
    }

    // Merge recent sales: tag each, sort by date, take top 8
    const taggedNormal = recentSales.map(s => ({ ...s, type: 'normal', vehicle: null }));
    const taggedVan    = recentVanSales.map(s => ({ ...s, type: 'van' }));
    const allRecent    = [...taggedNormal, ...taggedVan]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 8);

    res.render('pages/dashboard', {
      title: 'Dashboard',
      stats: {
        sales:          combinedSales,
        normalSales:    normalSalesTotal,
        vanSales:       vanSalesTotal,
        expenses:       expensesTotal,
        profit:         combinedSales - expensesTotal,
        salesCount:     monthlySales._count + monthlyVanSales._count,
        normalCount:    monthlySales._count,
        vanCount:       monthlyVanSales._count,
        totalProducts,
        totalCustomers,
        salesGrowth:    lastCombined ? (((combinedSales - lastCombined) / lastCombined) * 100).toFixed(1) : 0,
        expensesGrowth: lastExpenses ? (((expensesTotal - lastExpenses) / lastExpenses) * 100).toFixed(1) : 0,
      },
      chartData:       JSON.stringify(chartData),
      lowStockProducts,
      recentSales:     allRecent,
      paymentBreakdown: JSON.stringify(mergedPayments)
    });
  } catch (err) {
    console.error(err);
    res.render('pages/dashboard', {
      title: 'Dashboard',
      stats: { sales: 0, normalSales: 0, vanSales: 0, expenses: 0, profit: 0, salesCount: 0, normalCount: 0, vanCount: 0, totalProducts: 0, totalCustomers: 0, salesGrowth: 0, expensesGrowth: 0 },
      chartData: '[]', lowStockProducts: [], recentSales: [], paymentBreakdown: '[]', expiringBatches: [], expiredBatchCount: 0
    });
  }
};
