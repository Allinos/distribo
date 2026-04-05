'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/batchController');

router.get('/',          ctrl.index);
router.get('/new',       ctrl.showCreate);
router.post('/',         ctrl.create);
router.get('/api/alerts', ctrl.apiAlerts);

module.exports = router;
