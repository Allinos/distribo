'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/productController');

router.get('/',                    ctrl.index);
router.post('/',                   ctrl.create);
router.put('/:id',                 ctrl.update);
router.delete('/:id',              ctrl.delete);
router.get('/api/list',            ctrl.apiList);
router.get('/api/warehouse-list',  ctrl.apiListForWarehouse);

module.exports = router;
