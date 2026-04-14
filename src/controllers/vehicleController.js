'use strict';
const { getPrisma } = require('../utils/prisma');

// ─── Helper: sync product.stock = sum of all warehouseStocks ─────────────────
// Call this after any warehouseStock change to keep product.stock consistent
async function syncProductStock(tx, productId) {
  const allWH = await tx.warehouseStock.findMany({ where: { productId } });
  const whTotal = allWH.reduce((s, r) => s + r.quantity, 0);
  // Also add any vehicle stock (vehicle stock is NOT in warehouseStock table)
  const allVS = await tx.vehicleStock.findMany({ where: { productId } });
  const vsTotal = allVS.reduce((s, r) => s + r.quantity, 0);
  await tx.product.update({ where: { id: productId }, data: { stock: whTotal + vsTotal } });
}

// ─── Vehicles CRUD ────────────────────────────────────────────────────────────
exports.index = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const [vehicles, users] = await Promise.all([
      prisma.vehicle.findMany({
        include: {
          driver: { select: { id: true, name: true } },
          stocks: { include: { product: true } },
          _count: { select: { vanSales: true } }
        },
        orderBy: { name: 'asc' }
      }),
      prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true } })
    ]);
    res.render('pages/vehicles/index', { title: 'Vehicles', vehicles, users });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load vehicles.');
    res.redirect('/');
  }
};

exports.create = async (req, res) => {
  const { name, regNo, driverId } = req.body;
  try {
    const prisma = await getPrisma();
    await prisma.vehicle.create({ data: { name, regNo, driverId: driverId ? parseInt(driverId) : null } });
    req.flash('success', 'Vehicle added.');
  } catch (err) {
    req.flash('error', err.code === 'P2002' ? 'Registration number already exists.' : 'Failed to add vehicle.');
  }
  res.redirect('/vehicles');
};

exports.update = async (req, res) => {
  const { name, regNo, driverId } = req.body;
  try {
    const prisma = await getPrisma();
    await prisma.vehicle.update({
      where: { id: parseInt(req.params.id) },
      data: { name, regNo, driverId: driverId ? parseInt(driverId) : null }
    });
    req.flash('success', 'Vehicle updated.');
  } catch (err) { req.flash('error', 'Failed to update.'); }
  res.redirect('/vehicles');
};

exports.delete = async (req, res) => {
  try {
    const prisma = await getPrisma();
    await prisma.vehicle.update({ where: { id: parseInt(req.params.id) }, data: { isActive: false } });
    req.flash('success', 'Vehicle deactivated.');
  } catch (err) { req.flash('error', 'Failed to deactivate.'); }
  res.redirect('/vehicles');
};

// ─── Stock Assignment ─────────────────────────────────────────────────────────
exports.showStock = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        driver: { select: { name: true } },
        stocks: { include: { product: { include: { category: true } } } }
      }
    });
    if (!vehicle) { req.flash('error', 'Vehicle not found.'); return res.redirect('/vehicles'); }

    // Show products that have warehouse stock OR are already on the vehicle
    const products = await prisma.product.findMany({
      where: { isActive: true },
      include: {
        category: true,
        warehouseStocks: true
      },
      orderBy: { name: 'asc' }
    });

    // Build a map of vehicleStock for this vehicle
    const vsMap = Object.fromEntries(vehicle.stocks.map(s => [s.productId, s.quantity]));

    // Enrich products with warehouse total and vehicle stock
    const enriched = products.map(p => {
      const whStock = p.warehouseStocks.reduce((sum, ws) => sum + ws.quantity, 0);
      return {
        ...p,
        warehouseStock: whStock,
        vehicleStock: vsMap[p.id] || 0
      };
    }).filter(p => p.warehouseStock > 0 || p.vehicleStock > 0);

    res.render('pages/vehicles/stock', {
      title: `Stock — ${vehicle.name}`,
      vehicle,
      products: enriched
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load stock.');
    res.redirect('/vehicles');
  }
};

/**
 * LOAD stock onto vehicle:
 *   warehouse stock  → decrements
 *   vehicle stock    → increments
 *   product.stock    → unchanged (vehicle stock IS part of product.stock)
 *
 * WHY product.stock stays the same:
 *   product.stock = warehouse stock + all vehicle stocks
 *   We're moving from one bucket to another — the total doesn't change.
 */
exports.assignStock = async (req, res) => {
  const vehicleId = parseInt(req.params.id);
  const { productId, quantity, warehouseId } = req.body;
  const qty = parseInt(quantity);
  const pid = parseInt(productId);

  if (!productId || qty <= 0) return res.json({ success: false, message: 'Invalid product or quantity.' });

  try {
    const prisma = await getPrisma();

    // Determine source warehouse
    // If warehouseId passed, use it. Otherwise find the warehouse with most stock.
    let sourceWarehouseId = warehouseId ? parseInt(warehouseId) : null;

    if (!sourceWarehouseId) {
      // Auto-pick warehouse with most stock for this product
      const whStocks = await prisma.warehouseStock.findMany({
        where: { productId: pid, quantity: { gt: 0 } },
        orderBy: { quantity: 'desc' }
      });
      if (!whStocks.length) {
        return res.json({ success: false, message: 'No warehouse stock available for this product.' });
      }
      sourceWarehouseId = whStocks[0].warehouseId;
    }

    const ws = await prisma.warehouseStock.findUnique({
      where: { warehouseId_productId: { warehouseId: sourceWarehouseId, productId: pid } }
    });
    const available = ws ? ws.quantity : 0;
    if (available < qty) {
      return res.json({ success: false, message: `Insufficient warehouse stock. Available in warehouse: ${available}` });
    }

    const product = await prisma.product.findUnique({ where: { id: pid }, select: { name: true, unit: true } });

    await prisma.$transaction(async (tx) => {
      // 1. Deduct from warehouse stock
      await tx.warehouseStock.update({
        where: { warehouseId_productId: { warehouseId: sourceWarehouseId, productId: pid } },
        data: { quantity: { decrement: qty } }
      });

      // 2. Add to vehicle stock
      const existing = await tx.vehicleStock.findUnique({
        where: { vehicleId_productId: { vehicleId, productId: pid } }
      });
      if (existing) {
        await tx.vehicleStock.update({
          where: { vehicleId_productId: { vehicleId, productId: pid } },
          data: { quantity: { increment: qty } }
        });
      } else {
        await tx.vehicleStock.create({ data: { vehicleId, productId: pid, quantity: qty } });
      }

      // 3. product.stock stays the same — we moved stock between buckets, not removed it
      // But re-sync to be safe (handles any drift)
      await syncProductStock(tx, pid);
    });

    res.json({ success: true, message: `${qty} ${product.unit} of "${product.name}" loaded onto vehicle.` });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Failed to assign stock: ' + err.message });
  }
};

/**
 * RETURN stock from vehicle to warehouse:
 *   vehicle stock    → decrements
 *   warehouse stock  → increments
 *   product.stock    → unchanged (still moving between buckets)
 */
exports.returnStock = async (req, res) => {
  const vehicleId = parseInt(req.params.id);
  const { productId, quantity, warehouseId } = req.body;
  const qty = parseInt(quantity);
  const pid = parseInt(productId);

  try {
    const prisma = await getPrisma();

    const vs = await prisma.vehicleStock.findUnique({
      where: { vehicleId_productId: { vehicleId, productId: pid } },
      include: { product: { select: { name: true, unit: true } } }
    });
    if (!vs || vs.quantity < qty) {
      return res.json({ success: false, message: `Not enough vehicle stock to return. On vehicle: ${vs ? vs.quantity : 0}` });
    }

    // Determine destination warehouse
    let destWarehouseId = warehouseId ? parseInt(warehouseId) : null;
    if (!destWarehouseId) {
      // Default warehouse or first active warehouse
      const defaultWH = await prisma.warehouse.findFirst({ where: { isDefault: true, isActive: true } });
      const anyWH     = await prisma.warehouse.findFirst({ where: { isActive: true } });
      destWarehouseId = (defaultWH || anyWH)?.id || null;
    }

    await prisma.$transaction(async (tx) => {
      // 1. Deduct from vehicle stock
      await tx.vehicleStock.update({
        where: { vehicleId_productId: { vehicleId, productId: pid } },
        data: { quantity: { decrement: qty } }
      });

      // 2. Return to warehouse stock
      if (destWarehouseId) {
        const existingWS = await tx.warehouseStock.findUnique({
          where: { warehouseId_productId: { warehouseId: destWarehouseId, productId: pid } }
        });
        if (existingWS) {
          await tx.warehouseStock.update({
            where: { warehouseId_productId: { warehouseId: destWarehouseId, productId: pid } },
            data: { quantity: { increment: qty } }
          });
        } else {
          await tx.warehouseStock.create({
            data: { warehouseId: destWarehouseId, productId: pid, quantity: qty }
          });
        }
      }

      // 3. Sync product.stock
      await syncProductStock(tx, pid);
    });

    const whName = destWarehouseId
      ? (await prisma.warehouse.findUnique({ where: { id: destWarehouseId }, select: { name: true } }))?.name
      : 'warehouse';

    res.json({ success: true, message: `${qty} ${vs.product.unit} returned to ${whName}.` });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Failed to return stock: ' + err.message });
  }
};

// ─── Van Sales ────────────────────────────────────────────────────────────────
exports.vanSalesIndex = async (req, res) => {
  const page = parseInt(req.query.page) || 1, limit = 15;
  const vehicleId = req.query.vehicle || '', from = req.query.from || '', to = req.query.to || '';
  const skip = (page - 1) * limit;
  const where = {
    ...(vehicleId && { vehicleId: parseInt(vehicleId) }),
    ...(from && to && { saleDate: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } })
  };
  try {
    const prisma = await getPrisma();
    const [vanSales, total, vehicles] = await Promise.all([
      prisma.vanSale.findMany({
        where,
        include: {
          vehicle: true, customer: true, items: true,
          user:      { select: { name: true } },
          updatedBy: { select: { name: true } }
        },
        skip, take: limit, orderBy: { createdAt: 'desc' }
      }),
      prisma.vanSale.count({ where }),
      prisma.vehicle.findMany({ where: { isActive: true } })
    ]);

    const vehicleSummary = await prisma.vanSale.groupBy({
      by: ['vehicleId'], _sum: { total: true }, _count: true,
      where: { status: { not: 'CANCELLED' } }
    });
    const vIds  = vehicleSummary.map(v => v.vehicleId);
    const vList = await prisma.vehicle.findMany({ where: { id: { in: vIds } }, select: { id: true, name: true } });
    const vMap  = Object.fromEntries(vList.map(v => [v.id, v.name]));
    const summary = vehicleSummary.map(v => ({
      name:  vMap[v.vehicleId] || 'Unknown',
      total: parseFloat(v._sum.total || 0),
      count: v._count
    }));

    res.render('pages/vehicles/sales', {
      title: 'Van Sales', vanSales, vehicles,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      vehicleId, from, to,
      summary: JSON.stringify(summary)
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load van sales.');
    res.redirect('/');
  }
};

exports.showCreateVanSale = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const vehicles  = await prisma.vehicle.findMany({ where: { isActive: true }, include: { stocks: { include: { product: true } } } });
    const customers = await prisma.customer.findMany({ orderBy: { name: 'asc' } });
    const count     = await prisma.vanSale.count();
    const invoiceNo = `VS-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
    res.render('pages/vehicles/create-sale', { title: 'New Van Sale', vehicles, customers, invoiceNo });
  } catch (err) {
    req.flash('error', 'Failed to load form.');
    res.redirect('/vehicles/sales');
  }
};

/**
 * CREATE van sale:
 *   vehicle stock → decrements
 *   product.stock → decrements (van sale IS a real sale — stock leaves the system)
 *   warehouseStock → NOT touched (product was already moved off warehouse when loaded onto van)
 */
exports.createVanSale = async (req, res) => {
  const { vehicleId, customerId, paymentMode, discount, notes, items, invoiceNo } = req.body;
  if (!vehicleId) return res.json({ success: false, message: 'Please select a vehicle.' });
  if (!items || !Array.isArray(items) || !items.length) return res.json({ success: false, message: 'No items in sale.' });

  try {
    const prisma = await getPrisma();
    const vid = parseInt(vehicleId);
    let subtotal = 0, taxAmount = 0;
    const saleItems = [];

    // Validate all items first (outside transaction for cleaner error messages)
    for (const item of items) {
      const pid = parseInt(item.productId);
      const qty = parseInt(item.quantity);
      const vs  = await prisma.vehicleStock.findUnique({
        where: { vehicleId_productId: { vehicleId: vid, productId: pid } },
        include: { product: { select: { name: true, unit: true, avgCostPrice: true } } }
      });
      if (!vs) return res.json({ success: false, message: `Product not loaded on this vehicle.` });
      if (vs.quantity < qty) return res.json({ success: false, message: `Insufficient vehicle stock for "${vs.product.name}". On vehicle: ${vs.quantity}` });

      const base = parseFloat(item.price) * qty;
      const tax  = (base * parseFloat(item.tax || 0)) / 100;
      subtotal += base; taxAmount += tax;
      saleItems.push({
        productId: pid,
        quantity:  qty,
        price:     parseFloat(item.price),
        costPrice: parseFloat(vs.product.avgCostPrice || 0),
        tax:       parseFloat(item.tax || 0),
        total:     base + tax
      });
    }

    const discountAmt = parseFloat(discount || 0);

    const sale = await prisma.$transaction(async (tx) => {
      const s = await tx.vanSale.create({
        data: {
          invoiceNo:  invoiceNo || `VS-${Date.now()}`,
          vehicleId:  vid,
          customerId: customerId ? parseInt(customerId) : null,
          userId:     req.session.user.id,
          subtotal, taxAmount,
          discount:   discountAmt,
          total:      subtotal + taxAmount - discountAmt,
          paymentMode: paymentMode || 'CASH',
          notes,
          items: { create: saleItems }
        }
      });

      for (const item of saleItems) {
        // 1. Deduct from vehicle stock
        await tx.vehicleStock.update({
          where: { vehicleId_productId: { vehicleId: vid, productId: item.productId } },
          data: { quantity: { decrement: item.quantity } }
        });

        // 2. Deduct from product.stock — van sale removes stock from the system
        await tx.product.update({
          where: { id: item.productId },
          data:  { stock: { decrement: item.quantity } }
        });
      }

      return s;
    });

    res.json({ success: true, saleId: sale.id, message: 'Van sale recorded successfully.' });
  } catch (err) {
    console.error(err);
    res.json({
      success: false,
      message: err.code === 'P2002' ? 'Invoice number already exists.' : 'Failed to create van sale.'
    });
  }
};

// ─── Van Sale Show ─────────────────────────────────────────────────────────────
exports.showVanSale = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const sale = await prisma.vanSale.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        vehicle:   true,
        customer:  true,
        items:     { include: { product: { include: { category: true } } } },
        user:      { select: { name: true } },
        updatedBy: { select: { name: true } }
      }
    });
    if (!sale) { req.flash('error', 'Van sale not found.'); return res.redirect('/vehicles/sales'); }
    const settings   = await prisma.setting.findMany();
    const sm         = Object.fromEntries(settings.map(s => [s.key, s.value]));
    res.render('pages/vehicles/show-sale', {
      title: `Van Sale ${sale.invoiceNo}`,
      sale,
      currency:    sm.currency    || '₹',
      companyName: sm.company_name || 'My Company'
    });
  } catch (err) {
    req.flash('error', 'Failed to load van sale.');
    res.redirect('/vehicles/sales');
  }
};

// ─── Van Sale Edit ─────────────────────────────────────────────────────────────
exports.showEditVanSale = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const [sale, customers] = await Promise.all([
      prisma.vanSale.findUnique({
        where: { id: parseInt(req.params.id) },
        include: {
          vehicle:   { include: { stocks: { include: { product: true } } } },
          customer:  true,
          items:     { include: { product: true } },
          updatedBy: { select: { name: true } }
        }
      }),
      prisma.customer.findMany({ orderBy: { name: 'asc' } })
    ]);
    if (!sale) { req.flash('error', 'Van sale not found.'); return res.redirect('/vehicles/sales'); }
    if (sale.status === 'CANCELLED') { req.flash('error', 'Cannot edit a cancelled sale.'); return res.redirect('/vehicles/sales'); }
    res.render('pages/vehicles/edit-sale', { title: `Edit ${sale.invoiceNo}`, sale, customers });
  } catch (err) {
    req.flash('error', 'Failed to load edit form.');
    res.redirect('/vehicles/sales');
  }
};

// ─── Van Sale Update ───────────────────────────────────────────────────────────
exports.updateVanSale = async (req, res) => {
  const saleId = parseInt(req.params.id);
  const { customerId, paymentMode, discount, notes, status, saleDate, items } = req.body;
  if (!items || !Array.isArray(items) || !items.length)
    return res.json({ success: false, message: 'Sale must have at least one item.' });

  try {
    const prisma = await getPrisma();
    const existing = await prisma.vanSale.findUnique({
      where: { id: saleId },
      include: { items: true }
    });
    if (!existing) return res.json({ success: false, message: 'Van sale not found.' });
    if (existing.status === 'CANCELLED') return res.json({ success: false, message: 'Cannot edit a cancelled sale.' });

    const vid = existing.vehicleId;

    // Build new items with cost price
    let subtotal = 0, taxAmount = 0;
    const newItems = [];
    for (const item of items) {
      const pid = parseInt(item.productId);
      const qty = parseInt(item.quantity);
      const prod = await prisma.product.findUnique({ where: { id: pid }, select: { avgCostPrice: true } });
      const base = parseFloat(item.price) * qty;
      const tax  = (base * parseFloat(item.tax || 0)) / 100;
      subtotal += base; taxAmount += tax;
      newItems.push({ productId: pid, quantity: qty, price: parseFloat(item.price), costPrice: parseFloat(prod?.avgCostPrice || 0), tax: parseFloat(item.tax || 0), total: base + tax });
    }
    const discountAmt = parseFloat(discount || 0);

    await prisma.$transaction(async (tx) => {
      // 1. Restore old items — put qty back on vehicle and product
      for (const old of existing.items) {
        await tx.vehicleStock.update({
          where: { vehicleId_productId: { vehicleId: vid, productId: old.productId } },
          data:  { quantity: { increment: old.quantity } }
        });
        await tx.product.update({
          where: { id: old.productId },
          data:  { stock: { increment: old.quantity } }
        });
      }

      // 2. Validate new items against vehicle stock (which is now restored)
      for (const item of newItems) {
        const vs = await tx.vehicleStock.findUnique({
          where: { vehicleId_productId: { vehicleId: vid, productId: item.productId } }
        });
        const avail = vs ? vs.quantity : 0;
        if (avail < item.quantity) {
          const p = await tx.product.findUnique({ where: { id: item.productId }, select: { name: true } });
          throw new Error(`Insufficient vehicle stock for "${p.name}". Available: ${avail}`);
        }
      }

      // 3. Replace items and deduct new quantities
      await tx.vanSaleItem.deleteMany({ where: { vanSaleId: saleId } });
      await tx.vanSaleItem.createMany({ data: newItems.map(i => ({ ...i, vanSaleId: saleId })) });

      for (const item of newItems) {
        await tx.vehicleStock.update({
          where: { vehicleId_productId: { vehicleId: vid, productId: item.productId } },
          data:  { quantity: { decrement: item.quantity } }
        });
        await tx.product.update({
          where: { id: item.productId },
          data:  { stock: { decrement: item.quantity } }
        });
      }

      // 4. Update sale header
      await tx.vanSale.update({
        where: { id: saleId },
        data: {
          customerId:  customerId  ? parseInt(customerId)  : null,
          paymentMode: paymentMode || 'CASH',
          status:      status      || existing.status,
          discount:    discountAmt,
          subtotal, taxAmount,
          total:       subtotal + taxAmount - discountAmt,
          notes,
          saleDate:    saleDate ? new Date(saleDate) : existing.saleDate,
          updatedById: req.session.user.id
        }
      });
    });

    res.json({ success: true, message: 'Van sale updated successfully.', saleId });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.message || 'Failed to update van sale.' });
  }
};

// ─── Van Sale Cancel ───────────────────────────────────────────────────────────
exports.cancelVanSale = async (req, res) => {
  try {
    const prisma = await getPrisma();
    const sale = await prisma.vanSale.findUnique({ where: { id: parseInt(req.params.id) }, include: { items: true } });
    if (!sale || sale.status === 'CANCELLED') {
      req.flash('error', 'Sale not found or already cancelled.');
      return res.redirect('/vehicles/sales');
    }
    await prisma.$transaction(async (tx) => {
      await tx.vanSale.update({ where: { id: sale.id }, data: { status: 'CANCELLED' } });
      for (const item of sale.items) {
        // Restore to vehicle stock
        await tx.vehicleStock.update({
          where: { vehicleId_productId: { vehicleId: sale.vehicleId, productId: item.productId } },
          data:  { quantity: { increment: item.quantity } }
        });
        // Restore to product.stock
        await tx.product.update({
          where: { id: item.productId },
          data:  { stock: { increment: item.quantity } }
        });
      }
    });
    req.flash('success', 'Van sale cancelled and vehicle stock restored.');
    res.redirect('/vehicles/sales');
  } catch (err) {
    req.flash('error', 'Failed to cancel van sale.');
    res.redirect('/vehicles/sales');
  }
};

// ─── Sell All Remaining Van Stock ──────────────────────────────────────────────

exports.sellRemaining = async (req, res) => {
  const vehicleId = parseInt(req.params.id);
  const { paymentMode, notes } = req.body;
  try {
    const prisma = await getPrisma();
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { stocks: { where: { quantity: { gt: 0 } }, include: { product: true } } }
    });
    if (!vehicle) return res.json({ success: false, message: 'Vehicle not found.' });
    if (!vehicle.stocks.length) return res.json({ success: false, message: 'No remaining stock on this vehicle.' });
 
    const count     = await prisma.vanSale.count();
    const invoiceNo = `VS-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
    let subtotal = 0, taxAmount = 0;
    const saleItems = vehicle.stocks.map(s => {
      const base = parseFloat(s.product.price) * s.quantity;
      const tax  = (base * parseFloat(s.product.tax || 0)) / 100;
      subtotal += base; taxAmount += tax;
      return { productId: s.productId, quantity: s.quantity, price: parseFloat(s.product.price), costPrice: parseFloat(s.product.avgCostPrice || 0), tax: parseFloat(s.product.tax || 0), total: base + tax };
    });
 
    await prisma.$transaction(async (tx) => {
      await tx.vanSale.create({
        data: {
          invoiceNo,
          vehicleId,
          customerId:  null,
          userId:      req.session.user.id,
          subtotal, taxAmount, discount: 0,
          total:       subtotal + taxAmount,
          paymentMode: paymentMode || 'CASH',
          status:      'PAID',
          notes:       notes || 'Bulk remaining stock sale',
          items:       { create: saleItems }
        }
      });
      for (const item of saleItems) {
        await tx.vehicleStock.update({ where: { vehicleId_productId: { vehicleId, productId: item.productId } }, data: { quantity: 0 } });
        await tx.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.quantity } } });
      }
    });
 
    res.json({
      success: true,
      message: `${saleItems.length} products sold. Total: ₹${(subtotal + taxAmount).toLocaleString('en-IN')}`,
      invoiceNo
    });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.message || 'Failed to sell remaining stock.' });
  }
};
 

// ─── API endpoints ─────────────────────────────────────────────────────────────
exports.apiVehicleStock = async (req, res) => {
  const vehicleId = parseInt(req.params.id);
  const search    = req.query.search || '';
  try {
    const prisma = await getPrisma();
    const stocks = await prisma.vehicleStock.findMany({
      where: {
        vehicleId,
        quantity: { gt: 0 },
        ...(search && { product: { OR: [{ name: { contains: search } }, { sku: { contains: search } }] } })
      },
      include: {
        product: { select: { id: true, name: true, sku: true, price: true, tax: true, unit: true, avgCostPrice: true } }
      }
    });
    res.json(stocks.map(s => ({ ...s.product, vehicleStock: s.quantity })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch vehicle stock' });
  }
};
