// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS METHOD to the bottom of your existing warehouseController.js
// ─────────────────────────────────────────────────────────────────────────────

exports.analytics = async (req, res) => {
  const warehouseId = parseInt(req.params.id);
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  const to   = req.query.to   || new Date().toISOString().split('T')[0];

  try {
    const prisma   = await getPrisma();
    const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) { req.flash('error', 'Warehouse not found.'); return res.redirect('/warehouses'); }

    const dateFilter = { gte: new Date(from), lte: new Date(to + 'T23:59:59') };

    const [salesAgg, salesCount] = await Promise.all([
      prisma.sale.aggregate({ where: { warehouseId, saleDate: dateFilter, status: { not: 'CANCELLED' } }, _sum: { total: true, taxAmount: true }, _count: true }),
      prisma.sale.count({ where: { warehouseId, saleDate: dateFilter, status: { not: 'CANCELLED' } } })
    ]);

    // Current inventory
    const stocks = await prisma.warehouseStock.findMany({
      where: { warehouseId },
      include: { product: { select: { name: true, sku: true, price: true, costPrice: true, avgCostPrice: true, minStock: true, unit: true, category: { select: { name: true } } } } }
    });

    const inventoryValue  = stocks.reduce((s, r) => s + r.quantity * parseFloat(r.product.costPrice || 0), 0);
    const inventoryRetail = stocks.reduce((s, r) => s + r.quantity * parseFloat(r.product.price || 0), 0);
    const lowStockItems   = stocks.filter(s => s.quantity > 0 && s.quantity <= s.product.minStock);
    const outOfStockItems = stocks.filter(s => s.quantity === 0);

    // Top products sold from this warehouse
    const topProducts = await prisma.saleItem.groupBy({
      by: ['productId'],
      where: { sale: { warehouseId, saleDate: dateFilter, status: { not: 'CANCELLED' } } },
      _sum: { quantity: true, total: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 10
    });
    const prodDetails = await prisma.product.findMany({
      where: { id: { in: topProducts.map(p => p.productId) } },
      select: { id: true, name: true, sku: true, unit: true }
    });
    const prodMap = Object.fromEntries(prodDetails.map(p => [p.id, p]));
    const topProductsEnriched = topProducts.map(p => ({
      ...prodMap[p.productId], qty: p._sum.quantity, revenue: parseFloat(p._sum.total || 0)
    }));

    // Payment breakdown
    const paymentBreakdown = await prisma.sale.groupBy({
      by: ['paymentMode'],
      where: { warehouseId, saleDate: dateFilter, status: { not: 'CANCELLED' } },
      _sum: { total: true }, _count: true
    });

    // All warehouses for switcher
    const warehouses = await prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: 'desc' } });

    // 30-day daily sales trend
    const trendData = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d  = new Date(today); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      const dayAgg = await prisma.sale.aggregate({
        where: { warehouseId, saleDate: { gte: new Date(ds), lte: new Date(ds + 'T23:59:59') }, status: { not: 'CANCELLED' } },
        _sum: { total: true }
      });
      trendData.push({ date: ds, total: parseFloat(dayAgg._sum.total || 0) });
    }

    res.render('pages/warehouses/analytics', {
      title:    `Analytics — ${warehouse.name}`,
      warehouse, warehouses, stocks, lowStockItems, outOfStockItems,
      summary: {
        totalSales:      parseFloat(salesAgg._sum.total || 0),
        totalTax:        parseFloat(salesAgg._sum.taxAmount || 0),
        salesCount,
        inventoryValue,
        inventoryRetail,
        stockItems:      stocks.length,
        lowStockCount:   lowStockItems.length,
        outOfStockCount: outOfStockItems.length
      },
      topProducts:      topProductsEnriched,
      paymentBreakdown: JSON.stringify(paymentBreakdown),
      trendData:        JSON.stringify(trendData),
      from, to
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load analytics.');
    res.redirect('/warehouses');
  }
};
