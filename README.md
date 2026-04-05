# ERP Desktop System v2.0

Full-stack ERP — Node.js + Express + EJS + Prisma + Electron

## What's New in v2.0

| Feature | Details |
|---------|---------|
| **Electron** | Desktop app wrapper — starts Express internally, loads in BrowserWindow |
| **Dynamic DB** | AES-256 encrypted config, per-client database switching at runtime |
| **DB Setup Flow** | Local MySQL (auto-creates DB) or Cloud URL connection wizard |
| **Suppliers** | Full CRUD with GSTIN support |
| **Purchases** | PO builder, stock auto-increment on receipt, cancellation reversal |
| **Vehicles** | Fleet management, warehouse→vehicle stock loading, stock return |
| **Van Sales** | Sell directly from vehicle stock, vehicle-wise reports & charts |

## Quick Start

### Web mode
```bash
cp .env.example .env
npm install
# Start app — navigate to /db-setup to configure database
npm run dev
```

### Desktop (Electron) mode
```bash
npm install
npm run electron        # run once
npm run dev:electron    # nodemon + electron together
```

## First-Run Flow
```
Launch → /db-setup → (configure MySQL) → /activation → (license key) → /auth/login
```
Demo credentials after seeding:
- Email: `admin@erp.com`  |  Password: `admin123`
- License key: `DEMO-LICENSE-KEY`

## Architecture
```
erp-desktop/
├── electron/
│   ├── main.js          # Electron main — forks Express, BrowserWindow
│   └── preload.js       # Secure contextBridge (contextIsolation: true)
├── src/
│   ├── app.js           # Express entry point
│   ├── controllers/     # 15 controllers
│   ├── routes/          # 13 route files
│   ├── middleware/       # auth.js — isDbConfigured, isActivated, isAuthenticated
│   ├── services/        # backupService.js
│   └── utils/
│       ├── dbManager.js # AES-256 DB config + dynamic PrismaClient
│       └── prisma.js    # getPrisma(), initDb() async helpers
├── views/
│   ├── layout.ejs
│   ├── partials/        # sidebar, header, footer, pagination
│   └── pages/           # 20 EJS pages across 10 modules
├── public/
│   ├── css/app.css
│   └── js/app.js
└── prisma/schema.prisma # 15 models
```

## Modules

| Route | Module |
|-------|--------|
| `/` | Dashboard — KPIs, charts, low stock |
| `/products` | Products CRUD + stock tracking |
| `/sales` | Invoice builder + print |
| `/purchases` | PO builder, stock increase on receipt |
| `/expenses` | Expenses + file attachments |
| `/suppliers` | Supplier CRUD |
| `/customers` | Customer CRUD |
| `/vehicles` | Fleet CRUD + stock assignment |
| `/vehicles/sales` | Van sales with vehicle-stock deduction |
| `/categories` | Shared categories |
| `/users` | User management (Admin only) |
| `/settings` | Company settings |
| `/backup` | mysqldump backup + restore |
| `/activation` | License activation |
| `/db-setup` | Database configuration wizard |

## Electron Scripts
```bash
npm run electron          # Start Electron (requires server already running)
npm run dev:electron      # Start both server + Electron concurrently
npm run build:electron    # Build distributable with electron-builder
```

## Security
- `contextIsolation: true`, `nodeIntegration: false`
- DB config encrypted with AES-256-CBC
- bcrypt password hashing (cost 12)
- Helmet CSP headers
- Session-based auth
- Role-based access (ADMIN / MANAGER / STAFF)
