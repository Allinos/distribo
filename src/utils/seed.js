require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create activation
  await prisma.activation.upsert({
    where: { applicationId: 'ERP-2024-DEMO' },
    update: {},
    create: {
      applicationId: 'ERP-2024-DEMO',
      licenseKey: 'DEMO-LICENSE-KEY',
      isActive: true,
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
    }
  });

  // Create admin user
  const hashedPassword = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@erp.com' },
    update: {},
    create: {
      name: 'Admin User',
      email: 'admin@erp.com',
      password: hashedPassword,
      role: 'ADMIN',
    }
  });
  console.log('✅ Admin user created: admin@erp.com / admin123');

  // Create categories
  const categories = ['Electronics', 'Clothing', 'Food & Beverage', 'Office Supplies', 'Furniture'];
  for (const name of categories) {
    await prisma.category.upsert({
      where: { name },
      update: {},
      create: { name }
    });
  }

  // Create expense categories
  const expenseCategories = ['Rent', 'Utilities', 'Salaries', 'Marketing', 'Travel', 'Maintenance'];
  for (const name of expenseCategories) {
    await prisma.category.upsert({
      where: { name },
      update: {},
      create: { name }
    });
  }

  const allCategories = await prisma.category.findMany();
  const catMap = Object.fromEntries(allCategories.map(c => [c.name, c.id]));

  // Create sample products
  const products = [
    { name: 'Laptop Pro 15"', sku: 'LAP-001', categoryId: catMap['Electronics'], price: 75000, costPrice: 60000, tax: 18, stock: 25 },
    { name: 'Wireless Mouse', sku: 'MOU-001', categoryId: catMap['Electronics'], price: 1200, costPrice: 800, tax: 18, stock: 50 },
    { name: 'USB-C Hub', sku: 'HUB-001', categoryId: catMap['Electronics'], price: 3500, costPrice: 2500, tax: 18, stock: 30 },
    { name: 'Office Chair', sku: 'CHR-001', categoryId: catMap['Furniture'], price: 12000, costPrice: 8000, tax: 12, stock: 10 },
    { name: 'Standing Desk', sku: 'DSK-001', categoryId: catMap['Furniture'], price: 25000, costPrice: 18000, tax: 12, stock: 3 },
    { name: 'A4 Paper Ream', sku: 'PAP-001', categoryId: catMap['Office Supplies'], price: 350, costPrice: 250, tax: 5, stock: 200 },
    { name: 'Printer Ink Black', sku: 'INK-001', categoryId: catMap['Office Supplies'], price: 850, costPrice: 600, tax: 18, stock: 40 },
    { name: 'Coffee Beans 1kg', sku: 'COF-001', categoryId: catMap['Food & Beverage'], price: 1200, costPrice: 900, tax: 5, stock: 20 },
  ];

  for (const product of products) {
    await prisma.product.upsert({
      where: { sku: product.sku },
      update: {},
      create: product
    });
  }

  // Create customers
  const customers = [
    { name: 'Rajesh Kumar', email: 'rajesh@example.com', phone: '9876543210', address: '123 MG Road, Mumbai' },
    { name: 'Priya Sharma', email: 'priya@example.com', phone: '9123456789', address: '45 Park Street, Kolkata' },
    { name: 'Tech Solutions Ltd', email: 'info@techsol.com', phone: '9000012345', address: '78 IT Park, Bangalore', gstin: '29ABCDE1234F1Z5' },
    { name: 'Green Grocers', email: 'green@grocers.com', phone: '8765432109', address: '12 Market Road, Delhi' },
  ];

  for (const customer of customers) {
    await prisma.customer.upsert({
      where: { email: customer.email },
      update: {},
      create: customer
    });
  }

  // Create sample sales
  const allProducts = await prisma.product.findMany();
  const allCustomers = await prisma.customer.findMany();

  for (let i = 1; i <= 10; i++) {
    const customer = allCustomers[Math.floor(Math.random() * allCustomers.length)];
    const product = allProducts[Math.floor(Math.random() * allProducts.length)];
    const qty = Math.floor(Math.random() * 5) + 1;
    const subtotal = parseFloat(product.price) * qty;
    const taxAmount = (subtotal * parseFloat(product.tax)) / 100;
    const total = subtotal + taxAmount;
    const date = new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000);

    const invoiceNo = `INV-2024-${String(i).padStart(4, '0')}`;
    const existing = await prisma.sale.findUnique({ where: { invoiceNo } });
    if (!existing) {
      await prisma.sale.create({
        data: {
          invoiceNo,
          customerId: customer.id,
          userId: admin.id,
          subtotal,
          taxAmount,
          total,
          paymentMode: ['CASH', 'CARD', 'UPI'][Math.floor(Math.random() * 3)],
          saleDate: date,
          items: {
            create: [{
              productId: product.id,
              quantity: qty,
              price: product.price,
              tax: product.tax,
              total,
            }]
          }
        }
      });
    }
  }

  // Create sample expenses
  const expCats = ['Rent', 'Utilities', 'Salaries', 'Marketing', 'Travel'];
  for (let i = 0; i < 15; i++) {
    const catName = expCats[Math.floor(Math.random() * expCats.length)];
    const catId = catMap[catName];
    const date = new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000);
    await prisma.expense.create({
      data: {
        title: `${catName} expense ${i + 1}`,
        categoryId: catId,
        userId: admin.id,
        amount: Math.floor(Math.random() * 50000) + 1000,
        date,
        description: `Monthly ${catName.toLowerCase()} expense`,
      }
    });
  }

  // Settings
  await prisma.setting.upsert({
    where: { key: 'company_name' },
    update: {},
    create: { key: 'company_name', value: 'My ERP Company' }
  });
  await prisma.setting.upsert({
    where: { key: 'currency' },
    update: {},
    create: { key: 'currency', value: '₹' }
  });
  await prisma.setting.upsert({
    where: { key: 'invoice_prefix' },
    update: {},
    create: { key: 'invoice_prefix', value: 'INV' }
  });

  console.log('✅ Seeding complete!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
