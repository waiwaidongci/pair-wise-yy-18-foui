'use strict';

// 记录层：只管 records / events / allocations / idempotency 四张表的读写。
// allocations 是“当前占用”的唯一事实来源（single source of truth）：
//   active   = 当前有效占用（偶头/配件此刻在一张未结束装箱单里）
//   archived = 旧档期留档（装箱单已闭环、演出前缺损被替下、修复闭环前归档）

const { randomUUID } = require('crypto');
const db = require('./db');
const config = require('../project.config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);

CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  box_id TEXT NOT NULL,
  box_title TEXT NOT NULL,
  play TEXT NOT NULL,
  role TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  allocation_type TEXT NOT NULL DEFAULT 'original',
  archived_reason TEXT,
  replaced_by_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alloc_item ON allocations(item_type, item_id, status);
CREATE INDEX IF NOT EXISTS idx_alloc_box ON allocations(box_id, status);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  body TEXT NOT NULL,
  reused_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

function initSchema() {
  db.execScript(SCHEMA);
}

function now() {
  return new Date().toISOString();
}

function findCollection(name) {
  return config.collections[name] || null;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function toAllocation(row) {
  return {
    id: row.id,
    itemType: row.item_type,
    itemId: row.item_id,
    itemName: row.item_name,
    tourBoxId: row.box_id,
    tourBoxTitle: row.box_title,
    play: row.play,
    role: row.role,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    allocationType: row.allocation_type,
    archivedReason: row.archived_reason || undefined,
    replacedById: row.replaced_by_id || undefined,
    createdAt: row.created_at
  };
}

// ---------- records ----------

function insertRecord(collection, id, status, data) {
  const collectionConfig = findCollection(collection);
  const createdAt = now();
  db.run(
    `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    [id, collection, status, titleFor(collectionConfig, data), JSON.stringify(data), createdAt, createdAt]
  );
  return loadRecord(collection, id);
}

function updateRecord(collection, id, status, data) {
  const collectionConfig = findCollection(collection);
  db.run(
    `UPDATE records SET status = ?, title = ?, data = ?, updated_at = ?
     WHERE collection = ? AND id = ?;`,
    [status, titleFor(collectionConfig, data), JSON.stringify(data), now(), collection, id]
  );
  return loadRecord(collection, id);
}

function loadRecord(collection, id) {
  const row = db.get('SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;', [collection, id]);
  return row ? toRecord(row) : null;
}

function listRecords(collection) {
  return db
    .all('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;', [collection])
    .map(toRecord);
}

function deleteRecord(collection, id) {
  db.run('DELETE FROM records WHERE collection = ? AND id = ?;', [collection, id]);
  db.run('DELETE FROM events WHERE record_id = ?;', [id]);
}

function recordCount() {
  return db.get('SELECT COUNT(*) AS count FROM records;').count;
}

// ---------- events ----------

function addEvent({ recordId, collection, action, status, actor, note, data }) {
  db.run(
    `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      randomUUID(),
      recordId,
      collection,
      action || '记录',
      status || '',
      actor || '',
      note || '',
      JSON.stringify(data || {}),
      now()
    ]
  );
}

function listEventsByRecord(recordId) {
  return db
    .all('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC;', [recordId])
    .map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
}

// ---------- allocations ----------

function insertAllocation(entry) {
  const id = randomUUID();
  db.run(
    `INSERT INTO allocations
       (id, item_type, item_id, item_name, box_id, box_title, play, role,
        start_date, end_date, status, allocation_type, archived_reason, replaced_by_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      id,
      entry.itemType,
      entry.itemId,
      entry.itemName,
      entry.boxId,
      entry.boxTitle,
      entry.play,
      entry.role,
      entry.startDate,
      entry.endDate,
      entry.status || 'active',
      entry.allocationType || 'original',
      entry.archivedReason || null,
      entry.replacedById || null,
      now()
    ]
  );
  return id;
}

function activeAllocationsForItem(itemType, itemId) {
  return db
    .all(
      `SELECT * FROM allocations WHERE item_type = ? AND item_id = ? AND status = 'active'
       ORDER BY start_date ASC;`,
      [itemType, itemId]
    )
    .map(toAllocation);
}

function allocationsForItem(itemType, itemId) {
  return db
    .all(
      'SELECT * FROM allocations WHERE item_type = ? AND item_id = ? ORDER BY created_at ASC;',
      [itemType, itemId]
    )
    .map(toAllocation);
}

function activeAllocationsForBox(boxId) {
  return db
    .all("SELECT * FROM allocations WHERE box_id = ? AND status = 'active' ORDER BY created_at ASC;", [boxId])
    .map(toAllocation);
}

function archiveAllocation(id, { reason, replacedById } = {}) {
  db.run(
    `UPDATE allocations
       SET status = 'archived', archived_reason = ?, replaced_by_id = COALESCE(?, replaced_by_id)
     WHERE id = ?;`,
    [reason || null, replacedById || null, id]
  );
}

// ---------- idempotency ----------

function getIdempotency(key) {
  const row = db.get('SELECT * FROM idempotency WHERE key = ?;', [key]);
  if (!row) return null;
  return {
    key: row.key,
    scope: row.scope,
    statusCode: row.status_code,
    body: JSON.parse(row.body),
    reusedCount: row.reused_count,
    createdAt: row.created_at
  };
}

function saveIdempotency(key, scope, statusCode, body) {
  db.run(
    `INSERT INTO idempotency (key, scope, status_code, body, reused_count, created_at)
     VALUES (?, ?, ?, ?, 0, ?);`,
    [key, scope, statusCode, JSON.stringify(body), now()]
  );
}

function bumpIdempotency(key) {
  db.run('UPDATE idempotency SET reused_count = reused_count + 1 WHERE key = ?;', [key]);
}

// ---------- seed ----------

function seedIfEmpty() {
  if (recordCount() > 0) return;
  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    insertRecord(seed.collection, id, status, data);
    addEvent({
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data
    });
  }
}

module.exports = {
  initSchema,
  seedIfEmpty,
  now,
  findCollection,
  titleFor,
  toRecord,
  insertRecord,
  updateRecord,
  loadRecord,
  listRecords,
  deleteRecord,
  addEvent,
  listEventsByRecord,
  insertAllocation,
  activeAllocationsForItem,
  allocationsForItem,
  activeAllocationsForBox,
  archiveAllocation,
  getIdempotency,
  saveIdempotency,
  bumpIdempotency
};
