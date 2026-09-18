/**
 * 구매 부하 테스트 (Phase 2 §43, §44). 실행 중인 world-server 에 HTTP 로 때린다.
 *   pnpm --filter world-server bench:load -- [--url http://localhost:8787] [--rates 1,10,50,100] [--seconds 10] [--burst 1] [--drain 1] [--out ../../docs/benchmarks/phase2-load.json]
 * 검증: 응답 serial 범위가 서로 겹치지 않고(중복 0), 합계가 서버 latest_global_serial 증가분과 같다(유실 0).
 * burst: cutoff 직전·직후 2초 동안 몰아서 보내고 각 주문이 현재 Drop 또는 다음 Drop 에만 배정됐는지 확인한다.
 *   (짧게 돌리려면 서버를 DROP_INTERVAL_SECONDS=60 DROP_CUTOFF_SECONDS=10 으로 띄운다)
 */
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const urls = opt("--urls", opt("--url", "http://localhost:8787")).split(","); // 여러 서버 인스턴스에 라운드로빈 (Phase 3A §24)
let rr = 0; const nextUrl = (): string => urls[rr++ % urls.length];
const url = urls[0];
const rates = opt("--rates", "1,10,50,100").split(",").map(Number);
const seconds = Number(opt("--seconds", "10"));
const doBurst = opt("--burst", "1") === "1";
const doDrain = opt("--drain", "1") === "1";
const out = opt("--out", "");
const COUNTRIES = ["KR", "JP", "US", "BR", "ID", "ZZ"]; // Phase 3A §32

interface Purchase { orderId: string; dropId: string; startSerial: number; endSerial: number; replayed: boolean; scheduledAt: string }
interface Sample { ms: number; ok: boolean; status: number; qty: number; res?: Purchase; err?: string; sentAt: number }
const per = (a: number[], p: number): number => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
const status = async (): Promise<Record<string, any>> => (await fetch(`${url}/api/dev/status`)).json() as Promise<Record<string, any>>;

async function purchase(qty: number, key?: string): Promise<Sample> {
  const t0 = performance.now(); const sentAt = Date.now();
  try {
    const r = await fetch(`${nextUrl()}/api/dev/purchase`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quantity: qty, country: COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)], idempotencyKey: key }) });
    const body = (await r.json()) as Purchase & { error?: string };
    return { ms: performance.now() - t0, ok: r.status === 201 || r.status === 200, status: r.status, qty, res: r.ok ? body : undefined, err: body.error, sentAt };
  } catch (e) { return { ms: performance.now() - t0, ok: false, status: 0, qty, err: String(e), sentAt }; }
}

/** rate req/s 로 seconds 동안 보낸다 (open-loop: 응답을 기다리지 않고 일정 간격 발사) */
async function runRate(rate: number): Promise<{ rate: number; sent: number; ok: number; errors: number; p50: number; p95: number; max: number; achievedRps: number; samples: Sample[] }> {
  const samples: Sample[] = []; const inflight: Promise<void>[] = [];
  const interval = 1000 / rate; const total = rate * seconds; const t0 = performance.now();
  for (let i = 0; i < total; i++) {
    const due = t0 + i * interval; const now = performance.now();
    if (due > now) await new Promise((r) => setTimeout(r, due - now));
    inflight.push(purchase(1 + Math.floor(Math.random() * 10)).then((s) => { samples.push(s); }));
  }
  await Promise.all(inflight);
  const wall = (performance.now() - t0) / 1000;
  const lat = samples.filter((s) => s.ok).map((s) => s.ms);
  return { rate, sent: samples.length, ok: samples.filter((s) => s.ok).length, errors: samples.filter((s) => !s.ok).length, p50: per(lat, 0.5), p95: per(lat, 0.95), max: per(lat, 1), achievedRps: samples.length / wall, samples };
}

function verifySerials(samples: Sample[]): { duplicates: number; gaps: number; allocated: number; serialMin: number; serialMax: number } {
  const ranges = samples.filter((s) => s.res).map((s) => s.res!).sort((a, b) => a.startSerial - b.startSerial);
  let duplicates = 0, gaps = 0, allocated = 0, prevEnd = ranges.length ? ranges[0].startSerial - 1 : 0;
  for (const r of ranges) {
    if (r.startSerial <= prevEnd) duplicates += prevEnd - r.startSerial + 1;
    else if (r.startSerial !== prevEnd + 1) gaps += r.startSerial - prevEnd - 1;
    allocated += r.endSerial - r.startSerial + 1; prevEnd = Math.max(prevEnd, r.endSerial);
  }
  return { duplicates, gaps, allocated, serialMin: ranges[0]?.startSerial ?? 0, serialMax: prevEnd };
}

const report: Record<string, unknown> = { urls, seconds, startedAt: new Date().toISOString() };
const before = await status();
console.log(`server: allocated ${(before.live ?? before.world).latest_global_serial}, committed ${before.world.committed_serial}, drop ${before.currentDrop.drop_id} (${before.currentDrop.status}) cutoff ${before.currentDrop.cutoff_at}`);
const all: Sample[] = [];
const rateResults = [];
for (const rate of rates) {
  const r = await runRate(rate);
  all.push(...r.samples);
  const v = verifySerials(r.samples);
  const { samples: _s, ...rest } = r;
  rateResults.push({ ...rest, ...v });
  console.log(`rate ${String(rate).padStart(3)} req/s: sent ${r.sent} ok ${r.ok} err ${r.errors} | latency p50 ${r.p50.toFixed(1)} ms p95 ${r.p95.toFixed(1)} ms max ${r.max.toFixed(1)} ms | achieved ${r.achievedRps.toFixed(1)} rps | serials ${v.allocated} dup ${v.duplicates} gap ${v.gaps}`);
  const st = await status();
  console.log(`      server: purchase ${st.metrics.purchaseEventsPerSec.toFixed(1)}/s pending ${st.pending} sim ${st.metrics.simulationThroughputPerSec.toFixed(1)}/s job p50 ${st.metrics.simulationJobP50Ms.toFixed(0)} ms`);
}
report.rates = rateResults;

// idempotency: 같은 키 두 번 → 같은 범위, 두 번째는 replayed
const key = `bench-${Date.now()}`;
const a = await purchase(3, key), b = await purchase(3, key);
report.idempotency = { same: a.res?.orderId === b.res?.orderId && a.res?.startSerial === b.res?.startSerial, replayed: b.res?.replayed, statusA: a.status, statusB: b.status };
console.log(`idempotency: same order ${report.idempotency && (report.idempotency as any).same} replayed ${b.res?.replayed} (${a.status}/${b.status})`);
all.push(a);

// 전체 검증: 이 클라이언트가 받은 serial 들끼리 중복 0, 서버 카운터 증가분 = 할당 합계 (다른 클라이언트가 없다면 gap 도 0)
const after = await status();
const v = verifySerials(all);
const delta = (after.live ?? after.world).latest_global_serial - (before.live ?? before.world).latest_global_serial;
report.total = { ...v, serverDelta: delta, lost: delta - v.allocated };
console.log(`total: allocated ${v.allocated} (server +${delta}) duplicates ${v.duplicates} gaps ${v.gaps} lost ${delta - v.allocated}`);

if (doBurst) {
  // cutoff 근처 burst: 현재 drop 의 cutoff 를 기다렸다가 -2s ~ +2s 동안 최대한 보낸다
  const cur = (await status()).currentDrop as { drop_id: string; cutoff_at: string; status: string };
  const cutoff = new Date(cur.cutoff_at).getTime();
  const wait = cutoff - 2000 - Date.now();
  console.log(`burst: waiting ${(wait / 1000).toFixed(0)} s for cutoff of ${cur.drop_id} (${cur.cutoff_at})`);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const samples: Sample[] = []; const inflight: Promise<void>[] = [];
  const until = cutoff + 2000; let n = 0;
  while (Date.now() < until) { inflight.push(purchase(1 + (n++ % 10)).then((s) => { samples.push(s); })); await new Promise((r) => setTimeout(r, 5)); }
  await Promise.all(inflight);
  const drops = new Map<string, number>();
  for (const s of samples) if (s.res) drops.set(s.res.dropId, (drops.get(s.res.dropId) ?? 0) + 1);
  const late = samples.filter((s) => s.res && s.res.dropId === cur.drop_id && s.sentAt > cutoff + 1500).length; // 서버 tick 은 1초 주기 → 1.5초 여유
  const bv = verifySerials(samples);
  const st = await status();
  const closed = (await (await fetch(`${url}/api/drops/${cur.drop_id}`)).json()) as { status: string; pancake_count: number };
  report.burst = { dropId: cur.drop_id, sent: samples.length, ok: samples.filter((s) => s.ok).length, errors: samples.filter((s) => !s.ok).length, perDrop: Object.fromEntries(drops), lateIntoClosedDrop: late, p95: per(samples.map((s) => s.ms), 0.95), ...bv, closedDropStatus: closed.status, closedDropCount: closed.pancake_count, nextDrop: st.currentDrop.drop_id };
  console.log(`burst: sent ${samples.length} ok ${report.burst && (report.burst as any).ok} → drops ${JSON.stringify(Object.fromEntries(drops))}; late-into-closed ${late}; dup ${bv.duplicates} gap ${bv.gaps}; ${cur.drop_id} now ${closed.status} (${closed.pancake_count} pancakes), current ${st.currentDrop.drop_id}`);
  all.push(...samples);
}

if (doDrain) {
  const t0 = Date.now();
  let st = await status();
  while (st.pending > 0 && Date.now() - t0 < 30 * 60_000) { await new Promise((r) => setTimeout(r, 1000)); st = await status(); process.stdout.write(`  draining: pending ${st.pending} sim ${st.metrics.simulationThroughputPerSec.toFixed(1)}/s   \r`); }
  console.log();
  const m = st.metrics;
  report.drain = { seconds: (Date.now() - t0) / 1000, pending: st.pending, committed: st.world.committed_serial, allocated: st.world.latest_global_serial, jobP50Ms: m.simulationJobP50Ms, jobP95Ms: m.simulationJobP95Ms, commitMsAvg: m.commitMsAvg, chunkWriteMsAvg: m.chunkWriteMsAvg, workerCrashes: m.workerCrashes, jobRetries: m.jobRetries };
  console.log(`drain: ${((Date.now() - t0) / 1000).toFixed(0)} s, committed ${st.world.committed_serial}/${st.world.latest_global_serial}, job p50 ${m.simulationJobP50Ms.toFixed(0)} ms p95 ${m.simulationJobP95Ms.toFixed(0)} ms, commit avg ${m.commitMsAvg.toFixed(1)} ms, crashes ${m.workerCrashes} retries ${m.jobRetries}`);
  // DB 정합성: pancakes 행 수 = latest_global_serial, committed 행 수 = committed_serial
  const fin = await status();
  const l = fin.live ?? fin.world;
  report.consistency = { allocated: l.latest_global_serial, committed: l.committed_serial, allCommitted: l.latest_global_serial === l.committed_serial, jobs: fin.jobs, leader: fin.instanceId };
  console.log(`consistency: allocated ${l.latest_global_serial} committed ${l.committed_serial} jobs ${JSON.stringify(fin.jobs)}`);
  // 여러 인스턴스: 각 인스턴스가 보는 leader / 상태
  if (urls.length > 1) { const per = []; for (const u of urls) { const s = (await (await fetch(`${u}/api/dev/status`)).json()) as any; per.push({ url: u, instanceId: s.instanceId, leader: s.leader, committed: s.live?.committed_serial }); } report.instances = per; console.log(`instances: ${JSON.stringify(per)}`); }
}
if (out) { writeFileSync(out, JSON.stringify(report, null, 2)); console.log(`wrote ${out}`); }
