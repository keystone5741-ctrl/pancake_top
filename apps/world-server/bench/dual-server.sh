#!/bin/bash
# Phase 3A §21~§24: 같은 PostgreSQL 을 쓰는 HTTP 서버 2개 (A: 8787, B: 8788) + 라운드로빈 부하 + leader 강제 종료 → failover.
#   bash bench/dual-server.sh [out.json]
set -u
OUT=${1:-../../docs/benchmarks/phase3a-dual-server.json}
S=${SCRATCH:-/tmp/pancake-dual}; mkdir -p $S
export DATABASE_URL=${DATABASE_URL:-postgres://pancake:pancake@127.0.0.1:5432/pancake_world}
export DROP_INTERVAL_SECONDS=120 DROP_CUTOFF_SECONDS=20 DATA_DIR=./data JOB_LEASE_MS=5000 LEADER_LEASE_MS=1000 LOG_LEVEL=warn
INSTANCE_ID=A PORT=8787 nohup pnpm exec tsx src/main.ts > $S/A.log 2>&1 & PA=$!
sleep 4
INSTANCE_ID=B PORT=8788 nohup pnpm exec tsx src/main.ts > $S/B.log 2>&1 & PB=$!
sleep 6
la=$(curl -s localhost:8787/api/dev/status | python3 -c "import json,sys; print(json.load(sys.stdin)['leader'])"); lb=$(curl -s localhost:8788/api/dev/status | python3 -c "import json,sys; print(json.load(sys.stdin)['leader'])")
echo "leader A=$la B=$lb"
echo "=== phase 1: round-robin load on A+B"
pnpm exec tsx bench/load.ts --urls http://localhost:8787,http://localhost:8788 --rates 10,50,100 --seconds 10 --burst 1 --drain 1 --out $S/load-1.json 2>&1 | grep -v '"level"' | tr '\r' '\n' | grep -v draining
echo "=== phase 2: kill the leader while purchases continue"
if [ "$la" = "True" ]; then LEADER=$PA; LPORT=8787; SURV=8788; else LEADER=$PB; LPORT=8788; SURV=8787; fi
# 부하를 걸면서 leader 를 죽인다 (survivor 만 때린다: 죽은 쪽 요청은 실패하는 게 정상)
( pnpm exec tsx bench/load.ts --urls http://localhost:$SURV --rates 50 --seconds 20 --burst 0 --drain 1 --out $S/load-2.json 2>&1 | grep -v '"level"' | tr '\r' '\n' | grep -v draining ) & LOADPID=$!
sleep 5; T0=$(date +%s%N); pkill -TERM -P $LEADER; kill -9 $LEADER 2>/dev/null; echo "killed leader on :$LPORT"
for i in $(seq 1 60); do l=$(curl -s localhost:$SURV/api/dev/status | python3 -c "import json,sys; print(json.load(sys.stdin)['leader'])" 2>/dev/null); if [ "$l" = "True" ]; then break; fi; sleep 0.25; done
T1=$(date +%s%N); echo "failover: survivor :$SURV leader=$l after $(( (T1-T0)/1000000 )) ms"
wait $LOADPID
echo "=== consistency (SQL)"
psql "$DATABASE_URL" -tA -c "select 'pancakes', count(*), count(distinct global_serial), max(global_serial), (select latest_global_serial from world_state) from pancakes" \
  -c "select 'country_dups', count(*) from (select country, country_serial from pancakes group by 1,2 having count(*)>1) d" \
  -c "select 'uncommitted', count(*) from pancakes where committed_at is null" \
  -c "select 'jobs_double_done', count(*) from (select start_serial from simulation_jobs where status='DONE' group by 1 having count(*)>1) d" \
  -c "select 'jobs', status, count(*) from simulation_jobs group by status" \
  -c "select 'leader_lease', instance_id, term from leader_lease" \
  -c "select 'leader_events', string_agg(payload->>'instanceId' || ':' || (payload->>'isLeader'), ',' order by event_id) from world_events where type='leader.changed'" | tee $S/consistency.txt
python3 - "$OUT" "$S" "$(( (T1-T0)/1000000 ))" <<'PY'
import json,sys
out,s,fo=sys.argv[1],sys.argv[2],int(sys.argv[3])
r={"failoverMs":fo,"load1":json.load(open(f"{s}/load-1.json")),"load2":json.load(open(f"{s}/load-2.json")),"consistency":open(f"{s}/consistency.txt").read()}
json.dump(r,open(out,"w"),indent=2); print("wrote",out)
PY
kill $PA $PB 2>/dev/null; pkill -TERM -P $PA 2>/dev/null; pkill -TERM -P $PB 2>/dev/null; sleep 1
