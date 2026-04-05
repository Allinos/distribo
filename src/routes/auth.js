// routes/auth.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/authController');
const { isAuthenticated } = require('../middleware/auth');

router.get('/login', ctrl.showLogin);
router.post('/login', ctrl.login);
router.get('/logout', ctrl.logout);
router.get('/profile', isAuthenticated, ctrl.showProfile);
router.post('/profile', isAuthenticated, ctrl.updateProfile);

module.exports = router;
