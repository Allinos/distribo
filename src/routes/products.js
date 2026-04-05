const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/productController');

router.get('/', ctrl.index);
router.post('/', ctrl.create);
router.post('/:id', ctrl.update);
router.delete('/:id', ctrl.delete);
router.get('/api/list', ctrl.apiList);

module.exports = router;
