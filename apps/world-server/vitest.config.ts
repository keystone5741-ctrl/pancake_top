import { defineConfig } from "vitest/config";
// pool: forks — 시뮬레이션 worker 자식 프로세스 IPC 때문. --openssl-legacy-provider — s3rver 의 continuation token 이 legacy cipher 를 쓴다 (Node 22 / OpenSSL 3).
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 120000, hookTimeout: 120000, fileParallelism: false, pool: "forks", poolOptions: { forks: { execArgv: ["--openssl-legacy-provider"] } } } });
