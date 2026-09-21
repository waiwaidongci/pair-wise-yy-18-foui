# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

数据库为进程内 SQLite（sql.js / WASM，无需系统 sqlite3），每次写事务落盘到
`data/app.db`，删除该文件可回到种子数据。

## 代码分层

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 数据底座 | `src/db.js` | SQLite 连接、参数绑定、事务（冲突整单回滚不落库）、落盘 |
| 记录层 | `src/repository.js` | records / events / allocations / idempotency 表读写、种子 |
| 规则层 | `src/domain/rules.js` | 档期重叠判定、日期校验、类型与错误等纯规则 |
| 业务层 | `src/services.js` | 占位、409 冲突、幂等、冻结、替补、修复闭环、占用履历 |
| 入口层 | `src/routes.js` | HTTP 路由、状态码与响应 |
| 组装 | `server.js` | Express 应用与错误处理 |

## 档期占位与缺损替补闭环

- **装箱单登记起止日期**：`POST /api/tourBoxes` 必填 `startDate`/`endDate`（YYYY-MM-DD）。
- **同一偶头/配件重叠档期只能进一张未结束装箱单**：冲突返回 `409 scheduleConflict`，
  响应体 `details.conflicts` 给出撞档装箱单；整单在同一事务中回滚，**不落库**。
- **重复/并发沿用首次结果**：携带 `Idempotency-Key` 请求头（或 body 字段）并发提交，
  只处理一次，后续返回首次结果（`Idempotent-Replay: true`，body 带 `reused: true`）；
  无 key 时按业务指纹（剧目/场地/起止/清单）去重。
- **演出前缺损冻结**：`POST /api/lossReports`（`stage: "演出前"`）后装箱单变为
  `已冻结`，原件占用立即归档（不计当前占用），只能通过
  `POST /api/tourBoxes/:id/substitute` 由**同剧目同角色**的可用替件接替；
  替件同样做档期检查，替件不合格/撞档一律 409。全部补齐后装箱单自动解冻。
  `stage: "返场后"` 的缺损只登记、不冻结。
- **修复闭环**：`POST /api/repairRecords/:id/complete`
  （或对 repairRecords 发 status=已完成 事件）后原件恢复“可演出”，
  **才可按新档期重新占用**；旧档期留档（archived）但不计当前占用。
- **装箱单闭环**：`POST /api/tourBoxes/:id/close`，当前占用整体归档；
  冻结且仍有未接替缺损时拒绝闭环（409）。
- **列表与履历一致**：`GET /api/occupancy/items/:itemType/:itemId`
  的 `current`（active）与 `history`（active + archived）同源；
  `GET /api/:collection/:id/timeline` 同时返回事件与档期占用。

装箱单的档期与清单字段不可直接 PATCH，只能走 substitute / close 等专用入口。

## 其它常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `GET /api/:collection/:id/timeline`

## 端到端验证

```bash
# 需先启动服务；脚本会清空并重建 data/app.db
bash test/e2e.sh
```
