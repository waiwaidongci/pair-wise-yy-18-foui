'use strict';

const { HttpError } = require('../infra/errors');
const { normalizeDate } = require('../infra/util');
const { isItemUsable, findActiveConflict, assertSameRolePlay } = require('./rules');

// ===== 规则层之上的领域服务（用例）：编排记录层，承载业务闭环 =====

const ITEM_COLLECTIONS = { puppetHead: 'puppetHeads', accessory: 'accessories' };

function createServices(repo, config) {
  function requireRecord(collection, id, label) {
    const record = repo.getRecord(collection, id);
    if (!record) throw new HttpError(404, `${label || collection} 不存在：${id}`);
    return record;
  }

  function getItem(itemType, itemId) {
    const collection = ITEM_COLLECTIONS[itemType];
    if (!collection) throw new HttpError(400, `itemType 必须是 puppetHead 或 accessory：${itemType}`);
    return requireRecord(collection, itemId, itemType);
  }

  function validateRequired(collectionConfig, data) {
    const missing = (collectionConfig.required || []).filter(
      (field) => data[field] === undefined || data[field] === null || data[field] === ''
    );
    if (missing.length) throw new HttpError(400, '缺少必填字段：' + missing.join(', '));
  }

  function toView(record) {
    return {
      ...record.data,
      id: record.id,
      collection: record.collection,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }

  // 校验档期内一个物品能否占用：存在 ACTIVE 台账冲突即 409
  function assertNoScheduleConflict(itemType, itemId, startDate, endDate, excludeBoxId) {
    const conflict = findActiveConflict(repo, itemType, itemId, startDate, endDate, excludeBoxId);
    if (conflict) {
      throw new HttpError(409,
        `档期冲突：${itemType}/${itemId} 在 ${conflict.startDate}~${conflict.endDate} 已进入装箱单 ${conflict.tourBoxId}`,
        { conflict: { tourBoxId: conflict.tourBoxId, startDate: conflict.startDate, endDate: conflict.endDate } }
      );
    }
  }

  function setItemUsable(record, usable, patch) {
    const data = { ...record.data, ...(patch || {}) };
    if (record.collection === 'puppetHeads') {
      data.currentUsable = usable;
    }
    return data;
  }

  // ---------- 1. 装箱单登记（档期占位）----------
  function bookTourBox(body) {
    const cfg = config.collections.tourBoxes;
    const data = { ...cfg.defaults, ...body };
    delete data.action;
    delete data.actor;
    delete data.note;
    validateRequired(cfg, data);
    const startDate = normalizeDate(data.startDate, 'startDate');
    const endDate = normalizeDate(data.endDate, 'endDate');
    if (startDate > endDate) throw new HttpError(400, `起止日期倒置：${startDate} > ${endDate}`);

    const headIds = Array.isArray(data.headIds) ? [...new Set(data.headIds)] : [];
    const accessoryIds = Array.isArray(data.accessoryIds) ? [...new Set(data.accessoryIds)] : [];

    // 先把所有校验跑完：任何冲突都不写任何记录（409 不落库）
    const conflicts = [];
    for (const id of headIds) {
      const head = getItem('puppetHead', id);
      if (!isItemUsable('puppetHead', head)) {
        throw new HttpError(422, `偶头 ${id} 当前不可用（状态：${head.status}），须修复闭环后才能占用`);
      }
      const conflict = findActiveConflict(repo, 'puppetHead', id, startDate, endDate);
      if (conflict) conflicts.push({ itemType: 'puppetHead', itemId: id, conflict });
    }
    for (const id of accessoryIds) {
      const acc = getItem('accessory', id);
      if (!isItemUsable('accessory', acc)) {
        throw new HttpError(422, `配件 ${id} 当前不可用（状态：${acc.status}）`);
      }
      const conflict = findActiveConflict(repo, 'accessory', id, startDate, endDate);
      if (conflict) conflicts.push({ itemType: 'accessory', itemId: id, conflict });
    }
    if (conflicts.length > 0) {
      throw new HttpError(409, '档期冲突：存在重叠档期内的未结束装箱单', { conflicts });
    }

    // 校验通过后一次性落库：装箱单 + 每个物品一条 ACTIVE 台账
    const status = data.status && cfg.statuses.includes(data.status) ? data.status : cfg.defaultStatus;
    data.status = status;
    data.headIds = headIds;
    data.accessoryIds = accessoryIds;
    const occupyItems = status !== '草稿';
    const box = repo.insertRecord('tourBoxes', data, status);

    if (occupyItems) {
      for (const id of headIds) {
        repo.appendLedger({ itemType: 'puppetHead', itemId: id, tourBoxId: box.id, startDate, endDate, status: 'ACTIVE' });
      }
      for (const id of accessoryIds) {
        repo.appendLedger({ itemType: 'accessory', itemId: id, tourBoxId: box.id, startDate, endDate, status: 'ACTIVE' });
      }
    }
    repo.addEvent({
      recordId: box.id, collection: 'tourBoxes',
      action: occupyItems ? '档期占位' : '创建草稿', status,
      actor: body.actor, note: body.note || '',
      data: { startDate, endDate, headIds, accessoryIds, draft: !occupyItems }
    });
    return { status: 201, body: toView(box) };
  }

  // 未结束：除“已闭环”外都算（含冻结），冻结单仍然占着档期
  function assertBoxOpen(box) {
    if (box.status === '已闭环') throw new HttpError(409, `装箱单 ${box.id} 已闭环（未结束装箱单才参与档期）`);
    return box;
  }

  // ---------- 2. 演出前缺损：装箱单冻结，撤下原件 ----------
  function reportLoss(body) {
    const cfg = config.collections.lossReports;
    const data = { ...cfg.defaults, ...body };
    delete data.action;
    delete data.actor;
    delete data.note;
    validateRequired(cfg, data);
    if (!ITEM_COLLECTIONS[data.itemType]) throw new HttpError(400, `itemType 非法：${data.itemType}`);

    const box = assertBoxOpen(requireRecord('tourBoxes', data.tourBoxId, '装箱单'));
    if (box.status === '冻结') {
      throw new HttpError(409, `装箱单 ${box.id} 已冻结：请先完成当前缺损的替补，再登记新缺损`);
    }
    const item = getItem(data.itemType, data.itemId);
    const inBox =
      (data.itemType === 'puppetHead' ? box.data.headIds : box.data.accessoryIds) || [];
    if (!inBox.includes(item.id)) {
      throw new HttpError(422, `物品 ${item.id} 不在装箱单 ${box.id} 当前构成中`);
    }

    // 撤下原件占用（旧档期留档：原台账置 RELEASED，不删行，不计当前占用）
    const entry = repo
      .listLedgerByItem(data.itemType, item.id)
      .find((e) => e.status === 'ACTIVE' && e.tourBoxId === box.id);
    if (!entry) throw new HttpError(409, `物品 ${item.id} 在装箱单 ${box.id} 上没有进行中占用`);
    repo.releaseEntry(entry.id, '演出前缺损撤档');

    // 原件进入修复闭环，未完成前不可被任何档期占用
    const unusableStatus = data.itemType === 'puppetHead' ? '待修补' : '缺损';
    const updatedItem = repo.updateRecord(
      ITEM_COLLECTIONS[data.itemType], item.id,
      (r) => ({ status: unusableStatus, data: setItemUsable(r, false) })
    );
    repo.addEvent({
      recordId: item.id, collection: ITEM_COLLECTIONS[data.itemType],
      action: '缺损撤档', status: unusableStatus,
      actor: body.actor, note: data.problem,
      data: { tourBoxId: box.id, lossFrom: '演出前', releasedEntryId: entry.id }
    });

    // 装箱单冻结，记录缺损槽位
    const slot = { itemType: data.itemType, itemId: item.id, problem: data.problem, status: '待替补' };
    const frozenBox = repo.updateRecord('tourBoxes', box.id, (r) => ({
      status: '冻结',
      data: { ...r.data, frozenSlots: [...(r.data.frozenSlots || []), slot] }
    }));
    repo.addEvent({
      recordId: box.id, collection: 'tourBoxes',
      action: '演出前缺损·冻结', status: '冻结',
      actor: body.actor, note: data.problem, data: slot
    });

    data.status = cfg.defaultStatus;
    data.resolved = false;
    const report = repo.insertRecord('lossReports', data, cfg.defaultStatus);
    repo.addEvent({
      recordId: report.id, collection: 'lossReports',
      action: '登记缺损', status: cfg.defaultStatus,
      actor: body.actor, note: body.note || '', data
    });

    return {
      status: 201,
      body: { lossReport: toView(report), tourBox: toView(frozenBox), item: toView(updatedItem) }
    };
  }

  function pendingSlotOf(box, report) {
    const slots = box.data.frozenSlots || [];
    const idx = slots.findIndex(
      (s) => s.status === '待替补' && s.itemType === report.data.itemType && s.itemId === report.data.itemId
    );
    if (idx === -1) throw new HttpError(409, '该缺损没有待替补槽位（可能已替补）');
    return idx;
  }

  // ---------- 3. 替补：同剧目同角色可用替件接替，替件也做档期检查 ----------
  function substituteLoss(lossId, body) {
    const report = requireRecord('lossReports', lossId, '缺损记录');
    if (report.data.resolved) throw new HttpError(409, `缺损 ${lossId} 已由替件 ${report.data.substituteId} 接替`);
    const itemType = report.data.itemType;
    const box = requireRecord('tourBoxes', report.data.tourBoxId, '装箱单');
    if (box.status !== '冻结') {
      throw new HttpError(409, `装箱单 ${box.id} 当前状态为「${box.status}」，仅冻结单可替补`);
    }
    const slotIndex = pendingSlotOf(box, report);

    const replacementId = body.itemId || body.replacementId;
    if (!replacementId) throw new HttpError(400, '缺少替件 itemId');
    const original = getItem(itemType, report.data.itemId);
    const replacement = getItem(itemType, replacementId);
    if (replacement.id === original.id) {
      throw new HttpError(422, '替件不能是缺损原件本身');
    }
    if (!isItemUsable(itemType, replacement)) {
      throw new HttpError(422, `替件 ${replacementId} 当前不可用（状态：${replacement.status}）`);
    }
    const roleProblems = assertSameRolePlay(itemType, original, replacement);
    if (roleProblems.length) throw new HttpError(422, '替件资格不符：' + roleProblems.join('；'));

    // 替件同样要过档期检查（排除本单，因本单对应槽位已撤档）
    assertNoScheduleConflict(itemType, replacementId, box.data.startDate, box.data.endDate, box.id);

    // 接替：替件在原档期入账
    const entry = repo.appendLedger({
      itemType, itemId: replacementId, tourBoxId: box.id,
      startDate: box.data.startDate, endDate: box.data.endDate,
      status: 'ACTIVE', reason: `替补缺损 ${lossId}（原件 ${original.id}）`
    });

    // 装箱单构成：移除原件、加入替件
    const listKey = itemType === 'puppetHead' ? 'headIds' : 'accessoryIds';
    const nextIds = [...(box.data[listKey] || [])];
    const at = nextIds.indexOf(original.id);
    if (at >= 0) nextIds.splice(at, 1);
    if (!nextIds.includes(replacementId)) nextIds.push(replacementId);

    const frozenSlots = [...(box.data.frozenSlots || [])];
    frozenSlots[slotIndex] = {
      ...frozenSlots[slotIndex],
      status: '已替补',
      substituteId: replacementId,
      substitutedAt: new Date().toISOString()
    };
    const stillFrozen = frozenSlots.some((s) => s.status === '待替补');
    const nextStatus = stillFrozen ? '冻结' : (box.data.statusBeforeFreeze || '已装箱');

    const updatedBox = repo.updateRecord('tourBoxes', box.id, (r) => ({
      status: nextStatus,
      data: {
        ...r.data,
        [listKey]: nextIds,
        frozenSlots,
        statusBeforeFreeze: stillFrozen ? r.data.statusBeforeFreeze : undefined
      }
    }));
    repo.addEvent({
      recordId: box.id, collection: 'tourBoxes',
      action: stillFrozen ? '替补接替（仍冻结）' : '替补完成·解冻', status: nextStatus,
      actor: body.actor, note: body.note || '',
      data: { lossReportId: lossId, itemType, originalId: original.id, substituteId: replacementId, ledgerEntryId: entry.id }
    });
    repo.addEvent({
      recordId: replacementId, collection: ITEM_COLLECTIONS[itemType],
      action: '替补占用', status: replacement.status,
      actor: body.actor,
      note: `接替 ${original.id} 出演 ${box.data.showName || box.id}`,
      data: { tourBoxId: box.id, lossReportId: lossId, startDate: box.data.startDate, endDate: box.data.endDate }
    });

    const updatedReport = repo.updateRecord('lossReports', lossId, (r) => ({
      status: '修复中',
      data: { ...r.data, resolved: true, substituteId: replacementId, resolvedAt: new Date().toISOString() }
    }));
    repo.addEvent({
      recordId: lossId, collection: 'lossReports',
      action: '替件接替', status: '修复中',
      actor: body.actor, note: body.note || '',
      data: { originalId: original.id, substituteId: replacementId }
    });

    return {
      status: 200,
      body: { lossReport: toView(updatedReport), tourBox: toView(updatedBox), substitute: toView(replacement) }
    };
  }

  // ---------- 4. 原件修复闭环：完成后才可按新档期重新占用 ----------
  function createRepairRecord(body) {
    const cfg = config.collections.repairRecords;
    const data = { ...cfg.defaults, ...body };
    delete data.action;
    delete data.actor;
    delete data.note;
    validateRequired(cfg, data);
    if (!ITEM_COLLECTIONS[data.itemType]) throw new HttpError(400, `itemType 非法：${data.itemType}`);
    const item = getItem(data.itemType, data.itemId);

    const complete = data.complete === true;
    delete data.complete;
    const status = complete ? '已完成' : cfg.defaultStatus;
    data.status = status;
    data.itemName = item.data.name || [item.data.role, item.data.play].filter(Boolean).join('/');

    const repair = repo.insertRecord('repairRecords', data, status);
    repo.addEvent({
      recordId: repair.id, collection: 'repairRecords',
      action: complete ? '修复闭环完成' : '登记修补', status,
      actor: body.actor, note: body.note || '', data
    });

    let updatedItem = item;
    if (complete) {
      // 闭环：恢复可用。旧占用已在缺损时 RELEASED 留档，这里不恢复，后续按新档期重新占位
      const usableStatus = data.itemType === 'puppetHead' ? '可演出' : '在库';
      updatedItem = repo.updateRecord(ITEM_COLLECTIONS[data.itemType], item.id, (r) => ({
        status: usableStatus,
        data: setItemUsable(r, true, { repairNote: undefined })
      }));
      repo.addEvent({
        recordId: item.id, collection: ITEM_COLLECTIONS[data.itemType],
        action: '修复闭环·恢复可用', status: usableStatus,
        actor: body.actor, note: body.note || `修补单 ${repair.id} 完成`,
        data: { repairRecordId: repair.id }
      });
      // 关联的缺损单随之闭环（不影响替件的占用）
      for (const report of repo.listRecords('lossReports')) {
        if (
          report.data.itemType === data.itemType &&
          report.data.itemId === item.id &&
          report.data.resolved &&
          report.status !== '已完成' &&
          report.status !== '确认为遗失'
        ) {
          repo.updateRecord('lossReports', report.id, () => ({
            status: '已完成',
            data: { ...report.data, repairRecordId: repair.id, repairedAt: new Date().toISOString() }
          }));
          repo.addEvent({
            recordId: report.id, collection: 'lossReports',
            action: '原件修复闭环', status: '已完成',
            actor: body.actor, data: { repairRecordId: repair.id }
          });
        }
      }
    } else {
      const repairStatus = data.itemType === 'puppetHead' ? '修补中' : '缺损';
      updatedItem = repo.updateRecord(ITEM_COLLECTIONS[data.itemType], item.id, (r) => ({
        status: repairStatus,
        data: setItemUsable(r, false)
      }));
      repo.addEvent({
        recordId: item.id, collection: ITEM_COLLECTIONS[data.itemType],
        action: '进入修补', status: repairStatus,
        actor: body.actor, note: body.note || `修补单 ${repair.id}`,
        data: { repairRecordId: repair.id }
      });
    }

    return { status: 201, body: { repairRecord: toView(repair), item: toView(updatedItem) } };
  }

  // 修补单状态流转；标记已完成等价于修复闭环
  function updateRepairRecord(repairId, body) {
    const repair = requireRecord('repairRecords', repairId, '修补记录');
    if (body.status && !config.collections.repairRecords.statuses.includes(body.status)) {
      throw new HttpError(400, `非法状态：${body.status}`);
    }
    const completing = body.status === '已完成' && repair.status !== '已完成';
    const item = getItem(repair.data.itemType, repair.data.itemId);

    let nextRepair = repair;
    if (body.status || body.fields) {
      nextRepair = repo.updateRecord('repairRecords', repairId, (r) => ({
        status: body.status || r.status,
        data: { ...r.data, ...(body.fields || {}) }
      }));
      repo.addEvent({
        recordId: repairId, collection: 'repairRecords',
        action: body.action || '修补流转', status: nextRepair.status,
        actor: body.actor, note: body.note || '', data: body.fields || {}
      });
    }

    let updatedItem = item;
    if (completing) {
      const usableStatus = repair.data.itemType === 'puppetHead' ? '可演出' : '在库';
      updatedItem = repo.updateRecord(ITEM_COLLECTIONS[repair.data.itemType], item.id, (r) => ({
        status: usableStatus,
        data: setItemUsable(r, true)
      }));
      repo.addEvent({
        recordId: item.id, collection: ITEM_COLLECTIONS[repair.data.itemType],
        action: '修复闭环·恢复可用', status: usableStatus,
        actor: body.actor, note: body.note || `修补单 ${repairId} 完成`,
        data: { repairRecordId: repairId }
      });
      for (const report of repo.listRecords('lossReports')) {
        if (
          report.data.itemType === repair.data.itemType &&
          report.data.itemId === item.id &&
          report.data.resolved &&
          report.status !== '已完成' &&
          report.status !== '确认为遗失'
        ) {
          repo.updateRecord('lossReports', report.id, () => ({
            status: '已完成',
            data: { ...report.data, repairRecordId: repairId, repairedAt: new Date().toISOString() }
          }));
          repo.addEvent({
            recordId: report.id, collection: 'lossReports',
            action: '原件修复闭环', status: '已完成',
            actor: body.actor, data: { repairRecordId: repairId }
          });
        }
      }
    }
    return { status: 200, body: { repairRecord: toView(nextRepair), item: toView(updatedItem) } };
  }

  // ---------- 5. 装箱单结束：解除未结束状态，释放档期 ----------
  function closeTourBox(boxId, body) {
    const box = requireRecord('tourBoxes', boxId, '装箱单');
    if (box.status === '已闭环') throw new HttpError(409, '装箱单已闭环');
    if (box.status === '冻结') throw new HttpError(409, '装箱单处于冻结状态：先完成替补，再结束档期');

    const activeEntries = repo
      .listActiveLedger()
      .filter((e) => e.tourBoxId === boxId);
    for (const entry of activeEntries) repo.releaseEntry(entry.id, '装箱单结束');

    const updated = repo.updateRecord('tourBoxes', boxId, (r) => ({
      status: '已闭环',
      data: { ...r.data, closedAt: new Date().toISOString() }
    }));
    repo.addEvent({
      recordId: boxId, collection: 'tourBoxes',
      action: '结束档期·闭环', status: '已闭环',
      actor: (body && body.actor) || '', note: (body && body.note) || '',
      data: { releasedEntries: activeEntries.map((e) => ({ itemType: e.itemType, itemId: e.itemId })) }
    });
    return { status: 200, body: { tourBox: toView(updated), released: activeEntries.length } };
  }

  // ---------- 6. 确认遗失 ----------
  function confirmLost(lossId, body) {
    const report = requireRecord('lossReports', lossId, '缺损记录');
    const updated = repo.updateRecord('lossReports', lossId, (r) => ({
      status: '确认为遗失',
      data: { ...r.data, confirmedLost: true, lostAt: new Date().toISOString() }
    }));
    repo.addEvent({
      recordId: lossId, collection: 'lossReports',
      action: '确认为遗失', status: '确认为遗失',
      actor: (body && body.actor) || '', note: (body && body.note) || '', data: {}
    });
    return { status: 200, body: { lossReport: toView(updated) } };
  }

  // ---------- 查询：当前占用（旧档期留档不计）与履历 ----------
  function itemOccupancy(itemType, itemId) {
    if (!ITEM_COLLECTIONS[itemType]) throw new HttpError(400, `itemType 非法：${itemType}`);
    const item = getItem(itemType, itemId);
    const all = repo.listLedgerByItem(itemType, itemId);
    const active = all.filter((e) => e.status === 'ACTIVE');
    return {
      status: 200,
      body: {
        item: toView(item),
        current: active.map((e) => ({
          tourBoxId: e.tourBoxId, startDate: e.startDate, endDate: e.endDate, reason: e.reason || null
        })),
        archived: all
          .filter((e) => e.status === 'RELEASED')
          .map((e) => ({
            tourBoxId: e.tourBoxId, startDate: e.startDate, endDate: e.endDate,
            reason: e.reason || null, releasedAt: e.releasedAt || null
          }))
      }
    };
  }

  function itemTimeline(itemType, itemId) {
    if (!ITEM_COLLECTIONS[itemType]) throw new HttpError(400, `itemType 非法：${itemType}`);
    const collection = ITEM_COLLECTIONS[itemType];
    const item = requireRecord(collection, itemId, '物品');
    const itemEvents = repo.listEvents(itemId).map((e) => ({
      id: e.id, scope: '事件', action: e.action, status: e.status, actor: e.actor,
      note: e.note, data: e.data, createdAt: e.createdAt
    }));
    // 列表与履历一致：履历中包含每一条台账的占位与撤档/释放
    const ledgerEvents = repo.listLedgerByItem(itemType, itemId).map((e) => ({
      id: 'ledger:' + e.id, scope: '档期',
      action: e.status === 'ACTIVE' ? '档期占位' : '档期释放（留档）',
      status: e.status,
      note: e.reason || '',
      data: { tourBoxId: e.tourBoxId, startDate: e.startDate, endDate: e.endDate, releasedAt: e.releasedAt || null },
      createdAt: e.releasedAt || e.createdAt
    }));
    const timeline = [...itemEvents, ...ledgerEvents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { status: 200, body: { item: toView(item), timeline } };
  }

  return {
    bookTourBox,
    reportLoss,
    substituteLoss,
    createRepairRecord,
    updateRepairRecord,
    closeTourBox,
    confirmLost,
    itemOccupancy,
    itemTimeline,
    toView,
    requireRecord,
    validateRequired
  };
}

module.exports = { createServices };
