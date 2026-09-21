'use strict';

const fs = require('fs');
const path = require('path');

// 记录层（仓储）使用的 JSON 文件存储。
// 全部读写都在进程内的串行写锁中进行（见 withLock），因此 read->write 期间不会有交叉修改；
// 落盘采用“临时文件 + rename”原子替换，避免半写文件。
function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  function emptyState() {
    return {
      records: [], // { id, collection, status, title, data, createdAt, updatedAt }
      events: [],  // { id, recordId, collection, action, status, actor, note, data, createdAt }
      ledger: [],  // 占用台账（只追加）：见 records/ledger
      idempotency: {} // key -> { status, body, createdAt }
    };
  }

  function load() {
    if (!fs.existsSync(file)) return emptyState();
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return emptyState();
    const parsed = JSON.parse(raw);
    return {
      records: parsed.records || [],
      events: parsed.events || [],
      ledger: parsed.ledger || [],
      idempotency: parsed.idempotency || {}
    };
  }

  function save(state) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  return { load, save, emptyState };
}

module.exports = { createStore };
