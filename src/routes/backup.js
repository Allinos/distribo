// backup.js
const express = require('express');
const r1 = express.Router();
const b = require('../controllers/backupController');
r1.get('/', b.index);
r1.post('/create', b.create);
r1.get('/download/:filename', b.download);
r1.delete('/:filename', b.delete);
r1.post('/restore', b.restore);
module.exports = r1;
