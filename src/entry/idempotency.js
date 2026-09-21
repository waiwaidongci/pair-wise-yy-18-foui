'use strict';

// 幂等键来源：优先 Idempotency-Key 请求头，其次请求体 idempotencyKey
function idempotencyKeyOf(req) {
  const headerKey = req.get('Idempotency-Key');
  return headerKey || (req.body && req.body.idempotencyKey) || null;
}

module.exports = { idempotencyKeyOf };
