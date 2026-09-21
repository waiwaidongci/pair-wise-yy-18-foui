# 传统木偶戏班偶头与巡演装箱 API

为木偶戏班巡演做**档期占位**与**缺损替补闭环**。代码按三层组织：

| 层 | 目录 | 职责 |
| --- | --- | --- |
| 入口层 | `src/entry/` | HTTP 路由、幂等键复用、事务边界（加锁/落盘） |
| 规则层 | `src/domain/` | 档期重叠、替件资格、可用性等纯规则 + 用例编排 |
| 记录层 | `src/infra`、`src/records` | JSON 文件原子存储、记录/事件/占用台账仓储 |

## 启动

```bash
npm install
npm start        # http://localhost:3914
npm test         # node --test，15 个端到端用例
```

数据文件为 `data/app.json`（原子写：临时文件 + rename）。

## 核心规则

1. **装箱单登记起止日期**：`POST /api/tourBoxes`（必填 `startDate`/`endDate`，`YYYY-MM-DD` 闭区间）。
2. 同一偶头/配件在**重叠档期内只能进入一张未结束装箱单**（`已闭环` 不再挡档期；冻结单仍占档期）。冲突返回 **409 且不落库**——所有校验先于任何写入。
3. **重复或并发沿用首次结果**：写请求带 `Idempotency-Key` 头（或 body 里的 `idempotencyKey`），同键请求（含首次 409）都返回首次结果（响应头 `Idempotent-Replayed: true`）；无键并发由进程级串行锁保证恰好一单成功。
4. **演出前缺损**（`POST /api/lossReports`）：装箱单**冻结**，原件占用撤下（旧台账置 `RELEASED` 留档，不物理删除，不计当前占用），原件进入修复闭环、不可再被占用。冻结期只能做替补，不能登记新缺损/结束/改写。
5. **替补**（`POST /api/lossReports/:id/substitute`）：只能由**同剧目同角色**的**可用替件**接替（异剧目/异角色/不可用 → 422）；替件**同样做档期检查**（重叠 → 409）。接替后替件在原档期入账，装箱单解冻。
6. **原件修复闭环**（`POST /api/repairRecords`，`complete:true`，或 `PATCH /api/repairRecords/:id` 置 `已完成`）后才恢复可用，**按新档期重新占用**；旧档期留档但不计当前占用。
7. **列表与履历一致**：装箱单列表的当前构成由 ACTIVE 占用台账派生；物品履历（`/api/items/:itemType/:id/timeline`）包含每一次占位与释放事件。

## 接口一览

```
POST   /api/tourBoxes                       装箱单登记（档期占位，409 不落库）
POST   /api/tourBoxes/:id/close             结束档期（已闭环，释放占用）
POST   /api/lossReports                     演出前缺损登记（冻结+撤档）
POST   /api/lossReports/:id/substitute      同剧目同角色替件接替（含档期检查）
POST   /api/lossReports/:id/confirm-lost    确认遗失
POST   /api/repairRecords                   修补登记（complete=true 即修复闭环）
PATCH  /api/repairRecords/:id               修补流转（置“已完成”= 闭环恢复可用）
GET    /api/items/:itemType/:id/occupancy   当前占用 + 已留档旧档期
GET    /api/items/:itemType/:id/timeline    物品履历（事件 + 档期台账）
GET    /api/:collection?status=&play=&...   列表（tourBoxes 附带台账派生构成）
GET    /api/:collection/:id/timeline        单据履历
POST   /api/puppetHeads|/accessories        档案类通用建档
```

`itemType` 取值：`puppetHead`（对应集合 `puppetHeads`）、`accessory`（对应 `accessories`）。
领域集合（tourBoxes/lossReports/repairRecords）禁止直接 PATCH/DELETE 绕过闭环，返回 405。

## 快速验证

```bash
curl -sXPOST localhost:3914/api/tourBoxes -H 'content-type: application/json' \
  -d '{"showName":"火焰山·杭州站","venue":"杭州","play":"火焰山","startDate":"2026-10-01","endDate":"2026-10-05","headIds":["head-seed-2"],"accessoryIds":["accessory-seed-1"]}'
```
