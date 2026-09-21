'use strict';

const { now, newId } = require('../infra/util');

// ===== 记录层（仓储）：只负责记录读写，不写业务规则 =====

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

// 通用记录 + 事件 + 占用台账 + 幂等结果的仓储。
// 所有方法同步操作内存中的 state；由外层事务保证 save 只在业务成功后执行。
function createRepository(state, config) {
  const records = state.records;
  const events = state.events;
  const ledger = state.ledger;

  return {
    titleFor,

    listRecords(collection) {
      return records.filter((r) => r.collection === collection);
    },

    getRecord(collection, id) {
      return records.find((r) => r.collection === collection && r.id === id) || null;
    },

    insertRecord(collection, data, status, id) {
      const collectionConfig = config.collections[collection];
      const recordId = id || newId();
      const ts = now();
      const record = {
        id: recordId,
        collection,
        status,
        title: titleFor(collectionConfig, data),
        data: JSON.parse(JSON.stringify(data)),
        createdAt: ts,
        updatedAt: ts
      };
      records.push(record);
      return record;
    },

    updateRecord(collection, id, mutator) {
      const record = this.getRecord(collection, id);
      if (!record) return null;
      const patch = mutator(record) || {};
      if (patch.data) record.data = JSON.parse(JSON.stringify(patch.data));
      if (patch.status) record.status = patch.status;
      record.data.status = record.status;
      record.title = titleFor(config.collections[collection], record.data);
      record.updatedAt = now();
      return record;
    },

    addEvent({ recordId, collection, action, status, actor, note, data }) {
      events.push({
        id: newId(),
        recordId,
        collection,
        action: action || '记录',
        status: status || '',
        actor: actor || '',
        note: note || '',
        data: JSON.parse(JSON.stringify(data || {})),
        createdAt: now()
      });
    },

    listEvents(recordId) {
      return events.filter((e) => e.recordId === recordId);
    },

    // ===== 占用台账（只追加，永不物理删除；撤档以 released 体现）=====
    appendLedger({ itemType, itemId, tourBoxId, startDate, endDate, status, reason }) {
      const entry = {
        id: newId(),
        itemType,
        itemId,
        tourBoxId,
        startDate,
        endDate,
        status, // ACTIVE | RELEASED
        reason,
        createdAt: now()
      };
      ledger.push(entry);
      return entry;
    },

    listLedgerByItem(itemType, itemId) {
      return ledger.filter((e) => e.itemType === itemType && e.itemId === itemId);
    },

    listActiveLedger() {
      return ledger.filter((e) => e.status === 'ACTIVE');
    },

    releaseEntry(entryId, reason) {
      const entry = ledger.find((e) => e.id === entryId);
      if (!entry) return null;
      entry.status = 'RELEASED';
      entry.reason = reason;
      entry.releasedAt = now();
      return entry;
    },

    // ===== 幂等结果：同一幂等键重复/并发都复用首次结果 =====
    getIdempotent(key) {
      return state.idempotency[key] || null;
    },

    putIdempotent(key, result) {
      state.idempotency[key] = { ...result, createdAt: now() };
    }
  };
}

module.exports = { createRepository };
