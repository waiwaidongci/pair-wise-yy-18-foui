'use strict';

// 进程级串行写锁：任意时刻只有一个事务执行 read -> mutate -> save。
// Node 虽为单线程，但“跨 await 的读改写”仍可能交错；用队列把写事务串行化，
// 使“重复或并发沿用首次结果”有确定的先后次序。
function createLock() {
  let queue = Promise.resolve();
  return function withLock(task) {
    const run = queue.then(() => task());
    // 成功或失败都不阻断队列中的后续任务
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
}

module.exports = { createLock };
