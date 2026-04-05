'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/saleController');

router.get('/',          ctrl.index);
router.get('/new',       ctrl.showCreate);
router.post('/',         ctrl.create);
router.get('/:id',       ctrl.show);
router.get('/:id/edit',  ctrl.showEdit);
router.put('/:id',       ctrl.update);
router.delete('/:id',    ctrl.deleteSale);
router.post('/:id/cancel', ctrl.cancel);

module.exports = router;
