'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/settingController');

router.get('/',           ctrl.index);
router.post('/',          ctrl.update);
router.put('/',           ctrl.update);
router.post('/backup-now', ctrl.runBackupNow);

module.exports = router;
