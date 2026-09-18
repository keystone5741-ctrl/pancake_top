# Phase 3A — Object Storage

Phase 3A §8~§13. 코드: `apps/world-server/src/world/chunkStorage.ts`, `worldStore.ts`.

## 인터페이스 (§8)

```ts
interface ChunkStorage {
  put(key, data, { sha256?, contentType? })
  get(key) → bytes | null
  exists(key) / head(key) → { size, etag, sha256, lastModified } | null
  delete(key)                       // 없으면 no-op
  list(prefix) → keys[]             // 정렬, 페이지 자동 처리
  copy(from, to)                    // 승격용 (S3 CopyObject / 로컬 복사)
}
```

구현: `LocalChunkStorage`(파일, tmp+rename, `.sha256` sidecar), `ObjectChunkStorage`(S3 호환), `MemoryChunkStorage`(테스트). 선택은 `createChunkStorage(cfg)` 가 환경변수로 한다 — core 코드는 vendor 를 모른다.

## S3 호환 (§9)

`ObjectChunkStorage` 는 SDK 없이 `fetch` + AWS Signature V4 로 S3 REST API 를 직접 부른다: PutObject(`x-amz-meta-sha256`), GetObject, HeadObject, DeleteObject, ListObjectsV2(prefix, continuation token), CopyObject(`x-amz-copy-source`). path-style(`endpoint/bucket/key`) 기본, virtual-host 도 설정으로. 5xx/네트워크 오류는 지수 backoff 로 재시도(기본 3회), 4xx 는 즉시 `ObjectStorageError`.

| env | 뜻 |
| --- | --- |
| `STORAGE_KIND` | `local` (기본) / `object` |
| `S3_ENDPOINT` | `https://s3.ap-northeast-2.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, `http://127.0.0.1:9000` … |
| `S3_BUCKET`, `S3_REGION`(R2 는 `auto`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | 자격 |
| `S3_PREFIX` | 모든 키 앞에 붙는 접두사 (예 `prod/`) |
| `S3_FORCE_PATH_STYLE` | 1(기본) / 0 |

테스트는 `s3rver`(로컬 S3 mock) 로 돈다 — `tests/storage.test.ts`. Node 22 에서 s3rver 의 continuation token 이 legacy cipher 를 써서 vitest forks 에 `--openssl-legacy-provider` 를 준다. 실제 AWS S3 / R2 에 대한 통합 테스트는 자격이 필요하므로 이 저장소에는 없다(§9: provider 미고정).

## 키 (§10)

```text
worlds/<world>/chunks/000123-v45.chunk    immutable — finalized chunk. 버전이 키에 있으므로 덮어쓰지 않는다 (CDN immutable 캐시 가능)
worlds/<world>/staging/000124-v46.chunk   mutable 현재 chunk 의 버전 v46 시점 내용
```

커밋마다 영향받은 chunk 를 `staging/<id>-v<newVersion>` 에 쓴다. DB 트랜잭션이 성공하면 finalized 된 chunk 는 `chunks/<id>-v<newVersion>` 으로 **승격**(copy → DB `storage_key` 갱신 → staging 삭제)하고, 이전 버전의 staging 객체는 삭제한다. 승격이 실패해도 DB 는 유효한 staging 키를 가리키므로 서비스는 계속되고, 다음 startup reconcile 이 마저 승격한다.

## 커밋 순서와 DB 권위 (§11)

```text
physics → binary build(worker thread) → sha256 → staging upload → HEAD verify → DB transaction (version+1) → promote → realtime event
```

- **verify**: HEAD 의 size = 바이트 길이, `x-amz-meta-sha256` = checksum(있으면), 단일 PUT 의 ETag = MD5(있으면). 하나라도 다르면 `CORRUPTED_CHUNK`, 업로드/HEAD 오류는 `STORAGE_FAILED`. 이 경우 DB 트랜잭션은 시작하지 않으므로 world version 이 먼저 오르는 일은 없다.
- DB 트랜잭션이 실패하면(`DB_COMMIT_FAILED`) 저장소에 남은 staging 객체는 어떤 chunk 행도 참조하지 않는다 → startup reconcile 이 지운다.
- `chunks.data`(BYTEA) 가 계속 authoritative 다. `GET /api/world/chunks/:id` 는 DB 에서 서빙한다. 저장소 객체는 CDN/직접 다운로드용 사본이며 manifest 의 `storageKey` 로 알 수 있다.

## Reconcile (startup)

`WorldStore.load()` → 모든 chunk 행에 대해 `head(storage_key)`: 없거나 size/sha 불일치 → DB bytes 로 다시 put; finalized 인데 staging 키 → 승격; 마지막에 `list(worlds/<world>/)` 로 참조되지 않는 객체 삭제. 1M(100 chunk) 은 HEAD 100번, 10M(1,000 chunk) 은 1,000번 — 시간은 벤치마크 문서.

## Content addressing (§12)

manifest 의 chunk 항목: `{ id, sha256, size, storageKey, finalized, url, … }` (`checksum`/`byteLength` 는 호환용 별칭). 클라이언트(`UrlChunkSource`)는 받은 bytes 의 sha256 을 manifest 와 비교하고, url 의 `?c=<sha256 앞 16자>` 로 immutable 캐시 키를 만든다. 저장소 키에는 world version 이, HTTP 캐시 키에는 내용 해시가 들어간다.

## 압축 (§13)

`bench/compression.ts`: raw / gzip(6, 9) / brotli(4, 9) 를 100k·500k·1M chunk 세트에 적용해 크기·압축 CPU·해제 CPU 를 잰다. transform 은 float32 (위치·쿼터니언·스케일) 라 엔트로피가 높다. 결과와 결정은 벤치마크 문서 §4. 결정 전까지 `.chunk` 는 raw 로 저장·서빙한다(HTTP 압축은 프록시/CDN 설정으로 켤 수 있지만 float 데이터에는 이득이 작다).
