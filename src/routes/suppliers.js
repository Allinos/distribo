'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/supplierController');

router.get('/',              ctrl.index);
router.post('/',             ctrl.create);
router.put('/:id',           ctrl.update);
router.delete('/:id',        ctrl.delete);
router.get('/:id/ledger',    ctrl.ledger);
router.post('/:id/payment',  ctrl.recordPayment);

module.exports = router;
