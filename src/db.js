'use strict';

// 数据访问底座：sql.js（WASM 版 SQLite）。
// 原实现依赖系统 sqlite3 CLI（本机未安装且无 root），改为进程内 WASM，
// 每次写事务结束后一次性导出到 data/app.db，保证崩溃后不丢已提交数据。

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const WASM_FILE = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let db = null;
let dirty = false;

function persist() {
  if (!dirty) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
  dirty = false;
}

async function init() {
  const SQL = await initSqlJs({ locateFile: () => WASM_FILE });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  // 单连接、同步执行；配合 service 层互斥量，每个动作就是一个原子事务
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA busy_timeout = 5000;');
}

// 执行任意 SQL（DDL / INSERT / UPDATE），? 参数绑定
function run(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
  dirty = true;
}

// sql.js 的 prepare 只处理单条语句，多条 DDL 需拆开逐条执行
function execScript(sql) {
  for (const statement of sql.split(';')) {
    if (statement.trim()) db.run(statement);
  }
  dirty = true;
}

// 查询多行，返回普通对象数组
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

// 一个业务动作内的原子事务：抛错则整体回滚（409 冲突不产生任何落库）
function transaction(work) {
  db.run('BEGIN IMMEDIATE;');
  try {
    const result = work();
    db.run('COMMIT;');
    persist();
    return result;
  } catch (error) {
    db.run('ROLLBACK;');
    throw error;
  }
}

module.exports = { init, run, execScript, all, get, transaction, persist, DB_FILE };
