/**
 * Phase 0.75 실제 기기 테스트 러너.
 *
 *   /?suite=all&device=iPhone%2015           전체 계획 실행 (단계마다 완전 reload)
 *   /?suite=results                          결과 표 + JSON 내려받기/복사
 *   /?suite=reset                            저장된 결과 삭제
 *
 * 단계 상태는 localStorage 에 남기므로 브라우저가 죽어도 이어서 진행한다.
 * 어떤 단계가 'started' 상태로 남아 있으면 그 단계에서 브라우저가 죽은 것으로 기록(crashed)하고,
 * Scale 단계라면 더 큰 규모로 진행하지 않는다 (스펙 §5).
 * 각 단계 끝에 체감 등급(Good / Acceptable / Poor / Fail)을 묻는다 (`grade=auto` 면 생략 — headless 검증용).
 */
import type { AppApi } from "./main";

type Grade = "good" | "acceptable" | "poor" | "fail";
interface Step {
  suite: "basic" | "quality" | "find" | "fullview" | "drop" | "scale";
  id: string;
  query: string;
  status: "pending" | "started" | "done" | "aborted" | "crashed" | "skipped";
  result?: Record<string, unknown>;
  grade?: Grade;
  note?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}
interface Run { device: string; createdAt: string; steps: Step[]; userAgent: string }

const KEY = "pd.phase075";
const BASE = "towers/100000-natural.bin";

function plan(): Step[] {
  const S = (suite: Step["suite"], id: string, query: string): Step => ({ suite, id, query, status: "pending" });
  return [
    S("basic", "synthetic-100k-standard", "synthetic=100000&quality=standard"),
    S("quality", "synthetic-100k-performance", "synthetic=100000&quality=performance"),
    S("quality", "synthetic-100k-ultra", "synthetic=100000&quality=ultra"),
    S("find", "find-100k", `load=${BASE}&quality=standard`),
    S("fullview", "fullview-100k", `load=${BASE}&quality=standard&view=full`),
    S("drop", "drop-100", `load=${BASE}&drop=drops/100k-drop-100.bin&quality=standard`),
    S("drop", "drop-1000", `load=${BASE}&drop=drops/100k-drop-1000.bin&quality=standard`),
    S("drop", "drop-2000", `load=${BASE}&drop=drops/100k-drop-2000.bin&quality=standard`),
    S("drop", "drop-5000", `load=${BASE}&drop=drops/100k-drop-5000.bin&quality=standard`),
    S("scale", "synthetic-250k", "synthetic=250000&quality=standard"),
    S("scale", "synthetic-500k", "synthetic=500000&quality=standard"),
    S("scale", "synthetic-1m", "synthetic=1000000&quality=standard"),
  ];
}

function load(): Run | null { try { const s = localStorage.getItem(KEY); return s ? (JSON.parse(s) as Run) : null; } catch { return null; } }
function save(run: Run): void { try { localStorage.setItem(KEY, JSON.stringify(run)); } catch { /* ignore */ } }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const $ = (id: string): HTMLElement => document.getElementById(id)!;

function banner(text: string): void { const b = $("banner"); b.textContent = text; b.style.display = text ? "block" : "none"; }

function askGrade(title: string): Promise<{ grade: Grade; note: string }> {
  return new Promise((resolve) => {
    const box = $("grade");
    $("gradeTitle").textContent = title;
    box.style.display = "block";
    const note = $("gradeNote") as HTMLInputElement;
    note.value = "";
    for (const g of ["good", "acceptable", "poor", "fail"] as Grade[]) {
      const btn = $(`grade-${g}`);
      btn.onclick = () => { box.style.display = "none"; resolve({ grade: g, note: note.value }); };
    }
  });
}

/** 카메라 조작 체감을 위해 잠시 기다리며 프레임을 잰다 */
async function measure(api: AppApi, ms: number, label: string): Promise<Record<string, unknown>> {
  api.resetSamples();
  banner(`${label} — 측정 중 ${Math.round(ms / 1000)}초. 화면을 회전/확대해 보세요.`);
  await sleep(ms);
  const r = api.result();
  banner("");
  return r;
}

async function runStep(api: AppApi, step: Step, auto: boolean): Promise<void> {
  const q = new URLSearchParams(step.query);
  const quality = q.get("quality") ?? "standard";
  (document.getElementById("quality") as HTMLSelectElement).value = quality;
  const settle = auto ? 4000 : 8000;

  if (q.get("synthetic")) {
    api.syntheticTower(Number(q.get("synthetic")));
    api.setView("peak");
    step.result = await measure(api, settle, `${step.id}: ${Number(q.get("synthetic")).toLocaleString()} instances`);
    return;
  }
  await api.loadTower(q.get("load")!);
  if (step.suite === "find") {
    const finds: Record<string, unknown>[] = [];
    for (const id of [1, 54321, 99999]) {
      const ok = api.findPancake(id);
      const t0 = performance.now();
      while (api.flying() && performance.now() - t0 < 15000) await sleep(50);
      const flyTimedOut = api.flying();
      api.resetSamples();
      banner(`Find #${id.toLocaleString()} — 근접 화면. 확대/회전해 보고 겹침이 보이는지 확인하세요. (${auto ? 3 : 8}초)`);
      await sleep(auto ? 3000 : 8000);
      const r = api.result();
      finds.push({ ...(api.lastFind() ?? {}), found: ok, flyMs: flyTimedOut ? null : api.lastFlyMs(), flyTimedOut, fpsDuringZoom: r.fps, frameMsP95: r.frameMsP95 });
      if (!auto && id === 54321) { banner("지금 #54321 근접 화면을 스크린샷으로 남기세요 (5초)"); await sleep(5000); }
    }
    banner("");
    step.result = { ...api.result(), finds };
    return;
  }
  if (step.suite === "fullview") {
    api.setView("full");
    await sleep(500);
    const r = await measure(api, settle, "전체 탑 뷰 — 탑이 보이는지, 깜빡임이 있는지 확인하고 스크린샷을 남기세요");
    step.result = { ...r, towerWidthPx: api.towerWidthPx(), towerHeightPx: innerHeight * devicePixelRatio, background: "#0d0f14", pancakeColor: "#d9a15c" };
    return;
  }
  if (step.suite === "drop") {
    const n = await api.loadDrop(q.get("drop")!);
    api.setView("peak");
    await sleep(500);
    api.resetSamples();
    banner(`Drop ${n.toLocaleString()} — 낙하 연출 측정 중`);
    api.startReplay(n);
    const t0 = performance.now();
    while (api.replaying() && performance.now() - t0 < 60000) await sleep(50);
    const during = api.result();
    await sleep(1000);
    banner("");
    step.result = { ...during, dropCount: n, replay: api.replayReport(), animationWallMs: performance.now() - t0 };
    return;
  }
  step.result = await measure(api, settle, step.id);
}

export async function runSuite(api: AppApi): Promise<void> {
  const mode = api.params.get("suite")!;
  const auto = api.params.get("grade") === "auto";
  if (mode === "reset") { try { localStorage.removeItem(KEY); } catch { /* ignore */ } location.replace("/?suite=results"); return; }
  let run = load();
  if (mode === "results") { showResults(run); return; }

  // 새 실행 시작
  if (!run || api.params.get("fresh") === "1") {
    let device = api.params.get("device") ?? "";
    if (!device && !auto) device = prompt("기기 이름 (예: iPhone 15 / Galaxy A54 / Desktop RTX 3060)") ?? "";
    try { localStorage.setItem("pd.device", device); } catch { /* ignore */ }
    run = { device, createdAt: new Date().toISOString(), steps: plan(), userAgent: navigator.userAgent };
    save(run);
  }

  // 직전에 'started' 로 남은 단계 = 브라우저가 죽었거나 새로고침됨
  const stuck = run.steps.find((s) => s.status === "started");
  if (stuck) {
    stuck.status = "crashed";
    stuck.finishedAt = new Date().toISOString();
    stuck.error = "page reloaded or browser killed before the step finished";
    if (stuck.suite === "scale") for (const s of run.steps) if (s.suite === "scale" && s.status === "pending") s.status = "skipped";
    save(run);
  }
  const next = run.steps.find((s) => s.status === "pending");
  if (!next) { location.replace("/?suite=results"); return; }
  // Scale: 이전 규모가 aborted/crashed 면 더 키우지 않는다
  if (next.suite === "scale") {
    const prevScale = run.steps.filter((s) => s.suite === "scale" && s.status !== "pending" && s.status !== "skipped").pop();
    const basic = run.steps.find((s) => s.suite === "basic");
    const blocked = (prevScale && prevScale.status !== "done") || (basic && basic.status !== "done") || (prevScale?.grade === "fail");
    if (blocked) { for (const s of run.steps) if (s.suite === "scale" && s.status === "pending") s.status = "skipped"; save(run); location.replace("/?suite=results"); return; }
  }

  next.status = "started";
  next.startedAt = new Date().toISOString();
  save(run);
  try {
    await runStep(api, next, auto);
    next.status = api.aborted() ? "aborted" : "done";
  } catch (e) {
    next.status = "aborted";
    next.error = String(e);
  }
  if (!auto) {
    const g = await askGrade(`${next.id} — 체감은 어땠나요?`);
    next.grade = g.grade; next.note = g.note;
  } else next.grade = next.status === "done" ? "good" : "fail";
  next.finishedAt = new Date().toISOString();
  save(run);
  // 다음 단계로 완전 reload (스펙 §5)
  const more = run.steps.some((s) => s.status === "pending");
  const extra = auto ? "&grade=auto" : "";
  location.replace(more ? `/?suite=all${extra}` : "/?suite=results");
}

function showResults(run: Run | null): void {
  const box = $("results");
  box.style.display = "block";
  if (!run) { box.innerHTML = `<h2>PHASE 0.75</h2><p>저장된 결과가 없습니다. <a href="/?suite=all">테스트 시작</a></p>`; return; }
  const rows = run.steps.map((s) => {
    const r = s.result ?? {};
    const f = (v: unknown, d = 1): string => typeof v === "number" ? v.toFixed(d) : "—";
    return `<tr><td>${s.suite}</td><td>${s.id}</td><td class="st-${s.status}">${s.status}</td><td>${f(r.fps)}</td><td>${f(r.frameMsP95)}</td><td>${f(r.frameMsP99)}</td><td>${f(r.minFps)}</td><td>${r.freezeEvents ?? "—"}</td><td>${r.drawCalls ?? "—"}</td><td>${typeof r.jsHeapMB === "number" ? f(r.jsHeapMB, 0) : "n/a"}</td><td>${s.grade ?? "—"}</td><td>${s.note ?? ""}</td></tr>`;
  }).join("");
  const json = JSON.stringify({ ...run, exportedAt: new Date().toISOString(), summary: api_summary(run) }, null, 2);
  box.innerHTML = `<h2>PHASE 0.75 — ${run.device || "(기기명 없음)"}</h2>
    <table><thead><tr><th>suite</th><th>step</th><th>status</th><th>fps</th><th>p95 ms</th><th>p99 ms</th><th>min fps</th><th>freeze</th><th>draw</th><th>heap MB</th><th>grade</th><th>note</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="buttons"><button id="dl">DOWNLOAD JSON</button><button id="cp" class="secondary">COPY JSON</button><a class="secondary btn" href="/?suite=all&fresh=1">RESTART</a><a class="secondary btn" href="/?suite=reset">CLEAR</a></div>
    <p class="hint">JSON 을 docs/benchmarks/raw/phase0.75-&lt;device&gt;.json 으로 저장해 주세요.</p>
    <textarea id="jsonBox" readonly>${json.replace(/</g, "&lt;")}</textarea>`;
  $("dl").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([json], { type: "application/json" })); a.download = `phase0.75-${(run.device || "device").replace(/[^\w-]+/g, "_")}.json`; a.click(); };
  $("cp").onclick = () => { navigator.clipboard?.writeText(json); };
  (window as unknown as { __RUN?: unknown }).__RUN = { ...run, summary: api_summary(run) };
  window.__READY = true;
}

function api_summary(run: Run): Record<string, unknown> {
  const done = (suite: Step["suite"]): Step[] => run.steps.filter((s) => s.suite === suite && s.status === "done");
  const scaleDone = done("scale");
  const basic = run.steps.find((s) => s.suite === "basic");
  const maxUsable = [basic?.status === "done" ? 100000 : 0, ...scaleDone.map((s) => Number((new URLSearchParams(s.query)).get("synthetic")))].reduce((a, b) => Math.max(a, b), 0);
  return {
    basic100kOk: basic?.status === "done" && basic.grade !== "fail",
    maxUsableInstances: maxUsable,
    crashed: run.steps.filter((s) => s.status === "crashed").map((s) => s.id),
    findOk: done("find").every((s) => ((s.result?.finds as Record<string, unknown>[]) ?? []).every((f) => f.found && f.correct)),
    dropConverged: done("drop").every((s) => (s.result?.replay as Record<string, unknown> | undefined)?.converged === true),
  };
}
