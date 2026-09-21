'use strict';

// 业务服务层：档期占位、冲突拒绝（409 不落库）、重复/并发幂等、
// 演出前缺损冻结、同剧同角替件接替、修复闭环与旧档期留档。

const { createHash } = require('crypto');
const db = require('./db');
const repo = require('./repository');
const rules = require('./domain/rules');

const { httpError, normalizeDate, datesOverlap, uniqueList, resolveItemType, ITEM_TYPES } = rules;

const BOX_COLLECTION = 'tourBoxes';
const LOSS_COLLECTION = 'lossReports';
const REPAIR_COLLECTION = 'repairRecords';

// 写动作全局互斥：Node 单线程 + sql.js 同步执行，串行化后
// “检查 -> 插入”天然原子，并发的同键请求在队首结果落库后直接沿用
let writeChain = Promise.resolve();
const inFlight = new Map();

function serialize(key, work) {
  if (!key) {
    return writeChain.then(() => db.transaction(work));
  }
  if (inFlight.has(key)) return inFlight.get(key);
  const result = writeChain.then(() => {
    // 队首请求可能已把结果写入 idempotency 表，此时沿用首次结果
    const stored = repo.getIdempotency(key);
    if (stored) {
      repo.bumpIdempotency(stored.key);
      db.persist();
      return { statusCode: stored.statusCode, body: stored.body, reused: true };
    }
    return db.transaction(work);
  });
  inFlight.set(key, result);
  // 用双回调清理（而非裸 finally），避免衍生 Promise 产生 unhandledRejection
  const cleanup = () => inFlight.delete(key);
  result.then(cleanup, cleanup);
  return result;
}

// 幂等包装：优先使用显式 Idempotency-Key；无键时由 fallbackKey 兜底（指纹去重）
function withIdempotency(scope, explicitKey, fallbackKey, work) {
  const key = explicitKey || fallbackKey || null;
  return serialize(key, () => {
    if (key) {
      const stored = repo.getIdempotency(key);
      if (stored) {
        repo.bumpIdempotency(key);
        return { statusCode: stored.statusCode, body: stored.body, reused: true };
      }
    }
    const outcome = work();
    if (key) repo.saveIdempotency(key, scope, outcome.statusCode, outcome.body);
    return outcome;
  });
}

// ---------- 通用辅助 ----------

function requireRecord(collection, id, label) {
  const record = repo.loadRecord(collection, id);
  if (!record) throw httpError(404, 'notFound', (label || collection) + '不存在: ' + id);
  return record;
}

function boxConfig() {
  return repo.findCollection(BOX_COLLECTION);
}

function isBoxClosed(box) {
  return box.status === boxConfig().closedStatus;
}

function isBoxFrozen(box) {
  return box.status === boxConfig().frozenStatus;
}

function itemNameOf(type, record) {
  return type === 'puppetHead'
    ? [record.role, record.play].filter(Boolean).join('/')
    : record.name || '';
}

function loadItem(type, id) {
  const record = repo.loadRecord(ITEM_TYPES[type].collection, id);
  if (!record) {
    throw httpError(404, 'itemNotFound', ITEM_TYPES[type].label + '不存在: ' + id, { itemType: type, itemId: id });
  }
  return record;
}

// 替件“可用”判定：偶头不能处于修补相关状态，配件不能缺损/遗失。
// “已装箱”不在禁用之列——只要档期检查通过，一件在他箱的件可进另一张不重叠装箱单。
const HEAD_BLOCKED_STATUSES = ['待修补', '修补中', '不可演出'];
const ACCESSORY_BLOCKED_STATUSES = ['缺损', '遗失'];

function assertItemUsable(type, record, { strict = false } = {}) {
  if (type === 'puppetHead') {
    if (record.currentUsable === false || HEAD_BLOCKED_STATUSES.includes(record.status)) {
      throw httpError(409, 'itemNotUsable', '偶头当前不可用（需先完成修补闭环）: ' + record.id, {
        itemType: type,
        itemId: record.id,
        status: record.status
      });
    }
    // 替补用件必须是真正的备用件：已在巡演装箱中的不算“可用替件”
    if (strict && record.status !== '可演出') {
      throw httpError(409, 'itemNotUsable', '替件偶头当前不在可演出状态: ' + record.id, {
        itemType: type,
        itemId: record.id,
        status: record.status
      });
    }
  } else {
    if (ACCESSORY_BLOCKED_STATUSES.includes(record.status)) {
      throw httpError(409, 'itemNotUsable', '配件当前缺损/遗失，不能接替: ' + record.id, {
        itemType: type,
        itemId: record.id,
        status: record.status
      });
    }
    if (strict && record.status !== '在库') {
      throw httpError(409, 'itemNotUsable', '替件配件当前不在库: ' + record.id, {
        itemType: type,
        itemId: record.id,
        status: record.status
      });
    }
  }
}

// 档期检查：同一偶头/配件在重叠档期内只能进入一张未结束装箱单
function assertNoOverlap(type, itemId, startDate, endDate, options = {}) {
  const conflicts = repo.activeAllocationsForItem(type, itemId)
    .filter((alloc) => alloc.tourBoxId !== options.ignoreBoxId)
    .filter((alloc) => datesOverlap(startDate, endDate, alloc.startDate, alloc.endDate));
  if (conflicts.length) {
    throw httpError(409, 'scheduleConflict', '档期冲突：该' + ITEM_TYPES[type].label + '在重叠档期内已进入未结束装箱单', {
      itemType: type,
      itemId,
      requested: { startDate, endDate },
      conflicts: conflicts.map((alloc) => ({
        tourBoxId: alloc.tourBoxId,
        tourBoxTitle: alloc.tourBoxTitle,
        startDate: alloc.startDate,
        endDate: alloc.endDate,
        status: alloc.status
      }))
    });
  }
}

function markItemBoxed(type, record) {
  const data = { ...record, status: '已装箱' };
  delete data.id; delete data.collection; delete data.createdAt; delete data.updatedAt;
  repo.updateRecord(ITEM_TYPES[type].collection, record.id, '已装箱', data);
}

function markItemBackInStock(type, record) {
  const collection = ITEM_TYPES[type].collection;
  if (type === 'puppetHead') {
    const data = { ...record, status: '可演出', currentUsable: true };
    delete data.id; delete data.collection; delete data.createdAt; delete data.updatedAt;
    repo.updateRecord(collection, record.id, '可演出', data);
  } else {
    const data = { ...record, status: '在库' };
    delete data.id; delete data.collection; delete data.createdAt; delete data.updatedAt;
    repo.updateRecord(collection, record.id, '在库', data);
  }
}

function fingerprint(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

// ---------- 1. 创建装箱单：档期占位 ----------

function createTourBox(body, idempotencyKey) {
  const cfg = boxConfig();
  const status = body.status && cfg.statuses.includes(body.status)
    ? body.status
    : cfg.defaultStatus;
  if (status === cfg.closedStatus || status === cfg.frozenStatus) {
    throw httpError(400, 'invalidStatus', '新建装箱单不能以 ' + status + ' 作为初始状态');
  }

  const startDate = normalizeDate(body.startDate, 'startDate');
  const endDate = normalizeDate(body.endDate, 'endDate');
  if (startDate > endDate) {
    throw httpError(400, 'invalidDateRange', '起档日期不能晚于止档日期', { startDate, endDate });
  }

  const play = String(body.play || '').trim();
  const showName = String(body.showName || '').trim();
  const venue = String(body.venue || '').trim();
  if (!showName || !venue || !play) {
    throw httpError(400, 'validationFailed', 'showName / venue / play 为必填项');
  }

  const headIds = uniqueList(Array.isArray(body.headIds) ? body.headIds.map(String) : []);
  const accessoryIds = uniqueList(Array.isArray(body.accessoryIds) ? body.accessoryIds.map(String) : []);
  if (!headIds.length && !accessoryIds.length) {
    throw httpError(400, 'validationFailed', 'headIds 与 accessoryIds 至少各选其一或合计非空');
  }

  // 重复占位指纹：同剧目/同场地/同起止/同样的件 -> 视为同一张装箱单的重复提交
  const fp = fingerprint([
    'tourBox', showName, venue, play, startDate, endDate,
    headIds.slice().sort().join(','), accessoryIds.slice().sort().join(',')
  ]);

  return withIdempotency('tourBox.create', idempotencyKey, fp, () => {
    // 以下全部在同一事务中：任何一项冲突都会回滚，冲突不落库
    const resolvedHeads = headIds.map((id) => {
      const head = loadItem('puppetHead', id);
      if (head.play !== play) {
        throw httpError(400, 'playMismatch', '偶头剧目与装箱单剧目不一致: ' + id, { itemId: id, itemPlay: head.play, play });
      }
      assertItemUsable('puppetHead', head);
      assertNoOverlap('puppetHead', id, startDate, endDate);
      return head;
    });

    const resolvedAccessories = accessoryIds.map((id) => {
      const accessory = loadItem('accessory', id);
      if (accessory.play !== play) {
        throw httpError(400, 'playMismatch', '配件剧目与装箱单剧目不一致: ' + id, { itemId: id, itemPlay: accessory.play, play });
      }
      assertItemUsable('accessory', accessory);
      assertNoOverlap('accessory', id, startDate, endDate);
      return accessory;
    });

    const recordData = {
      ...body,
      play, showName, venue, startDate, endDate,
      headIds, accessoryIds, status
    };
    delete recordData.idempotencyKey;
    delete recordData.action;
    delete recordData.note;

    const box = repo.insertRecord(BOX_COLLECTION, require('crypto').randomUUID(), status, recordData);
    const boxTitle = repo.titleFor(cfg, recordData);

    for (const head of resolvedHeads) {
      repo.insertAllocation({
        itemType: 'puppetHead', itemId: head.id, itemName: itemNameOf('puppetHead', head),
        boxId: box.id, boxTitle, play, role: head.role || '', startDate, endDate
      });
      markItemBoxed('puppetHead', head);
    }
    for (const accessory of resolvedAccessories) {
      repo.insertAllocation({
        itemType: 'accessory', itemId: accessory.id, itemName: itemNameOf('accessory', accessory),
        boxId: box.id, boxTitle, play, role: accessory.role || '', startDate, endDate
      });
      markItemBoxed('accessory', accessory);
    }

    repo.addEvent({
      recordId: box.id, collection: BOX_COLLECTION, action: '档期占位', status,
      actor: body.actor || '', note: body.note || '',
      data: { startDate, endDate, headIds, accessoryIds }
    });

    return { statusCode: 201, body: repo.loadRecord(BOX_COLLECTION, box.id), reused: false };
  });
}

// ---------- 2. 演出前缺损：装箱单冻结 ----------

function openLossReport(body, idempotencyKey) {
  const tourBoxId = String(body.tourBoxId || '');
  const type = resolveItemType(body.itemType);
  const itemId = String(body.itemId || '');
  const problem = String(body.problem || '').trim();
  const stage = String(body.stage || '演出前').trim();

  if (!tourBoxId || !itemId || !problem) {
    throw httpError(400, 'validationFailed', 'tourBoxId / itemType / itemId / problem 为必填项');
  }
  if (!type) throw httpError(400, 'invalidItemType', 'itemType 只能是 puppetHead(偶头) 或 accessory(配件)');

  const box = requireRecord(BOX_COLLECTION, tourBoxId, '装箱单');
  if (isBoxClosed(box)) throw httpError(409, 'boxClosed', '装箱单已闭环，不能登记缺损');

  const item = loadItem(type, itemId);
  const itemName = body.itemName ? String(body.itemName) : itemNameOf(type, item);
  const belongs = type === 'puppetHead'
    ? (box.headIds || []).includes(itemId)
    : (box.accessoryIds || []).includes(itemId);
  if (!belongs) {
    throw httpError(400, 'itemNotInBox', '该件不在此装箱单内', { tourBoxId, itemType: type, itemId });
  }

  const beforeShow = stage !== '返场后';
  const fp = fingerprint(['loss', tourBoxId, type, itemId, beforeShow ? 'pre' : 'post', problem]);

  return withIdempotency('loss.create', idempotencyKey, fp, () => {
    const data = {
      tourBoxId,
      stage: beforeShow ? '演出前' : '返场后',
      itemType: type,
      itemId,
      itemName,
      problem,
      status: '待处理',
      note: body.note || ''
    };

    const report = repo.insertRecord(LOSS_COLLECTION, require('crypto').randomUUID(), '待处理', data);

    repo.addEvent({
      recordId: report.id, collection: LOSS_COLLECTION, action: '登记缺损', status: '待处理',
      actor: body.actor || '', note: body.note || '', data
    });

    let updatedBox = box;
    if (beforeShow) {
      // 冻结装箱单（已冻结则保持冻结），原件占用立即归档（不计当前占用），等待同剧同角替件
      const frozenStatus = boxConfig().frozenStatus;
      const pendingSubstitutions = Array.isArray(box.pendingSubstitutions) ? box.pendingSubstitutions : [];
      const alreadyPending = pendingSubstitutions.some(
        (pending) => pending.itemType === type && pending.itemId === itemId
      );

      const activeAlloc = repo.activeAllocationsForBox(tourBoxId)
        .find((alloc) => alloc.itemType === type && alloc.itemId === itemId);

      if (!alreadyPending) pendingSubstitutions.push({
        itemType: type,
        itemId,
        itemName,
        role: type === 'puppetHead' ? item.role : item.role,
        problem,
        lossReportId: report.id,
        createdAt: repo.now()
      });

      const boxData = {
        ...box,
        status: frozenStatus,
        previousStatus: box.status === frozenStatus ? (box.previousStatus || box.status) : box.status,
        frozenAt: box.frozenAt || repo.now(),
        pendingSubstitutions
      };
      delete boxData.id; delete boxData.collection; delete boxData.createdAt; delete boxData.updatedAt;
      updatedBox = repo.updateRecord(BOX_COLLECTION, tourBoxId, frozenStatus, boxData);

      if (activeAlloc) repo.archiveAllocation(activeAlloc.id, { reason: '演出前缺损-等待替件' });

      if (type === 'puppetHead') {
        const headData = { ...item, status: '待修补', currentUsable: false };
        delete headData.id; delete headData.collection; delete headData.createdAt; delete headData.updatedAt;
        repo.updateRecord('puppetHeads', itemId, '待修补', headData);
      } else {
        const accData = { ...item, status: '缺损' };
        delete accData.id; delete accData.collection; delete accData.createdAt; delete accData.updatedAt;
        repo.updateRecord('accessories', itemId, '缺损', accData);
      }

      repo.addEvent({
        recordId: tourBoxId, collection: BOX_COLLECTION, action: '演出前缺损-装箱单冻结',
        status: frozenStatus, actor: body.actor || '',
        note: itemName + '：' + problem,
        data: { lossReportId: report.id, itemType: type, itemId }
      });
      repo.addEvent({
        recordId: itemId, collection: ITEM_TYPES[type].collection,
        action: '演出前缺损-退出档期', status: type === 'puppetHead' ? '待修补' : '缺损',
        actor: body.actor || '', note: problem,
        data: { lossReportId: report.id, tourBoxId }
      });
    } else {
      repo.addEvent({
        recordId: tourBoxId, collection: BOX_COLLECTION, action: '返场缺损登记',
        status: box.status, actor: body.actor || '',
        note: itemName + '：' + problem,
        data: { lossReportId: report.id, itemType: type, itemId }
      });
    }

    return {
      statusCode: 201,
      body: {
        lossReport: repo.loadRecord(LOSS_COLLECTION, report.id),
        tourBox: repo.loadRecord(BOX_COLLECTION, tourBoxId)
      },
      reused: false
    };
  });
}

// ---------- 3. 同剧目同角色替件接替（替件也做档期检查） ----------

function substitute(boxId, body, idempotencyKey) {
  const box = requireRecord(BOX_COLLECTION, boxId, '装箱单');
  if (isBoxClosed(box)) throw httpError(409, 'boxClosed', '装箱单已闭环，不能替补');

  const type = resolveItemType(body.itemType);
  const originalId = String(body.itemId || body.originalItemId || '');
  const replacementId = String(body.replacementItemId || '');
  if (!type) throw httpError(400, 'invalidItemType', 'itemType 只能是 puppetHead(偶头) 或 accessory(配件)');
  if (!originalId || !replacementId) {
    throw httpError(400, 'validationFailed', 'itemId（缺损原件）与 replacementItemId（替件）为必填项');
  }

  // 重复替补（已成功执行过同一替换）沿用首次结果
  const priorSubstitution = (box.substitutions || []).find(
    (entry) => entry.itemType === type &&
      entry.originalItemId === originalId &&
      entry.replacementItemId === replacementId
  );
  if (priorSubstitution) {
    return Promise.resolve({
      statusCode: 200,
      body: { tourBox: box, reused: true },
      reused: true
    });
  }

  if (!isBoxFrozen(box)) {
    throw httpError(409, 'boxNotFrozen', '装箱单未冻结，只有演出前缺损冻结后才能接替', { status: box.status });
  }

  const pending = (box.pendingSubstitutions || []).find(
    (entry) => entry.itemType === type && entry.itemId === originalId
  );
  if (!pending) {
    throw httpError(409, 'noPendingSubstitution', '该件没有待处理的缺损接替请求，装箱单不能由此件接替');
  }

  const original = loadItem(type, originalId);
  const replacement = loadItem(type, replacementId);
  if (originalId === replacementId) {
    throw httpError(400, 'sameItem', '替件不能是缺损原件本身');
  }

  // 只能由同剧目同角色的可用替件接替
  if (replacement.play !== box.play) {
    throw httpError(409, 'substituteMismatch', '替件剧目不一致，要求剧目: ' + box.play, {
      replacementPlay: replacement.play, expectedPlay: box.play
    });
  }
  if ((replacement.role || '') !== (original.role || '')) {
    throw httpError(409, 'substituteMismatch', '替件角色不一致，要求角色: ' + (original.role || ''), {
      replacementRole: replacement.role, expectedRole: original.role
    });
  }
  assertItemUsable(type, replacement, { strict: true });
  // 替件同样必须通过档期检查
  assertNoOverlap(type, replacementId, box.startDate, box.endDate, { ignoreBoxId: boxId });

  const fp = fingerprint(['substitute', boxId, type, originalId, replacementId, pending.lossReportId || '']);

  return withIdempotency('tourBox.substitute', idempotencyKey, fp, () => {
    const cfg = boxConfig();
    const boxTitle = repo.titleFor(cfg, box);

    const allocationId = repo.insertAllocation({
      itemType: type,
      itemId: replacementId,
      itemName: itemNameOf(type, replacement),
      boxId,
      boxTitle,
      play: box.play,
      role: replacement.role || '',
      startDate: box.startDate,
      endDate: box.endDate,
      allocationType: 'substitute'
    });

    // 更新装箱单：头/配件清单替换，待接替队列移除
    const headIds = [...(box.headIds || [])];
    const accessoryIds = [...(box.accessoryIds || [])];
    if (type === 'puppetHead') {
      const idx = headIds.indexOf(originalId);
      if (idx >= 0) headIds[idx] = replacementId; else headIds.push(replacementId);
    } else {
      const idx = accessoryIds.indexOf(originalId);
      if (idx >= 0) accessoryIds[idx] = replacementId; else accessoryIds.push(replacementId);
    }

    const pendingSubstitutions = (box.pendingSubstitutions || []).filter(
      (entry) => !(entry.itemType === type && entry.itemId === originalId)
    );
    const substitutions = Array.isArray(box.substitutions) ? box.substitutions : [];
    substitutions.push({
      itemType: type,
      originalItemId: originalId,
      replacementItemId: replacementId,
      lossReportId: pending.lossReportId,
      at: repo.now()
    });

    // 所有缺损都补齐后自动解冻，回到冻结前状态；仍有缺件则保持冻结
    const remainPending = pendingSubstitutions.length > 0;
    const nextStatus = remainPending ? cfg.frozenStatus : (box.previousStatus || cfg.defaultStatus);
    const boxData = {
      ...box,
      headIds,
      accessoryIds,
      pendingSubstitutions,
      substitutions,
      status: nextStatus,
      previousStatus: remainPending ? (box.previousStatus || box.status) : undefined,
      frozenAt: remainPending ? box.frozenAt : undefined
    };
    delete boxData.id; delete boxData.collection; delete boxData.createdAt; delete boxData.updatedAt;
    if (!remainPending) {
      delete boxData.previousStatus;
      delete boxData.frozenAt;
    }
    const updatedBox = repo.updateRecord(BOX_COLLECTION, boxId, nextStatus, boxData);
    markItemBoxed(type, replacement);

    // 缺损单闭环为“已补齐”（替件方式）
    if (pending.lossReportId) {
      const report = repo.loadRecord(LOSS_COLLECTION, pending.lossReportId);
      if (report && report.status !== '已补齐') {
        const reportData = { ...report, status: '已补齐', resolution: '替件接替', closedAt: repo.now() };
        delete reportData.id; delete reportData.collection; delete reportData.createdAt; delete reportData.updatedAt;
        repo.updateRecord(LOSS_COLLECTION, report.id, '已补齐', reportData);
        repo.addEvent({
          recordId: report.id, collection: LOSS_COLLECTION, action: '替件接替-已补齐',
          status: '已补齐', actor: body.actor || '',
          note: itemNameOf(type, replacement) + ' 接替 ' + itemNameOf(type, original),
          data: { originalItemId: originalId, replacementItemId: replacementId, allocationId }
        });
      }
    }

    repo.addEvent({
      recordId: boxId, collection: BOX_COLLECTION,
      action: remainPending ? '替件接替（仍有待补缺）' : '替件接替-装箱单解冻',
      status: nextStatus, actor: body.actor || '',
      note: itemNameOf(type, replacement) + ' 接替 ' + itemNameOf(type, original),
      data: { itemType: type, originalItemId: originalId, replacementItemId: replacementId, allocationId }
    });
    repo.addEvent({
      recordId: replacementId, collection: ITEM_TYPES[type].collection,
      action: '替件进入档期', status: '已装箱', actor: body.actor || '',
      note: boxTitle + '（接替 ' + itemNameOf(type, original) + '）',
      data: { tourBoxId: boxId, originalItemId: originalId, startDate: box.startDate, endDate: box.endDate }
    });

    return { statusCode: 200, body: { tourBox: updatedBox }, reused: false };
  });
}

// ---------- 4. 装箱单闭环：档期归档 ----------

function closeTourBox(boxId, body = {}, idempotencyKey) {
  const box = requireRecord(BOX_COLLECTION, boxId, '装箱单');
  const cfg = boxConfig();
  if (isBoxClosed(box)) {
    return Promise.resolve({ statusCode: 200, body: { tourBox: box, reused: true }, reused: true });
  }
  const fp = fingerprint(['boxClose', boxId]);
  return withIdempotency('tourBox.close', idempotencyKey, fp, () => {
    if (isBoxFrozen(box) && (box.pendingSubstitutions || []).length) {
      throw httpError(409, 'boxFrozen', '装箱单仍冻结且存在未接替的缺损，不能闭环', {
        pendingSubstitutions: box.pendingSubstitutions
      });
    }

    const actives = repo.activeAllocationsForBox(boxId);
    for (const alloc of actives) {
      repo.archiveAllocation(alloc.id, { reason: '装箱单闭环-档期留档' });
      const item = repo.loadRecord(ITEM_TYPES[alloc.itemType].collection, alloc.itemId);
      if (item) {
        // 该件在其它未结束装箱单仍有档期时保持已装箱，否则回库
        const stillBooked = repo
          .activeAllocationsForItem(alloc.itemType, alloc.itemId)
          .some((other) => other.tourBoxId !== boxId);
        if (!stillBooked) markItemBackInStock(alloc.itemType, item);
      }
    }

    const boxData = { ...box, status: cfg.closedStatus, closedAt: repo.now() };
    delete boxData.id; delete boxData.collection; delete boxData.createdAt; delete boxData.updatedAt;
    delete boxData.previousStatus;
    delete boxData.frozenAt;
    const updatedBox = repo.updateRecord(BOX_COLLECTION, boxId, cfg.closedStatus, boxData);

    repo.addEvent({
      recordId: boxId, collection: BOX_COLLECTION, action: '装箱单闭环',
      status: cfg.closedStatus, actor: body.actor || '', note: body.note || '',
      data: { archivedAllocations: actives.map((alloc) => alloc.id) }
    });

    return { statusCode: 200, body: { tourBox: updatedBox }, reused: false };
  });
}

// ---------- 5. 修补闭环：原件恢复后才能按新档期重新占用 ----------

function completeRepair(repairId, body = {}, idempotencyKey) {
  const repair = requireRecord(REPAIR_COLLECTION, repairId, '修补记录');
  const fp = fingerprint(['repairComplete', repairId]);
  return withIdempotency('repair.complete', idempotencyKey, fp, () => {
    if (repair.status === '已完成') {
      return { statusCode: 200, body: { repairRecord: repair }, reused: true };
    }
    const headId = repair.puppetHeadId;
    if (!headId) throw httpError(400, 'validationFailed', '修补记录缺少 puppetHeadId');
    const head = loadItem('puppetHead', headId);

    // 修复闭环：偶头恢复可演出（旧档期已在缺损时归档，不计当前占用）
    const headData = { ...head, status: '可演出', currentUsable: true };
    delete headData.id; delete headData.collection; delete headData.createdAt; delete headData.updatedAt;
    repo.updateRecord('puppetHeads', headId, '可演出', headData);

    const repairData = { ...repair, status: '已完成', completedAt: repo.now() };
    delete repairData.id; delete repairData.collection; delete repairData.createdAt; delete repairData.updatedAt;
    const updatedRepair = repo.updateRecord(REPAIR_COLLECTION, repairId, '已完成', repairData);

    // 该偶头关联的待处理缺损单一并闭环
    const closedLosses = [];
    for (const report of repo.listRecords(LOSS_COLLECTION)) {
      if (report.itemType === 'puppetHead' && report.itemId === headId &&
          report.status !== '已补齐' && report.status !== '确认为遗失') {
        const rd = { ...report, status: '已补齐', resolution: '原件修复闭环', closedAt: repo.now() };
        delete rd.id; delete rd.collection; delete rd.createdAt; delete rd.updatedAt;
        repo.updateRecord(LOSS_COLLECTION, report.id, '已补齐', rd);
        closedLosses.push(report.id);
        repo.addEvent({
          recordId: report.id, collection: LOSS_COLLECTION, action: '原件修复闭环-已补齐',
          status: '已补齐', actor: body.actor || '',
          note: '偶头 ' + headId + ' 修复完成', data: { repairRecordId: repairId }
        });
      }
    }

    repo.addEvent({
      recordId: repairId, collection: REPAIR_COLLECTION, action: '修补闭环',
      status: '已完成', actor: body.actor || '', note: body.note || '',
      data: { puppetHeadId: headId, closedLosses }
    });
    repo.addEvent({
      recordId: headId, collection: 'puppetHeads', action: '修复闭环-恢复可演出',
      status: '可演出', actor: body.actor || '',
      note: '可按新档期重新占用；旧档期留档但不计当前占用',
      data: { repairRecordId: repairId }
    });

    return { statusCode: 200, body: { repairRecord: updatedRepair }, reused: false };
  });
}

// ---------- 6. 占用列表与履历一致 ----------

function getItemOccupancy(rawType, itemId) {
  const type = resolveItemType(rawType);
  if (!type) throw httpError(400, 'invalidItemType', 'itemType 只能是 puppetHead(偶头) 或 accessory(配件)');
  const item = repo.loadRecord(ITEM_TYPES[type].collection, itemId);
  if (!item) throw httpError(404, 'itemNotFound', ITEM_TYPES[type].label + '不存在: ' + itemId);

  const allocations = repo.allocationsForItem(type, itemId);
  return {
    itemType: type,
    itemId,
    itemName: itemNameOf(type, item),
    status: item.status,
    // 当前占用 = allocations 中 active 记录；履历 = 全部 active + archived
    current: allocations.filter((alloc) => alloc.status === 'active'),
    history: allocations
  };
}

module.exports = {
  createTourBox,
  openLossReport,
  substitute,
  closeTourBox,
  completeRepair,
  getItemOccupancy
};
