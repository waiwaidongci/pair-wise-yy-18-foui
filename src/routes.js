'use strict';

// 入口层（HTTP）：参数解析、状态码与响应包装；业务规则全部下沉到 services。

const express = require('express');
const { randomUUID } = require('crypto');
const config = require('../project.config');
const db = require('./db');
const repo = require('./repository');
const services = require('./services');
const rules = require('./domain/rules');

const router = express.Router();

const META_FIELDS = ['id', 'collection', 'createdAt', 'updatedAt'];

function idempotencyKey(req) {
  return (
    req.get('Idempotency-Key') ||
    req.get('X-Idempotency-Key') ||
    (req.body && req.body.idempotencyKey) ||
    null
  );
}

function sendOutcome(res, outcome) {
  const body = outcome.reused
    ? { ...(outcome.body && typeof outcome.body === 'object' ? outcome.body : { result: outcome.body }), reused: true }
    : outcome.body;
  res.set('Idempotent-Replay', outcome.reused ? 'true' : 'false');
  res.status(outcome.statusCode).json(body);
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

function stripMeta(data) {
  const next = { ...data };
  for (const field of META_FIELDS) delete next[field];
  return next;
}

// ---------- 通用档案接口 ----------

router.get('/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

router.get('/:collection', (req, res, next) => {
  try {
    const collectionConfig = repo.findCollection(req.params.collection);
    if (!collectionConfig) return next(rules.httpError(404, 'unknownCollection', '未知集合: ' + req.params.collection));
    const rows = applyQuery(repo.listRecords(req.params.collection), req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? rows.slice(0, limit) : rows);
  } catch (error) {
    next(error);
  }
});

// 业务专用创建入口优先于通用 POST：
// tourBoxes / lossReports 走档期与冻结规则，其它集合走通用建档
router.post('/:collection', (req, res, next) => {
  const { collection } = req.params;
  if (collection === 'tourBoxes') {
    return services.createTourBox(req.body || {}, idempotencyKey(req))
      .then((outcome) => sendOutcome(res, outcome))
      .catch(next);
  }
  if (collection === 'lossReports') {
    return services.openLossReport(req.body || {}, idempotencyKey(req))
      .then((outcome) => sendOutcome(res, outcome))
      .catch(next);
  }
  try {
    const collectionConfig = repo.findCollection(collection);
    if (!collectionConfig) return next(rules.httpError(404, 'unknownCollection', '未知集合: ' + collection));
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return next(rules.httpError(400, 'invalidStatus', '非法状态: ' + status));
    }
    data.status = status;
    const missing = (collectionConfig.required || []).filter(
      (field) => data[field] === undefined || data[field] === ''
    );
    if (missing.length) return next(rules.httpError(400, 'validationFailed', '缺少必填字段: ' + missing.join(', ')));

    const id = randomUUID();
    const record = db.transaction(() => {
      const created = repo.insertRecord(collection, id, status, stripMeta(data));
      repo.addEvent({
        recordId: id, collection,
        action: req.body.action || '创建', status,
        actor: req.body.actor || '', note: req.body.note || '', data: stripMeta(data)
      });
      return created;
    });
    res.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

router.get('/:collection/:id', (req, res, next) => {
  try {
    const collectionConfig = repo.findCollection(req.params.collection);
    if (!collectionConfig) return next(rules.httpError(404, 'unknownCollection', '未知集合: ' + req.params.collection));
    const record = repo.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

// 装箱单的结构字段（档期/清单）不允许直接改写，只能通过专用入口流转
const BOX_PROTECTED_FIELDS = ['startDate', 'endDate', 'headIds', 'accessoryIds'];

router.patch('/:collection/:id', (req, res, next) => {
  try {
    const { collection, id } = req.params;
    const collectionConfig = repo.findCollection(collection);
    if (!collectionConfig) return next(rules.httpError(404, 'unknownCollection', '未知集合: ' + collection));
    const record = repo.loadRecord(collection, id);
    if (!record) return res.status(404).json({ error: 'not found' });

    if (collection === 'tourBoxes') {
      const touchedProtected = BOX_PROTECTED_FIELDS.some((field) => req.body[field] !== undefined);
      if (touchedProtected || (req.body.status && req.body.status !== record.status)) {
        return next(rules.httpError(
          409,
          'tourBoxImmutable',
          '装箱单档期与清单不可直接修改，请使用 substitute / close 等专用入口'
        ));
      }
    }

    const nextData = stripMeta({ ...record, ...req.body });
    const status = nextData.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return next(rules.httpError(400, 'invalidStatus', '非法状态: ' + status));
    }
    nextData.status = status;
    const updated = db.transaction(() => {
      repo.updateRecord(collection, id, status, nextData);
      repo.addEvent({
        recordId: id, collection,
        action: req.body.action || '更新', status,
        actor: req.body.actor || '', note: req.body.note || '', data: req.body
      });
      return repo.loadRecord(collection, id);
    });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// 通用事件/状态流转入口；修补记录走到“已完成”时触发修复闭环
router.post('/:collection/:id/events', (req, res, next) => {
  const { collection, id } = req.params;
  if (collection === 'repairRecords' && (req.body || {}).status === '已完成') {
    return services.completeRepair(id, req.body || {}, idempotencyKey(req))
      .then((outcome) => sendOutcome(res, outcome))
      .catch(next);
  }
  try {
    const collectionConfig = repo.findCollection(collection);
    if (!collectionConfig) return next(rules.httpError(404, 'unknownCollection', '未知集合: ' + collection));
    const record = repo.loadRecord(collection, id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return next(rules.httpError(400, 'invalidStatus', '非法状态: ' + status));
    }
    const nextData = stripMeta({ ...record, ...(req.body.fields || {}), status });
    repo.updateRecord(collection, id, status, nextData);
    repo.addEvent({
      recordId: id, collection,
      action: req.body.action || status || '记录', status,
      actor: req.body.actor || '', note: req.body.note || '', data: req.body
    });
    res.json(repo.loadRecord(collection, id));
  } catch (error) {
    next(error);
  }
});

// ---------- 业务专用入口 ----------

// 演出前缺损后，用同剧目同角色的可用替件接替（替件也做档期检查）
router.post('/tourBoxes/:id/substitute', (req, res, next) => {
  services.substitute(req.params.id, req.body || {}, idempotencyKey(req))
    .then((outcome) => sendOutcome(res, outcome))
    .catch(next);
});

// 装箱单闭环：当前占用整体归档，档期留档
router.post('/tourBoxes/:id/close', (req, res, next) => {
  services.closeTourBox(req.params.id, req.body || {}, idempotencyKey(req))
    .then((outcome) => sendOutcome(res, outcome))
    .catch(next);
});

// 修补闭环：原件恢复为可演出，可按新档期重新占用
router.post('/repairRecords/:id/complete', (req, res, next) => {
  services.completeRepair(req.params.id, req.body || {}, idempotencyKey(req))
    .then((outcome) => sendOutcome(res, outcome))
    .catch(next);
});

// 当前占用列表（active）与完整档期履历（active + archived）一致
router.get('/occupancy/items/:itemType/:itemId', (req, res, next) => {
  try {
    res.json(services.getItemOccupancy(req.params.itemType, req.params.itemId));
  } catch (error) {
    next(error);
  }
});

// 履历：本记录事件 +（若是偶头/配件）对应档期占用，保证列表与履历一致
router.get('/:collection/:id/timeline', (req, res, next) => {
  try {
    const { collection, id } = req.params;
    const collectionConfig = repo.findCollection(collection);
    if (!collectionConfig) return next(rules.httpError(404, 'unknownCollection', '未知集合: ' + collection));
    const record = repo.loadRecord(collection, id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = repo.listEventsByRecord(id);
    const itemType = collection === 'puppetHeads' ? 'puppetHead'
      : collection === 'accessories' ? 'accessory' : null;
    const allocations = itemType ? repo.allocationsForItem(itemType, id) : [];
    res.json({ record, events, allocations });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
