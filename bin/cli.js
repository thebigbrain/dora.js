#!/usr/bin/env node

process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || 16;

// Node 8 supports native async functions - no need to use compiled code!
module.exports = require('../src/cli');
