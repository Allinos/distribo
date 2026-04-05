const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/activationController');

router.get('/', ctrl.showActivation);
router.post('/activate', ctrl.activate);
router.post('/deactivate', ctrl.deactivate);

module.exports = router;
