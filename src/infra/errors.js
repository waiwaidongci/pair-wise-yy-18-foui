'use strict';

// 统一的领域错误：携带 HTTP 状态码，由入口层转响应
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { HttpError };
