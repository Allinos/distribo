'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/warehouseController');

router.get('/',                      ctrl.index);
router.post('/',                     ctrl.create);
router.put('/:id',                   ctrl.update);
router.delete('/:id',                ctrl.delete);
router.get('/:id/stock',             ctrl.showStock);
router.post('/:id/stock/adjust',     ctrl.adjustStock);
router.get('/transfers/new',         ctrl.showTransfer);
router.post('/transfers',            ctrl.createTransfer);
router.get('/api/list',              ctrl.apiList);
router.get('/api/:id/stock',         ctrl.apiStock);

module.exports = router;
