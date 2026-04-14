"use strict";
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/vehicleController");

// Vehicle CRUD
router.get("/", ctrl.index);
router.post("/", ctrl.create);
router.post("/:id", ctrl.update);
router.delete("/:id", ctrl.delete);

// Stock management
router.get("/:id/stock", ctrl.showStock);
router.post("/:id/stock/assign", ctrl.assignStock);
router.post("/:id/stock/return", ctrl.returnStock);

router.get("/sales", ctrl.vanSalesIndex);
// ── Sell remaining — MUST come before /sales routes to avoid conflict ──────────
router.post("/:id/sell-remaining", ctrl.sellRemaining);

// ── Van Sales ──────────────────────────────────────────────────────────────────
// IMPORTANT: static paths (/sales, /sales/new) MUST be registered before
// dynamic paths (/sales/:id) otherwise Express matches /:id first
router.get("/sales/new", ctrl.showCreateVanSale);
router.post("/sales/new", ctrl.createVanSale);
router.get("/sales/:id", ctrl.showVanSale);
router.get("/sales/:id/edit", ctrl.showEditVanSale);
router.put("/sales/:id", ctrl.updateVanSale);
router.post("/sales/:id/cancel", ctrl.cancelVanSale);

// ── API ────────────────────────────────────────────────────────────────────────
router.get("/api/:id/stock", ctrl.apiVehicleStock);

module.exports = router;

