'use strict';

const { randomUUID } = require('crypto');

function now() {
  return new Date().toISOString();
}

function newId() {
  return randomUUID();
}

// 日期统一按 YYYY-MM-DD 比较，档期为闭区间
function normalizeDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error(`invalid date for ${field}: ${value} (need YYYY-MM-DD)`);
    error.status = 400;
    throw error;
  }
  return value;
}

module.exports = { now, newId, normalizeDate };
