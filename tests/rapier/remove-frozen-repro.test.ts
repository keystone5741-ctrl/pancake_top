import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "remove-frozen-repro.ts");
const tsx = join(here, "node_modules", ".bin", "tsx");
const rapierVersion = (): string => (JSON.parse(readFileSync(join(here, "node_modules", "@dimforge", "rapier3d-compat", "package.json"), "utf8")) as { version: string }).version;
const run = (args: string[]): { code: number; out: string } => { const r = spawnSync(tsx, [script, ...args], { cwd: here, encoding: "utf8", timeout: 5 * 60_000 }); return { code: r.status ?? -1, out: (r.stdout + r.stderr).trim() }; };

/**
 * Rapier 0.20 removeRigidBody 패닉 재현 (Phase 2 §53). 패닉이 사라지면(엔진 업그레이드 등) 첫 테스트가 실패해
 * TowerSim 의 freezeMode:"rebuild" 우회를 다시 검토하라는 신호가 된다. 문서: docs/phase2/RAPIER_020_PANIC.md
 */
describe(`rapier ${rapierVersion()} removeRigidBody panic`, () => {
  it("pure rapier: removing fixed bodies that were dynamic and in contact panics (unreachable)", () => {
    const r = run(["--mode", "pure", "--batch", "20", "--seed", "1", "--count", "200"]);
    expect(r.out).toMatch(/WASM PANIC: unreachable/);
    expect(r.code).toBe(2);
  });
  it("control: same scene without removeRigidBody completes", () => {
    const r = run(["--mode", "pure", "--batch", "20", "--seed", "1", "--count", "200", "--remove", "0"]);
    expect(r.out).toMatch(/pure\[[^\]]*\]: ok/);
    expect(r.code).toBe(0);
  });
  it("TowerSim freezeMode:\"rebuild\" (production) completes the same pattern", () => {
    const r = run(["--mode", "rebuild", "--batch", "20", "--seed", "1", "--count", "300"]);
    expect(r.out).toMatch(/rebuild: ok/);
    expect(r.code).toBe(0);
  });
});
