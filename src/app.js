'use strict';

const express = require('express');
const path = require('path');
const config = require('../project.config');
const { createStore } = require('./infra/store');
const { createLock } = require('./infra/lock');
const { createRepository } = require('./records/repository');
const { createServices } = require('./domain/services');
const { createRouter } = require('./entry/router');

function seedIfEmpty(state, repo) {
  if (state.records.length > 0) return;
  for (const seed of config.seed || []) {
    const cfg = config.collections[seed.collection];
    const status = seed.status || cfg.defaultStatus || '';
    const data = { ...seed.data, status };
    const record = repo.insertRecord(seed.collection, data, status, seed.id);
    repo.addEvent({
      recordId: record.id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data
    });
  }
}

function createApp(options = {}) {
  const dbFile = options.dbFile || path.join(__dirname, '..', 'data', 'app.json');
  const store = createStore(dbFile);
  const state = store.load();
  const lock = createLock();
  const repo = createRepository(state, config);
  const services = createServices(repo, config);
  seedIfEmpty(state, repo);
  if (options.seed !== false) store.save(state);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.get('/health', (req, res) => res.json({ ok: true, service: config.title }));
  app.use('/api', createRouter({ config, state, repo, services, lock, store }));

  app.use((error, req, res, next) => {
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'server error', ...(error.details ? { details: error.details } : {}) });
  });

  return { app, state, store, lock };
}

module.exports = { createApp, config };
