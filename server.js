'use strict';

// 应用组装入口：分层为
//   src/db.js            数据访问底座（sql.js / SQLite）
//   src/repository.js    记录层（records / events / allocations / idempotency）
//   src/domain/rules.js  规则层（档期重叠、日期校验等纯规则）
//   src/services.js      业务闭环（占位、冻结、替补、修复闭环）
//   src/routes.js        入口层（HTTP 路由）

const express = require('express');
const db = require('./src/db');
const repo = require('./src/repository');
const routes = require('./src/routes');
const config = require('./project.config');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.use('/api', routes);

app.use((error, req, res, next) => {
  const status = error.status || 500;
  const payload = { error: error.message || 'server error' };
  if (error.code) payload.code = error.code;
  if (error.details) payload.details = error.details;
  res.status(status).json(payload);
});

db.init().then(() => {
  db.transaction(() => {
    repo.initSchema();
    repo.seedIfEmpty();
  });
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}).catch((error) => {
  console.error('failed to start:', error);
  process.exit(1);
});

module.exports = app;
