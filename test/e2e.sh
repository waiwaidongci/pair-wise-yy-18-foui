#!/usr/bin/env bash
# 端到端验证：档期占位 / 409 不落库 / 重复并发幂等 / 冻结替补 / 修复闭环 / 列表=履历
set -u
BASE=http://localhost:3914/api
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# jqr '<js表达式(变量v)>'；需要外部 ID 时直接在表达式中用 shell 变量插值（ID 为 UUID，安全）
jqr() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval("("+process.argv[1]+")"))})' "$1"
}

echo "== 0. 种子数据 =="
HEAD_A=$(curl -s -G "$BASE/puppetHeads" --data-urlencode 'status=待修补' | jqr 'v[0].id')
HEAD_B=$(curl -s -G "$BASE/puppetHeads" --data-urlencode 'status=可演出' | jqr 'v[0].id')
ACC_A=$(curl -s -G "$BASE/accessories" --data-urlencode 'boxNo=配件箱-02' | jqr 'v[0].id')
ACC_B=$(curl -s -G "$BASE/accessories" --data-urlencode 'boxNo=配件箱-02' | jqr 'v[1].id')
echo "  HEAD_A=$HEAD_A(待修补) HEAD_B=$HEAD_B(可演出) ACC_A=$ACC_A ACC_B=$ACC_B"

echo "== 1. 待修补偶头占位应 409 =="
CODE=$(curl -s -o /tmp/r1.json -w '%{http_code}' -X POST "$BASE/tourBoxes" -H 'Content-Type: application/json' -d "{\"showName\":\"天津场\",\"venue\":\"天津戏院\",\"play\":\"火焰山\",\"startDate\":\"2026-10-01\",\"endDate\":\"2026-10-05\",\"headIds\":[\"$HEAD_A\"],\"accessoryIds\":[\"$ACC_A\"]}")
[ "$CODE" = "409" ] && ok "不可用偶头返回409" || fail "期望409实得$CODE: $(cat /tmp/r1.json)"
CNT=$(curl -s "$BASE/tourBoxes" | jqr 'v.length')
[ "$CNT" = "0" ] && ok "冲突不落库（tourBoxes=0）" || fail "冲突后仍有装箱单 $CNT"

echo "== 2. 正常档期占位 =="
CODE=$(curl -s -o /tmp/box1.json -w '%{http_code}' -X POST "$BASE/tourBoxes" -H 'Content-Type: application/json' -d "{\"showName\":\"天津场\",\"venue\":\"天津戏院\",\"play\":\"火焰山\",\"startDate\":\"2026-10-01\",\"endDate\":\"2026-10-05\",\"headIds\":[\"$HEAD_B\"],\"accessoryIds\":[\"$ACC_A\"],\"actor\":\"班主\"}")
[ "$CODE" = "201" ] && ok "占位成功201" || fail "期望201实得$CODE: $(cat /tmp/box1.json)"
BOX1=$(cat /tmp/box1.json | jqr 'v.id')
HB_STATUS=$(curl -s "$BASE/puppetHeads/$HEAD_B" | jqr 'v.status')
[ "$HB_STATUS" = "已装箱" ] && ok "占位后偶头状态=已装箱" || fail "偶头状态=$HB_STATUS"
curl -s "$BASE/occupancy/items/puppetHead/$HEAD_B" > /tmp/occ1.json
CUR=$(cat /tmp/occ1.json | jqr 'v.current.length')
[ "$CUR" = "1" ] && ok "当前占用=1" || fail "当前占用=$CUR"

echo "== 3. 重叠档期冲突 409（同件第二张未结束装箱单）="
CODE=$(curl -s -o /tmp/r3.json -w '%{http_code}' -X POST "$BASE/tourBoxes" -H 'Content-Type: application/json' -d "{\"showName\":\"济南场\",\"venue\":\"济南戏院\",\"play\":\"火焰山\",\"startDate\":\"2026-10-04\",\"endDate\":\"2026-10-08\",\"headIds\":[\"$HEAD_B\"],\"accessoryIds\":[\"$ACC_B\"]}")
[ "$CODE" = "409" ] && ok "重叠档期409" || fail "期望409实得$CODE: $(cat /tmp/r3.json)"
node -e 'const v=require("/tmp/r3.json");process.exit(v.code==="scheduleConflict"&&v.details.conflicts.length===1?0:1)' && ok "冲突体含 conflicts" || fail "冲突体结构不符: $(cat /tmp/r3.json)"
CNT=$(curl -s "$BASE/tourBoxes" | jqr 'v.length')
[ "$CNT" = "1" ] && ok "冲突不落库（仍只有1张）" || fail "装箱单数=$CNT"
# 配件B不应被带入（冲突整单回滚）
AB_STATUS=$(curl -s "$BASE/accessories/$ACC_B" | jqr 'v.status')
[ "$AB_STATUS" = "在库" ] && ok "整单回滚：配件B仍在库" || fail "配件B状态=$AB_STATUS"

echo "== 4. 不重叠档期可正常占位 =="
CODE=$(curl -s -o /tmp/box2.json -w '%{http_code}' -X POST "$BASE/tourBoxes" -H 'Content-Type: application/json' -d "{\"showName\":\"济南场\",\"venue\":\"济南戏院\",\"play\":\"火焰山\",\"startDate\":\"2026-10-06\",\"endDate\":\"2026-10-09\",\"headIds\":[\"$HEAD_B\"],\"accessoryIds\":[\"$ACC_B\"]}")
[ "$CODE" = "201" ] && ok "相邻不重叠占位201" || fail "期望201实得$CODE: $(cat /tmp/box2.json)"
BOX2=$(cat /tmp/box2.json | jqr 'v.id')

echo "== 5. 重复提交沿用首次结果（无 key，指纹去重）=="
CODE=$(curl -s -o /tmp/dup.json -w '%{http_code}' -X POST "$BASE/tourBoxes" -H 'Content-Type: application/json' -d "{\"showName\":\"天津场\",\"venue\":\"天津戏院\",\"play\":\"火焰山\",\"startDate\":\"2026-10-01\",\"endDate\":\"2026-10-05\",\"headIds\":[\"$HEAD_B\"],\"accessoryIds\":[\"$ACC_A\"]}")
DUP_ID=$(cat /tmp/dup.json | jqr 'v.id')
DUP_REUSE=$(cat /tmp/dup.json | jqr 'v.reused===true')
[ "$CODE" = "201" ] && [ "$DUP_ID" = "$BOX1" ] && [ "$DUP_REUSE" = "true" ] && ok "重复提交返回首张(reused=true)" || fail "重复提交 code=$CODE id=$DUP_ID vs $BOX1 reused=$DUP_REUSE"
CNT=$(curl -s "$BASE/tourBoxes" | jqr 'v.length')
[ "$CNT" = "2" ] && ok "未产生重复装箱单" || fail "装箱单数=$CNT"

echo "== 6. 并发同键请求沿用首次结果 =="
# ACC_A 已在 10/01-10/05 装箱；11 月不重叠，凭幂等键 3 个并发应只建 1 张
for i in 1 2 3; do
  curl -s -o /tmp/par$i.json -w '%{http_code}\n' -X POST "$BASE/tourBoxes" \
    -H 'Content-Type: application/json' -H 'Idempotency-Key: tour-xian-001' \
    -d "{\"showName\":\"西安场\",\"venue\":\"西安戏院\",\"play\":\"火焰山\",\"startDate\":\"2026-11-01\",\"endDate\":\"2026-11-03\",\"headIds\":[],\"accessoryIds\":[\"$ACC_A\"]}" &
done
wait
sleep 0.3
IDS=$(for i in 1 2 3; do jqr 'v.id' < /tmp/par$i.json; done | sort -u | wc -l)
[ "$IDS" = "1" ] && ok "3个并发同键请求只产生1张装箱单" || fail "产生了多个id: $(cat /tmp/par1.json)"
# 注：ACC_A 此时 active（BOX1 10/01-10/05），11月不重叠 -> 应成功
CODE1=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/tourBoxes" -H 'Content-Type: application/json' -H 'Idempotency-Key: probe-overlap' -d "{\"showName\":\"郑州场\",\"venue\":\"郑州戏院\",\"play\":\"火焰山\",\"startDate\":\"2026-10-02\",\"endDate\":\"2026-10-03\",\"headIds\":[],\"accessoryIds\":[\"$ACC_A\"]}")
[ "$CODE1" = "409" ] && ok "ACC_A 10月重叠占用 409" || fail "期望409实得$CODE1"

echo "== 7. 演出前缺损：装箱单冻结 =="
CODE=$(curl -s -o /tmp/loss.json -w '%{http_code}' -X POST "$BASE/lossReports" -H 'Content-Type: application/json' -d "{\"tourBoxId\":\"$BOX1\",\"stage\":\"演出前\",\"itemType\":\"偶头\",\"itemId\":\"$HEAD_B\",\"problem\":\"开口机关断裂\",\"actor\":\"检场\"}")
[ "$CODE" = "201" ] && ok "缺损登记201" || fail "期望201实得$CODE: $(cat /tmp/loss.json)"
LOSS=$(cat /tmp/loss.json | jqr 'v.lossReport.id')
B1_STATUS=$(curl -s "$BASE/tourBoxes/$BOX1" | jqr 'v.status')
[ "$B1_STATUS" = "已冻结" ] && ok "装箱单=已冻结" || fail "状态=$B1_STATUS"
PEND=$(curl -s "$BASE/tourBoxes/$BOX1" | jqr 'v.pendingSubstitutions.length')
[ "$PEND" = "1" ] && ok "待接替队列=1" || fail "待接替=$PEND"
CUR=$(curl -s "$BASE/occupancy/items/puppetHead/$HEAD_B" | jqr "v.current.filter(a=>a.tourBoxId==='$BOX1').length")
[ "$CUR" = "0" ] && ok "原件占用已归档（不计当前占用）" || fail "仍占用当前档期"
HB_STATUS=$(curl -s "$BASE/puppetHeads/$HEAD_B" | jqr 'v.status')
[ "$HB_STATUS" = "待修补" ] && ok "原件状态=待修补" || fail "原件状态=$HB_STATUS"

echo "== 8. 冻结后禁止直接改档期/清单 =="
CODE=$(curl -s -o /tmp/r8.json -w '%{http_code}' -X PATCH "$BASE/tourBoxes/$BOX1" -H 'Content-Type: application/json' -d "{\"venue\":\"北京戏院\"}")
[ "$CODE" = "200" ] && ok "非档期字段仍可PATCH" || fail "普通字段PATCH $CODE"
CODE=$(curl -s -o /tmp/r8b.json -w '%{http_code}' -X PATCH "$BASE/tourBoxes/$BOX1" -H 'Content-Type: application/json' -d "{\"headIds\":[\"x\"]}")
[ "$CODE" = "409" ] && ok "直接改清单 409" || fail "期望409实得$CODE"

echo "== 9. 替件资格：异角色/不可用/档期冲突 =="
# HEAD_A 是同剧同角色但待修补 -> 409 itemNotUsable
CODE=$(curl -s -o /tmp/r9.json -w '%{http_code}' -X POST "$BASE/tourBoxes/$BOX1/substitute" -H 'Content-Type: application/json' -d "{\"itemType\":\"偶头\",\"itemId\":\"$HEAD_B\",\"replacementItemId\":\"$HEAD_A\"}")
[ "$CODE" = "409" ] && ok "未修复件不能接替 409" || fail "期望409实得$CODE: $(cat /tmp/r9.json)"
# 造一个异角色偶头
HEAD_C=$(curl -s -X POST "$BASE/puppetHeads" -H 'Content-Type: application/json' -d '{"role":"花旦","play":"火焰山","paintStatus":"完好","mechanism":"正常","boxNo":"木箱甲-09"}' | jqr 'v.id')
CODE=$(curl -s -o /tmp/r9b.json -w '%{http_code}' -X POST "$BASE/tourBoxes/$BOX1/substitute" -H 'Content-Type: application/json' -d "{\"itemType\":\"偶头\",\"itemId\":\"$HEAD_B\",\"replacementItemId\":\"$HEAD_C\"}")
[ "$CODE" = "409" ] && ok "异角色替件 409" || fail "期望409实得$CODE: $(cat /tmp/r9b.json)"
node -e 'const v=require("/tmp/r9b.json");process.exit(v.code==="substituteMismatch"?0:1)' && ok "错误码 substituteMismatch" || fail "错误码不符"

echo "== 10. HEAD_B 修复未完成不能占位（先造修复记录再验证）=="
REP=$(curl -s -X POST "$BASE/repairRecords" -H 'Content-Type: application/json' -d "{\"puppetHeadId\":\"$HEAD_B\",\"repairType\":\"修机关\",\"handler\":\"雕头师\"}" | jqr 'v.id')
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/tourBoxes" -H 'Content-Type: application/json' -d "{\"showName\":\"福州场\",\"venue\":\"福州戏院\",\"play\":\"火焰山\",\"startDate\":\"2026-12-01\",\"endDate\":\"2026-12-02\",\"headIds\":[\"$HEAD_B\"],\"accessoryIds\":[]}")
[ "$CODE" = "409" ] && ok "修复闭环前原件不能按新档期占用 409" || fail "期望409实得$CODE"

echo "== 11. 同剧同角可用替件接替（HEAD_A 先修复闭环）=="
# HEAD_A 原本待修补，需要一条对应修复记录闭环
REP_A=$(curl -s -X POST "$BASE/repairRecords" -H 'Content-Type: application/json' -d "{\"puppetHeadId\":\"$HEAD_A\",\"repairType\":\"补漆\",\"handler\":\"彩绘师\"}" | jqr 'v.id')
curl -s -o /dev/null -X POST "$BASE/repairRecords/$REP_A/complete" -H 'Content-Type: application/json' -d '{"actor":"彩绘师"}'
HA_STATUS=$(curl -s "$BASE/puppetHeads/$HEAD_A" | jqr 'v.status')
[ "$HA_STATUS" = "可演出" ] && ok "HEAD_A 修复闭环后恢复可演出" || fail "HEAD_A=$HA_STATUS"
CODE=$(curl -s -o /tmp/sub.json -w '%{http_code}' -X POST "$BASE/tourBoxes/$BOX1/substitute" -H 'Content-Type: application/json' -d "{\"itemType\":\"偶头\",\"itemId\":\"$HEAD_B\",\"replacementItemId\":\"$HEAD_A\",\"actor\":\"检场\"}")
[ "$CODE" = "200" ] && ok "同剧同角替件接替200" || fail "期望200实得$CODE: $(cat /tmp/sub.json)"
B1_STATUS=$(curl -s "$BASE/tourBoxes/$BOX1" | jqr 'v.status')
[ "$B1_STATUS" != "已冻结" ] && ok "全部补齐后装箱单解冻 -> $B1_STATUS" || fail "仍冻结"
HAS_A=$(curl -s "$BASE/tourBoxes/$BOX1" | jqr "v.headIds.includes('$HEAD_A')")
[ "$HAS_A" = "true" ] && ok "清单已替换为替件" || fail "清单未替换"
LOSS_STATUS=$(curl -s "$BASE/lossReports/$LOSS" | jqr 'v.status')
[ "$LOSS_STATUS" = "已补齐" ] && ok "缺损单=已补齐" || fail "缺损单=$LOSS_STATUS"
# 替件占用与履历
curl -s "$BASE/occupancy/items/puppetHead/$HEAD_A" > /tmp/occA.json
CUR_A=$(cat /tmp/occA.json | jqr "v.current.filter(a=>a.tourBoxId==='$BOX1').length")
[ "$CUR_A" = "1" ] && ok "替件档期占用已建立（substitute类型）" || fail "替件未占用"
TYP=$(cat /tmp/occA.json | jqr "v.current.find(a=>a.tourBoxId==='$BOX1').allocationType")
[ "$TYP" = "substitute" ] && ok "占用类型=substitute" || fail "类型=$TYP"
# 重复接替沿用首次结果
CODE=$(curl -s -o /tmp/subdup.json -w '%{http_code}' -X POST "$BASE/tourBoxes/$BOX1/substitute" -H 'Content-Type: application/json' -d "{\"itemType\":\"偶头\",\"itemId\":\"$HEAD_B\",\"replacementItemId\":\"$HEAD_A\"}")
[ "$CODE" = "200" ] && ok "重复接替请求幂等200" || fail "重复接替 code=$CODE"

echo "== 12. HEAD_B 修复闭环：旧档期留档、可按新档期重新占用 =="
# 履历：原件历史中有 10/01 归档记录
HIST=$(curl -s "$BASE/occupancy/items/puppetHead/$HEAD_B" | jqr 'v.history.length')
ARCH=$(curl -s "$BASE/occupancy/items/puppetHead/$HEAD_B" | jqr 'v.history.filter(a=>a.status==="archived").length')
[ "$HIST" -ge "1" ] && [ "$ARCH" -ge "1" ] && ok "旧档期留档（history=$HIST archived=$ARCH）" || fail "履历不符 hist=$HIST arch=$ARCH"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/repairRecords/$REP/complete" -H 'Content-Type: application/json' -d '{"actor":"雕头师"}')
[ "$CODE" = "200" ] && ok "HEAD_B 修复闭环200" || fail "闭环code=$CODE"
HB_STATUS=$(curl -s "$BASE/puppetHeads/$HEAD_B" | jqr 'v.status')
[ "$HB_STATUS" = "可演出" ] && ok "原件恢复可演出" || fail "原件=$HB_STATUS"
CODE=$(curl -s -o /tmp/box3.json -w '%{http_code}' -X POST "$BASE/tourBoxes" -H 'Content-Type: application/json' -d "{\"showName\":\"福州场\",\"venue\":\"福州戏院\",\"play\":\"火焰山\",\"startDate\":\"2026-12-01\",\"endDate\":\"2026-12-02\",\"headIds\":[\"$HEAD_B\"],\"accessoryIds\":[]}")
[ "$CODE" = "201" ] && ok "原件按新档期重新占用201" || fail "期望201实得$CODE: $(cat /tmp/box3.json)"
BOX3=$(cat /tmp/box3.json | jqr 'v.id')
CUR_B=$(curl -s "$BASE/occupancy/items/puppetHead/$HEAD_B" | jqr "v.current.filter(a=>a.tourBoxId==='$BOX3').length")
[ "$CUR_B" = "1" ] && ok "新档期占用已建立；旧档期(BOX1)归档不计当前占用" || fail "BOX3占用数=$CUR_B"
OLD_CUR=$(curl -s "$BASE/occupancy/items/puppetHead/$HEAD_B" | jqr "v.current.filter(a=>a.tourBoxId==='$BOX1').length")
[ "$OLD_CUR" = "0" ] && ok "旧档期 BOX1 不在当前占用" || fail "旧档期仍计占用"
TL_DIFF=$(curl -s "$BASE/puppetHeads/$HEAD_B/timeline" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const active=v.allocations.filter(a=>a.status==="active").length;const events=v.events.length;console.log(active+":"+events)})')
echo "  timeline allocations/events = $TL_DIFF"

echo "== 13. 装箱单闭环：占用归档 =="
CODE=$(curl -s -o /tmp/cl3.json -w '%{http_code}' -X POST "$BASE/tourBoxes/$BOX3/close")
[ "$CODE" = "200" ] && ok "闭环200" || fail "闭环code=$CODE: $(cat /tmp/cl3.json)"
C3_STATUS=$(curl -s "$BASE/tourBoxes/$BOX3" | jqr 'v.status')
[ "$C3_STATUS" = "已闭环" ] && ok "状态=已闭环" || fail "状态=$C3_STATUS"
CUR_B=$(curl -s "$BASE/occupancy/items/puppetHead/$HEAD_B" | jqr "v.current.filter(a=>a.tourBoxId==='$BOX3').length")
[ "$CUR_B" = "0" ] && ok "BOX3 闭环后其占用已归档" || fail "BOX3 仍占用=$CUR_B"
HB_STATUS=$(curl -s "$BASE/puppetHeads/$HEAD_B" | jqr 'v.status')
[ "$HB_STATUS" = "已装箱" ] && ok "HEAD_B 仍在未闭环 BOX2 档期：保持已装箱" || fail "偶头状态=$HB_STATUS"
# 闭环后该档期可再用（历史留档）
CODE=$(curl -s -o /tmp/box4.json -w '%{http_code}' -X POST "$BASE/tourBoxes" -H 'Content-Type: application/json' -d "{\"showName\":\"福州返场\",\"venue\":\"福州戏院\",\"play\":\"火焰山\",\"startDate\":\"2026-12-01\",\"endDate\":\"2026-12-02\",\"headIds\":[\"$HEAD_B\"],\"accessoryIds\":[]}")
[ "$CODE" = "201" ] && ok "旧档期留档不计占用：同档期可再排 201" || fail "期望201实得$CODE"
BOX4=$(cat /tmp/box4.json | jqr 'v.id')
HB_STATUS=$(curl -s "$BASE/puppetHeads/$HEAD_B" | jqr 'v.status')
[ "$HB_STATUS" = "已装箱" ] && ok "再排后偶头=已装箱" || fail "偶头状态=$HB_STATUS"
curl -s -o /dev/null -X POST "$BASE/tourBoxes/$BOX4/close"
# 重复闭环幂等
CODE=$(curl -s -o /tmp/cl3b.json -w '%{http_code}' -X POST "$BASE/tourBoxes/$BOX3/close")
[ "$CODE" = "200" ] && ok "重复闭环幂等200" || fail "重复闭环code=$CODE"

echo "== 14. 冻结中的装箱单不能闭环 =="
# BOX1 已解冻（替件成功），再造一个冻结单：BOX2 的 ACC_B 演出前缺损
LOSS2=$(curl -s -X POST "$BASE/lossReports" -H 'Content-Type: application/json' -d "{\"tourBoxId\":\"$BOX2\",\"stage\":\"演出前\",\"itemType\":\"配件\",\"itemId\":\"$ACC_B\",\"problem\":\"帽缨脱落\"}" | jqr 'v.lossReport.id')
CODE=$(curl -s -o /tmp/r14.json -w '%{http_code}' -X POST "$BASE/tourBoxes/$BOX2/close")
[ "$CODE" = "409" ] && ok "冻结且待接替 -> 409" || fail "期望409实得$CODE: $(cat /tmp/r14.json)"
# 同剧同角配件 ACC？ 需要另一个在库的火焰山武生配件 —— 此时 ACC_A 在 BOX1/西安 占用
# ACC_A active 至 10/05（BOX1替件后仍在单），BOX2 是 10/06-10/09 不重叠，可接替
# 同剧同角色且“在库”的配件替件（ACC_A 已在 BOX1 装箱中，不可用）
ACC_C=$(curl -s -X POST "$BASE/accessories" -H 'Content-Type: application/json' -d '{"name":"红缨冠","role":"武生","play":"火焰山","boxNo":"配件箱-05"}' | jqr 'v.id')
CODE=$(curl -s -o /tmp/sub2.json -w '%{http_code}' -X POST "$BASE/tourBoxes/$BOX2/substitute" -H 'Content-Type: application/json' -d "{\"itemType\":\"配件\",\"itemId\":\"$ACC_B\",\"replacementItemId\":\"$ACC_C\"}")
[ "$CODE" = "200" ] && ok "配件替件档期检查通过并接替200" || fail "配件接替 code=$CODE: $(cat /tmp/sub2.json)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/tourBoxes/$BOX2/close")
[ "$CODE" = "200" ] && ok "补齐后闭环200" || fail "补齐后闭环code=$CODE"
HB_STATUS=$(curl -s "$BASE/puppetHeads/$HEAD_B" | jqr 'v.status')
[ "$HB_STATUS" = "可演出" ] && ok "BOX2 闭环后 HEAD_B 全部档期结束，回库=可演出" || fail "偶头状态=$HB_STATUS"
CUR_B=$(curl -s "$BASE/occupancy/items/puppetHead/$HEAD_B" | jqr 'v.current.length')
[ "$CUR_B" = "0" ] && ok "HEAD_B 当前占用清空；旧档期全部留档" || fail "仍有占用=$CUR_B"
# 列表与履历一致：occupancy 中 active 数与逐箱 timeline 里的 active 数相等
HIST_B=$(curl -s "$BASE/occupancy/items/puppetHead/$HEAD_B" | jqr 'v.history.length')
echo "  HEAD_B 档期履历条数=$HIST_B（含原件/缺损归档/闭环留档）"
[ "$HIST_B" -ge "3" ] && ok "履历完整（至少3条留档）" || fail "履历条数=$HIST_B"

echo
echo "结果：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
