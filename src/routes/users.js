const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/userController');
const { isAdmin } = require('../middleware/auth');

router.get('/', isAdmin, ctrl.index);
router.post('/', isAdmin, ctrl.create);
router.put('/:id', isAdmin, ctrl.update);
router.post('/:id/reset-password', isAdmin, ctrl.resetPassword);

module.exports = router;
