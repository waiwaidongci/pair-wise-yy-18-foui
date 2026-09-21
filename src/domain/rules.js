'use strict';

// ===== 规则层：档期与替补规则，全部为纯函数，便于单独验证 =====

// 闭区间重叠：[s1,e1] 与 [s2,e2] 有交集即冲突（同一天也重叠）
function dateOverlap(start1, end1, start2, end2) {
  return start1 <= end2 && start2 <= end1;
}

// 可用替件/可占用判定：修复闭环未完成的原件（待修补/修补中/试演中）不可占用
function isItemUsable(itemType, record) {
  if (!record) return false;
  if (itemType === 'puppetHead') {
    return record.status === '可演出' && record.data.currentUsable !== false;
  }
  if (itemType === 'accessory') {
    return record.status === '在库';
  }
  return false;
}

// 在 ACTIVE 台账中查找档期冲突；可排除某张装箱单（替补自身所在单）
function findActiveConflict(repo, itemType, itemId, startDate, endDate, excludeBoxId) {
  return repo
    .listLedgerByItem(itemType, itemId)
    .filter((entry) => entry.status === 'ACTIVE')
    .filter((entry) => !excludeBoxId || entry.tourBoxId !== excludeBoxId)
    .find((entry) => dateOverlap(startDate, endDate, entry.startDate, entry.endDate)) || null;
}

// 替件资格：同剧目、同角色
function assertSameRolePlay(itemType, original, replacement) {
  const problems = [];
  if (!replacement.data.play || original.data.play !== replacement.data.play) {
    problems.push(`剧目不符（需同剧目：${original.data.play || '-'}）`);
  }
  if (original.data.role !== replacement.data.role) {
    problems.push(`角色不符（需同角色：${original.data.role || '-'}）`);
  }
  return problems;
}

module.exports = { dateOverlap, isItemUsable, findActiveConflict, assertSameRolePlay };
