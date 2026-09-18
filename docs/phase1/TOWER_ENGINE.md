# Tower Engine

`packages/tower-engine`. 렌더러·물리에 의존하지 않는다.

## Chunk (Phase 1 §3)

```ts
interface TowerChunk {
  id: ChunkId; startSerial: number; endSerial: number /* 포함 */; count: number;
  bounds: Bounds3; minHeight: number; maxHeight: number;
  transforms: Float32Array;     // stride 9: px py pz qx qy qz qw scale tscale
  attributes: { variant: Uint16Array; country: Uint16Array };
}
```

- `chunkSize` 는 `TowerConfig` 값이다 (기본 10,000, 상수 아님). Phase 0.75 기준 draw call 수 = chunk 수(LOD 별 최대 3).
- `maxHeight` 는 기울어진 원기둥의 정확한 최고점(`r·sin(tilt) + h·cos(tilt)`)이므로 탑 높이의 source of truth 로 쓴다. XZ bounds 는 보수적.
- `ChunkHeader` 는 transform 없이 알 수 있는 요약이다. 서버는 manifest 로 모든 header 를 먼저 주고 chunk 본문은 나중에 준다.

## Index / Lookup (Phase 1 §4)

`Tower.findPancake(id)`: `chunk = ⌊id / chunkSize⌋`, `instance = id − chunk.startSerial`, transform 은 배열 오프셋 읽기. O(1). chunk 가 CPU 에 없으면 `findPancakeAsync` 가 소스에서 로드한 뒤 반환한다. 반환 = `{ pancakeId, chunkId, instanceIndex, transform, worldPosition, metadata }`.

## Streaming 상태 (Phase 1 §5)

| 상태 | 의미 | 전환 기준 (`decideChunkStates`) |
| --- | --- | --- |
| UNLOADED | transform 없음 | 절두체 밖이고 `keepGpuDistance × prefetchDistanceFactor` 보다 멀다 |
| CPU_READY | transform 있음, GPU 없음 | 절두체 밖, prefetch 거리 안 |
| GPU_LOW | far LOD 만 | 절두체 안이지만 투영 직경 < `highLodMinPx`, 또는 절두체 밖이지만 `keepGpuDistance` 안 |
| GPU_HIGH | 모든 LOD | 절두체 안이고 투영 직경 ≥ `highLodMinPx` |

기준은 world 거리가 아니라 **투영 직경(px)** 이다 (`projectedDiameterPx`). 값은 `StreamingPolicy` 설정. 현재 소스는 메모리(`MemoryChunkSource`)와 URL(`UrlChunkSource`, manifest + `.chunk`) 두 가지이며 같은 `ChunkSource` 인터페이스다.

## Visibility (Phase 1 §8)

`Tower.visibleChunkIds(frustum)`: chunk AABB 와 절두체 6평면 p-vertex 검사. 개별 팬케이크 occlusion 은 하지 않는다.

## Binary chunk (Phase 1 §27, §28)

`.chunk` (PKCH v1, little-endian): header(magic, version, headerBytes, chunkId, startSerial, count, bounds×6, minHeight, maxHeight, diameter, thickness, unitCm, attribute layout) + body(typed arrays, 4-byte 정렬). global id 는 `startSerial + index` 로 유도하므로 저장하지 않는다. `encodeChunk` / `decodeChunk` 는 JSON transform dump 와 동일함을 테스트한다. 100k(10 chunk) = 약 4.0 MB.

## Append (continuous)

`MemoryChunkSource.append(set)` 는 마지막 부분 chunk 를 다시 만들고 나머지를 새 chunk 로 붙인 뒤 바뀐 chunk id 를 돌려준다. `Tower.refresh(changed)` 와 `ChunkRenderer.invalidateChunks(changed)` 로 반영한다.
