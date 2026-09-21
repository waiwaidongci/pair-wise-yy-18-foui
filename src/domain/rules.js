'use strict';

// 规则层：档期判定、日期校验、替件匹配等纯规则。
// 不触碰数据库，便于单测与被 service 层组合调用。

const ITEM_TYPES = {
  puppetHead: { collection: 'puppetHeads', label: '偶头' },
  accessory: { collection: 'accessories', label: '配件' }
};

const TYPE_ALIASES = {
  偶头: 'puppetHead',
  偶: 'puppetHead',
  head: 'puppetHead',
  puppetHead: 'puppetHead',
  puppetHeads: 'puppetHead',
  配件: 'accessory',
  accessory: 'accessory',
  accessories: 'accessory'
};

function resolveItemType(raw) {
  if (!raw) return null;
  const key = String(raw).trim();
  return TYPE_ALIASES[key] || TYPE_ALIASES[key.toLowerCase()] || null;
}

function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
}

// 接受 YYYY-MM-DD 或 ISO 时间，统一归一为 YYYY-MM-DD
function normalizeDate(input, field) {
  if (input === undefined || input === null || input === '') {
    throw httpError(400, 'invalidDate', '缺少日期字段: ' + field);
  }
  const str = String(input).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(str);
  if (!match) {
    throw httpError(400, 'invalidDate', '日期格式应为 YYYY-MM-DD: ' + field + '=' + str);
  }
  const normalized = match[1] + '-' + match[2] + '-' + match[3];
  const time = Date.parse(normalized + 'T00:00:00Z');
  if (Number.isNaN(time)) {
    throw httpError(400, 'invalidDate', '非法日期: ' + str);
  }
  return normalized;
}

// 半开档期重叠判定：aStart <= bEnd 且 bStart <= aEnd（同日起止算重叠）
function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function uniqueList(values) {
  return [...new Set(values)];
}

module.exports = {
  ITEM_TYPES,
  resolveItemType,
  httpError,
  normalizeDate,
  datesOverlap,
  uniqueList
};
