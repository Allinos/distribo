'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/returnController');

router.get('/',              ctrl.index);
router.get('/new',           ctrl.showCreate);
router.get('/find-invoice',  ctrl.findInvoice);
router.post('/',             ctrl.create);

module.exports = router;
