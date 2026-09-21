'use strict';

const express = require('express');
const { HttpError } = require('../infra/errors');
const { idempotencyKeyOf } = require('./idempotency');

// ===== 入口层：只做 HTTP 编解码、幂等复用和事务边界，不写业务规则 =====

const DOMAIN_POST = {
  tourBoxes: '装箱单请用 POST /api/tourBoxes 专属入口（含档期占位校验）',
  lossReports: '缺损请用 POST /api/lossReports 专属入口（冻结+撤档）',
  repairRecords: '修补请用 POST /api/repairRecords 专属入口（修复闭环）'
};

function errorBody(error) {
  const body = { error: error.message || 'server error' };
  if (error.details !== undefined) body.details = error.details;
  return body;
}

function createRouter(ctx) {
  const { config, state, repo, services, lock, store } = ctx;
  const router = express.Router();

  function asyncJson(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  }

  // 所有写操作走同一事务：加锁 -> 幂等命中即复用 -> 执行用例 -> 成功才落盘
  // 用例抛错时不调用 save，业务数据保持原状（409 不落库）
  function mutate(req, res, fn) {
    return lock(() => {
      const key = idempotencyKeyOf(req);
      if (key) {
        const prior = repo.getIdempotent(key);
        if (prior) {
          res.set('Idempotent-Replayed', 'true');
          res.status(prior.status).json(prior.body);
          return;
        }
      }
      let result;
      try {
        result = fn();
      } catch (error) {
        // 记录层不保留任何业务变更；仅把幂等键对应的失败结果留档，保证重复请求沿用首次 409
        if (key && error instanceof HttpError) {
          repo.putIdempotent(key, { status: error.status, body: errorBody(error) });
          store.save(state);
        }
        throw error;
      }
      if (key) repo.putIdempotent(key, result);
      store.save(state);
      if (result.status === 204) res.status(204).end();
      else res.status(result.status).json(result.body);
    });
  }

  // ---------- 基础信息 ----------
  router.get('/health', (req, res) => {
    res.json({ ok: true, service: config.title });
  });

  router.get('/meta', (req, res) => {
    res.json({
      title: config.title,
      description: config.description,
      collections: config.collections,
      examples: config.examples || []
    });
  });

  // ---------- 列表 / 详情 / 履历 ----------
  router.get('/:collection', asyncJson((req, res) => {
    const collection = req.params.collection;
    if (!config.collections[collection]) throw new HttpError(404, 'unknown collection: ' + collection);
    let rows = repo.listRecords(collection)
      .map(services.toView)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    if (collection === 'tourBoxes') {
      // 列表与履历一致：装箱单的当前构成直接由 ACTIVE 台账派生
      const active = repo.listActiveLedger();
      rows = rows.map((box) => {
        const entries = active.filter((e) => e.tourBoxId === box.id);
        return {
          ...box,
          currentHeadIds: entries.filter((e) => e.itemType === 'puppetHead').map((e) => e.itemId),
          currentAccessoryIds: entries.filter((e) => e.itemType === 'accessory').map((e) => e.itemId),
          ended: box.status === '已闭环'
        };
      });
    }

    const { status, search, limit, ...filters } = req.query;
    rows = rows.filter((record) => {
      if (status && record.status !== status) return false;
      for (const [key, value] of Object.entries(filters)) {
        if (record[key] === undefined || !String(record[key]).toLowerCase().includes(String(value).toLowerCase())) {
          return false;
        }
      }
      if (search && !JSON.stringify(record).toLowerCase().includes(String(search).toLowerCase())) return false;
      return true;
    });
    const n = Number(limit || 0);
    res.json(n > 0 ? rows.slice(0, n) : rows);
  }));

  router.get('/:collection/:id', asyncJson((req, res) => {
    const { collection, id } = req.params;
    if (!config.collections[collection]) throw new HttpError(404, 'unknown collection: ' + collection);
    const record = repo.getRecord(collection, id);
    if (!record) throw new HttpError(404, 'not found');
    res.json(services.toView(record));
  }));

  router.get('/:collection/:id/timeline', asyncJson((req, res) => {
    const { collection, id } = req.params;
    if (!config.collections[collection]) throw new HttpError(404, 'unknown collection: ' + collection);
    const record = repo.getRecord(collection, id);
    if (!record) throw new HttpError(404, 'not found');
    const events = repo.listEvents(id)
      .map((e) => ({
        id: e.id, action: e.action, status: e.status, actor: e.actor,
        note: e.note, data: e.data, createdAt: e.createdAt
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    res.json({ record: services.toView(record), events });
  }));

  // ---------- 物品维度：当前占用 / 履历（列表与履历一致）----------
  router.get('/items/:itemType/:itemId/occupancy', asyncJson((req, res) => {
    const result = services.itemOccupancy(req.params.itemType, req.params.itemId);
    res.status(result.status).json(result.body);
  }));

  router.get('/items/:itemType/:itemId/timeline', asyncJson((req, res) => {
    const result = services.itemTimeline(req.params.itemType, req.params.itemId);
    res.status(result.status).json(result.body);
  }));

  // ---------- 领域专属写入口 ----------
  router.post('/tourBoxes', (req, res, next) => {
    mutate(req, res, () => services.bookTourBox(req.body || {})).catch(next);
  });

  router.post('/tourBoxes/:id/close', (req, res, next) => {
    mutate(req, res, () => services.closeTourBox(req.params.id, req.body || {})).catch(next);
  });

  router.post('/lossReports', (req, res, next) => {
    mutate(req, res, () => services.reportLoss(req.body || {})).catch(next);
  });

  router.post('/lossReports/:id/substitute', (req, res, next) => {
    mutate(req, res, () => services.substituteLoss(req.params.id, req.body || {})).catch(next);
  });

  router.post('/lossReports/:id/confirm-lost', (req, res, next) => {
    mutate(req, res, () => services.confirmLost(req.params.id, req.body || {})).catch(next);
  });

  router.post('/repairRecords', (req, res, next) => {
    mutate(req, res, () => services.createRepairRecord(req.body || {})).catch(next);
  });

  router.patch('/repairRecords/:id', (req, res, next) => {
    mutate(req, res, () => services.updateRepairRecord(req.params.id, req.body || {})).catch(next);
  });

  // ---------- 通用记录入口（仅档案类集合开放；领域集合引导到专属入口）----------
  router.post('/:collection', (req, res, next) => {
    const collection = req.params.collection;
    if (!config.collections[collection]) return next(new HttpError(404, 'unknown collection: ' + collection));
    if (DOMAIN_POST[collection]) return next(new HttpError(405, DOMAIN_POST[collection]));
    mutate(req, res, () => {
      const cfg = config.collections[collection];
      const data = { ...cfg.defaults, ...(req.body || {}) };
      const status = data.status && cfg.statuses.includes(data.status) ? data.status : (cfg.defaultStatus || '');
      data.status = status;
      services.validateRequired(cfg, data);
      const record = repo.insertRecord(collection, data, status);
      repo.addEvent({
        recordId: record.id, collection,
        action: req.body.action || '建档', status,
        actor: req.body.actor, note: req.body.note || '', data
      });
      return { status: 201, body: services.toView(record) };
    }).catch(next);
  });

  router.patch('/:collection/:id', (req, res, next) => {
    const { collection, id } = req.params;
    if (!config.collections[collection]) return next(new HttpError(404, 'unknown collection: ' + collection));
    if (DOMAIN_POST[collection]) {
      return next(new HttpError(405, `${collection} 为领域流转记录，请使用专属入口（缺损/替补/修复/结束档期），禁止直接改写`));
    }
    mutate(req, res, () => {
      const record = repo.getRecord(collection, id);
      if (!record) throw new HttpError(404, 'not found');
      const cfg = config.collections[collection];
      const patch = { ...(req.body.fields || req.body) };
      delete patch.id;
      delete patch.collection;
      delete patch.createdAt;
      delete patch.updatedAt;
      delete patch.action;
      delete patch.actor;
      delete patch.note;
      const status = patch.status && cfg.statuses.includes(patch.status) ? patch.status : record.status;
      delete patch.status;
      const updated = repo.updateRecord(collection, id, (r) => ({
        status,
        data: { ...r.data, ...patch }
      }));
      repo.addEvent({
        recordId: id, collection,
        action: req.body.action || '更新', status,
        actor: req.body.actor, note: req.body.note || '', data: patch
      });
      return { status: 200, body: services.toView(updated) };
    }).catch(next);
  });

  router.post('/:collection/:id/events', (req, res, next) => {
    const { collection, id } = req.params;
    if (!config.collections[collection]) return next(new HttpError(404, 'unknown collection: ' + collection));
    if (DOMAIN_POST[collection]) {
      return next(new HttpError(405, `${collection} 的状态流转必须经专属入口，不能只记事件`));
    }
    mutate(req, res, () => {
      const record = repo.getRecord(collection, id);
      if (!record) throw new HttpError(404, 'not found');
      const cfg = config.collections[collection];
      const status = req.body.status && cfg.statuses.includes(req.body.status) ? req.body.status : record.status;
      const updated = repo.updateRecord(collection, id, (r) => ({
        status, data: { ...r.data, ...(req.body.fields || {}), status }
      }));
      repo.addEvent({
        recordId: id, collection,
        action: req.body.action || status || '记录', status,
        actor: req.body.actor, note: req.body.note || '', data: req.body
      });
      return { status: 200, body: services.toView(updated) };
    }).catch(next);
  });

  router.delete('/:collection/:id', (req, res, next) => {
    const { collection, id } = req.params;
    if (!config.collections[collection]) return next(new HttpError(404, 'unknown collection: ' + collection));
    if (DOMAIN_POST[collection]) {
      return next(new HttpError(405, `${collection} 只允许经闭环流程流转，不能删除`));
    }
    mutate(req, res, () => {
      const record = repo.getRecord(collection, id);
      if (!record) throw new HttpError(404, 'not found');
      const itemType = collection === 'puppetHeads' ? 'puppetHead' : 'accessory';
      const busy = repo.listLedgerByItem(itemType, id).some((e) => e.status === 'ACTIVE');
      if (busy) throw new HttpError(409, `物品 ${id} 仍有进行中占用，不能删除（请先结束或撤档）`);
      state.records = state.records.filter((r) => !(r.collection === collection && r.id === id));
      state.events = state.events.filter((e) => e.recordId !== id);
      return { status: 204, body: null };
    }).catch(next);
  });

  return router;
}

module.exports = { createRouter };
