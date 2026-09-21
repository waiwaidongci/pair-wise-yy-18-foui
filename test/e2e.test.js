'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const dbFile = path.join(os.tmpdir(), `puppet-tour-${process.pid}-${Date.now()}.json`);
const { app } = createApp({ dbFile });

let server, base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  fs.rmSync(dbFile, { force: true });
});

async function api(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  if (res.status !== 204) json = await res.json();
  return { status: res.status, body: json, replayed: res.headers.get('idempotent-replayed') };
}

let headA, headB, headC, headOtherPlay, accA, accB;

test('0. 建档：同剧目同角色有替件，另有异剧目/不可用偶头', async () => {
  const mkHead = async (data) => (await api('POST', '/puppetHeads', data)).body;
  headA = await mkHead({ role: '孙悟空', play: '火焰山', paintStatus: '完好', mechanism: '正常', boxNo: '甲-01' });
  headB = await mkHead({ role: '孙悟空', play: '火焰山', paintStatus: '完好', mechanism: '正常', boxNo: '甲-02' });
  headC = await mkHead({ role: '孙悟空', play: '火焰山', paintStatus: '完好', mechanism: '正常', boxNo: '甲-03' });
  headOtherPlay = await mkHead({ role: '孙悟空', play: '三打白骨精', paintStatus: '完好', mechanism: '正常', boxNo: '甲-04' });
  accA = (await api('POST', '/accessories', { name: '虎皮裙', role: '孙悟空', play: '火焰山', boxNo: '配-01' })).body;
  accB = (await api('POST', '/accessories', { name: '虎皮裙', role: '孙悟空', play: '火焰山', boxNo: '配-02' })).body;
  assert.equal(headA.status, '可演出');
  assert.equal(accA.status, '在库');
});

test('1. 装箱单登记起止日期：成功占位', async () => {
  const r = await api('POST', '/tourBoxes', {
    showName: '火焰山·杭州站', venue: '杭州', play: '火焰山',
    startDate: '2026-10-01', endDate: '2026-10-05',
    headIds: [headA.id], accessoryIds: [accA.id]
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, '已装箱');

  const occ = (await api('GET', `/items/puppetHead/${headA.id}/occupancy`)).body;
  assert.equal(occ.current.length, 1);
  assert.equal(occ.current[0].startDate, '2026-10-01');
  assert.deepEqual(occ.archived, []);
});

test('2. 重叠档期同一偶头 → 409 且不落库（装箱单/台账均不增加）', async () => {
  const before = await api('GET', '/tourBoxes');
  const r = await api('POST', '/tourBoxes', {
    showName: '火焰山·苏州站', venue: '苏州', play: '火焰山',
    startDate: '2026-10-03', endDate: '2026-10-08',
    headIds: [headA.id], accessoryIds: []
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /档期冲突/);
  assert.ok(r.body.details.conflicts[0].conflict.tourBoxId);

  const after = await api('GET', '/tourBoxes');
  assert.equal(after.body.length, before.body.length, '冲突请求不得新建装箱单');
  const occ = (await api('GET', `/items/puppetHead/${headA.id}/occupancy`)).body;
  assert.equal(occ.current.length, 1, '冲突请求不得新增占用');
});

test('3. 边界相邻（10-06 起）不重叠 → 成功；同一天（10-05）重叠 → 409', async () => {
  const adjacent = await api('POST', '/tourBoxes', {
    showName: '火焰山·南京站', venue: '南京', play: '火焰山',
    startDate: '2026-10-06', endDate: '2026-10-10',
    headIds: [headB.id], accessoryIds: []
  });
  assert.equal(adjacent.status, 201, '相邻日期不算冲突');

  const sameDay = await api('POST', '/tourBoxes', {
    showName: 'x', venue: 'x', play: '火焰山',
    startDate: '2026-10-05', endDate: '2026-10-05',
    headIds: [headA.id], accessoryIds: []
  });
  assert.equal(sameDay.status, 409);
});

test('4. 草稿单不占用档期', async () => {
  const r = await api('POST', '/tourBoxes', {
    showName: '草稿单', venue: '上海', play: '火焰山',
    startDate: '2026-10-02', endDate: '2026-10-04',
    headIds: [headC.id], accessoryIds: [], status: '草稿'
  });
  assert.equal(r.status, 201);
  const occ = (await api('GET', `/items/puppetHead/${headC.id}/occupancy`)).body;
  assert.equal(occ.current.length, 0);
});

test('5. 幂等：同键重复请求沿用首次结果', async () => {
  const body = {
    showName: '幂等站', venue: '绍兴', play: '火焰山',
    startDate: '2026-11-01', endDate: '2026-11-02',
    headIds: [headC.id], accessoryIds: [], idempotencyKey: 'key-book-1'
  };
  const first = await api('POST', '/tourBoxes', body);
  assert.equal(first.status, 201);
  const second = await api('POST', '/tourBoxes', body);
  assert.equal(second.status, 201);
  assert.equal(second.replayed, 'true');
  assert.equal(second.body.id, first.body.id);

  // 同一幂等键的冲突请求也沿用首次 409
  const conflictBody = {
    showName: '冲突站', venue: '宁波', play: '火焰山',
    startDate: '2026-10-02', endDate: '2026-10-03',
    headIds: [headA.id], accessoryIds: [], idempotencyKey: 'key-conflict-1'
  };
  const c1 = await api('POST', '/tourBoxes', conflictBody);
  const c2 = await api('POST', '/tourBoxes', conflictBody);
  assert.equal(c1.status, 409);
  assert.equal(c2.status, 409);
  assert.equal(c2.replayed, 'true');
});

test('6. 并发：同键并发只创建一张；无键并发恰好一张成功其余 409', async () => {
  const common = {
    showName: '并发站', venue: '温州', play: '火焰山',
    startDate: '2026-12-01', endDate: '2026-12-03', headIds: [headC.id], accessoryIds: []
  };
  // 同键
  const sameKey = await Promise.all(Array.from({ length: 5 }, () =>
    api('POST', '/tourBoxes', { ...common, idempotencyKey: 'key-race-same' })));
  const ids = new Set(sameKey.map((r) => r.body.id));
  assert.equal(ids.size, 1);
  assert.ok(sameKey.every((r) => r.status === 201));

  // 无键：不同单据，但同档期同偶头，只有一张赢
  const noKey = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    api('POST', '/tourBoxes', { ...common, showName: '无键竞争' + i, startDate: '2026-12-10', endDate: '2026-12-12' })));
  assert.equal(noKey.filter((r) => r.status === 201).length, 1);
  assert.equal(noKey.filter((r) => r.status === 409).length, 4);
  const occ = (await api('GET', `/items/puppetHead/${headC.id}/occupancy`)).body;
  assert.equal(occ.current.filter((e) => e.startDate === '2026-12-10').length, 1);
});

let boxHangzhou, lossId;

test('7. 演出前缺损：装箱单冻结、原件撤档留档、进入待修补', async () => {
  const boxes = (await api('GET', '/tourBoxes?status=已装箱')).body;
  boxHangzhou = boxes.find((b) => b.showName === '火焰山·杭州站');

  const r = await api('POST', '/lossReports', {
    tourBoxId: boxHangzhou.id, itemType: 'puppetHead', itemId: headA.id,
    problem: '左眉掉彩', actor: '箱头'
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.tourBox.status, '冻结');
  assert.equal(r.body.item.status, '待修补');
  assert.equal(r.body.item.currentUsable, false);
  lossId = r.body.lossReport.id;

  const occ = (await api('GET', `/items/puppetHead/${headA.id}/occupancy`)).body;
  assert.deepEqual(occ.current, [], '原件不再计当前占用');
  assert.equal(occ.archived.length, 1, '旧档期留档');
  assert.equal(occ.archived[0].reason, '演出前缺损撤档');

  // 冻结期：禁止再登记缺损 / 禁止结束 / 禁止直接 PATCH
  const another = await api('POST', '/lossReports', {
    tourBoxId: boxHangzhou.id, itemType: 'accessory', itemId: accA.id, problem: '撕裂'
  });
  assert.equal(another.status, 409);
  assert.equal((await api('POST', `/tourBoxes/${boxHangzhou.id}/close`, {})).status, 409);
  assert.equal((await api('PATCH', `/tourBoxes/${boxHangzhou.id}`, { status: '已闭环' })).status, 405);
});

test('8. 替补资格：异剧目 422、不可用 422、替件档期冲突 409', async () => {
  assert.equal((await api('POST', `/lossReports/${lossId}/substitute`, { itemId: headOtherPlay.id })).status, 422);

  // headA 自身（不可用且为原件）
  assert.equal((await api('POST', `/lossReports/${lossId}/substitute`, { itemId: headA.id })).status, 422);

  // 让 headB 在杭州档期上已被占用（10-01~10-05 与南京单 10-06~10-10 不重叠，需另造冲突）
  const clash = await api('POST', '/tourBoxes', {
    showName: '冲突占位', venue: '湖州', play: '火焰山',
    startDate: '2026-10-02', endDate: '2026-10-04',
    headIds: [headB.id], accessoryIds: []
  });
  // headB 在南京单（10-06~10-10）不冲突，此单应成功
  assert.equal(clash.status, 201);
  const conflictSub = await api('POST', `/lossReports/${lossId}/substitute`, { itemId: headB.id });
  assert.equal(conflictSub.status, 409);
});

test('9. 合规替补接替：同剧目同角色可用、档期通过 → 解冻，替件占用原档期', async () => {
  const r = await api('POST', `/lossReports/${lossId}/substitute`, { itemId: headC.id, actor: '箱头' });
  assert.equal(r.status, 200);
  assert.equal(r.body.tourBox.status, '已装箱', '无待替补槽位即解冻');
  assert.ok(r.body.tourBox.headIds.includes(headC.id));
  assert.ok(!r.body.tourBox.headIds.includes(headA.id));

  const occC = (await api('GET', `/items/puppetHead/${headC.id}/occupancy`)).body;
  assert.ok(occC.current.some((e) => e.tourBoxId === boxHangzhou.id && e.startDate === '2026-10-01'));
  const occA = (await api('GET', `/items/puppetHead/${headA.id}/occupancy`)).body;
  assert.deepEqual(occA.current, []);

  // 重复替补沿用/拒绝：缺损已解决
  assert.equal((await api('POST', `/lossReports/${lossId}/substitute`, { itemId: headC.id })).status, 409);
});

test('10. 修复闭环前原件不可占用；闭环后可按新档期占用，履历与列表一致', async () => {
  // 未完成修复：用 headA 新档期 → 422
  const before = await api('POST', '/tourBoxes', {
    showName: '旧件复出走穴', venue: '金华', play: '火焰山',
    startDate: '2027-01-01', endDate: '2027-01-02', headIds: [headA.id], accessoryIds: []
  });
  assert.equal(before.status, 422);

  // 闭环
  const repair = await api('POST', '/repairRecords', {
    itemType: 'puppetHead', itemId: headA.id,
    repairType: '补漆', handler: '漆匠李', complete: true
  });
  assert.equal(repair.status, 201);
  assert.equal(repair.body.item.status, '可演出');
  assert.equal(repair.body.item.currentUsable, true);

  // 旧档期（杭州）已留档不计当前占用：与旧日期重叠也不冲突
  const reuseOld = await api('POST', '/tourBoxes', {
    showName: '旧件新档期', venue: '杭州', play: '火焰山',
    startDate: '2026-10-04', endDate: '2026-10-05', headIds: [headA.id], accessoryIds: []
  });
  assert.equal(reuseOld.status, 201);

  // 列表与履历一致：occupancy.current 里的每张单都能在履历中找到占位/释放事件
  const occ = (await api('GET', `/items/puppetHead/${headA.id}/occupancy`)).body;
  const tl = (await api('GET', `/items/puppetHead/${headA.id}/timeline`)).body;
  const ledgerActions = tl.timeline.filter((e) => e.scope === '档期');
  for (const c of occ.current) {
    assert.ok(ledgerActions.some((e) => e.status === 'ACTIVE' && e.data.tourBoxId === c.tourBoxId));
  }
  for (const a of occ.archived) {
    assert.ok(ledgerActions.some((e) => e.status === 'RELEASED' && e.data.tourBoxId === a.tourBoxId));
  }
  assert.ok(tl.timeline.some((e) => e.action === '修复闭环·恢复可用'));
});

test('11. 结束装箱单：未结束状态解除，重叠档期可再占；闭环单不再挡档期', async () => {
  // headC 有绍兴 11-01~11-02 的单，先找到并结束
  const occ = (await api('GET', `/items/puppetHead/${headC.id}/occupancy`)).body;
  const shaoxing = occ.current.find((e) => e.startDate === '2026-11-01');
  assert.ok(shaoxing);
  const closed = await api('POST', `/tourBoxes/${shaoxing.tourBoxId}/close`, { actor: '箱头' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.tourBox.status, '已闭环');

  const after = (await api('GET', `/items/puppetHead/${headC.id}/occupancy`)).body;
  assert.ok(!after.current.some((e) => e.tourBoxId === shaoxing.tourBoxId));

  const rebook = await api('POST', '/tourBoxes', {
    showName: '闭幕后再占', venue: '绍兴', play: '火焰山',
    startDate: '2026-11-02', endDate: '2026-11-03', headIds: [headC.id], accessoryIds: []
  });
  assert.equal(rebook.status, 201);

  // 重复结束 → 409
  assert.equal((await api('POST', `/tourBoxes/${shaoxing.tourBoxId}/close`, {})).status, 409);
});

test('12. 日期非法/必填缺失 → 400；未知集合 → 404', async () => {
  assert.equal((await api('POST', '/tourBoxes', {
    showName: 'x', venue: 'x', play: '火焰山', startDate: '2026/10/01', endDate: '2026-10-02'
  })).status, 400);
  assert.equal((await api('POST', '/tourBoxes', {
    showName: 'x', venue: 'x', play: '火焰山', startDate: '2026-10-05', endDate: '2026-10-01'
  })).status, 400);
  assert.equal((await api('GET', '/nope')).status, 404);
});

test('13. 列表中装箱单当前构成由台账派生（含替补后状态）', async () => {
  const boxes = (await api('GET', '/tourBoxes')).body;
  const hz = boxes.find((b) => b.id === boxHangzhou.id);
  assert.deepEqual(hz.currentHeadIds, [headC.id]);
  assert.equal(hz.ended, false);
});

test('14. 配件缺损替补同规则', async () => {
  // 找一张含 accA 且已装箱的单（杭州），但杭州已冻结过又解冻——可再对配件登记缺损
  const r = await api('POST', '/lossReports', {
    tourBoxId: boxHangzhou.id, itemType: 'accessory', itemId: accA.id, problem: '裙边撕裂'
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.status, '缺损');
  const accLossId = r.body.lossReport.id;

  assert.equal((await api('POST', `/lossReports/${accLossId}/substitute`, { itemId: accB.id })).status, 200);

  // accA 修复闭环
  const done = await api('POST', '/repairRecords', {
    itemType: 'accessory', itemId: accA.id, repairType: '缝补', handler: '裁缝王', complete: true
  });
  assert.equal(done.body.item.status, '在库');
});
