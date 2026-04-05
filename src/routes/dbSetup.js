'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dbSetupController');

router.get('/', ctrl.showSetup);
router.post('/setup-local', ctrl.setupLocal);
router.post('/setup-cloud', ctrl.setupCloud);
router.post('/test-connection', ctrl.testConnection);
router.post('/reset', ctrl.resetConfig);

module.exports = router;
