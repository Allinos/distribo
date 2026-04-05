'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/writeoffController');

router.get('/',     ctrl.index);
router.get('/new',  ctrl.showCreate);
router.post('/',    ctrl.create);

module.exports = router;
