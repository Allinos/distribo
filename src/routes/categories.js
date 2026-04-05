// categories.js
const express = require('express');
const r = express.Router();
const c = require('../controllers/categoryController');
r.get('/', c.index); r.post('/', c.create);
r.put('/:id', c.update); r.delete('/:id', c.delete);
module.exports = r;
