'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/salesReportController');

router.get('/report', ctrl.index);

module.exports = router;
