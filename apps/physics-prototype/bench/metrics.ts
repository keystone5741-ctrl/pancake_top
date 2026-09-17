/**
 * 덤프된 서버 결과(.bin)에서 Stacking 계측을 다시 계산한다. 시뮬레이션 없이 계측 정의만 바꿔 재평가할 때.
 *   tsx bench/metrics.ts public/towers/10k-natural.bin [...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decodeTower, computeStackingMetrics, formatMetrics } from "../src/sim";
const out: Record<string, unknown> = {};
for (const f of process.argv.slice(2)) {
  const buf = readFileSync(f);
  const d = decodeTower(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const m = computeStackingMetrics(d);
  out[f] = m;
  console.log(`=== ${f} (${d.count})\n` + formatMetrics(m));
}
if (process.env.METRICS_JSON) writeFileSync(process.env.METRICS_JSON, JSON.stringify(out, null, 2));
