const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/settingController');
const { isAdmin } = require('../middleware/auth');

router.get('/', isAdmin, ctrl.index);
router.post('/', isAdmin, ctrl.update);

module.exports = router;
