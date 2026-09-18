/**
 * 실제 거리 단위 (Phase 1 §15).
 * Physics world 는 1 unit = UNIT_CM cm (Phase 0 에서 10 cm 로 확정: 직경 1.0 / 두께 0.1).
 */
export const DEFAULT_UNIT_CM = 10;

export function worldUnitsToMeters(units: number, unitCm: number = DEFAULT_UNIT_CM): number {
  return (units * unitCm) / 100;
}
export function metersToWorldUnits(meters: number, unitCm: number = DEFAULT_UNIT_CM): number {
  return (meters * 100) / unitCm;
}

/**
 * UI 표시: 0~999 m → "123 m", 1~999 km → "12.34 km", 1000 km 이상 → "1,234 km" (천 단위 구분).
 * 소수 자릿수는 크기에 따라 줄인다.
 */
export function formatHeight(meters: number, locale = "en-US"): string {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 1000) return `${meters.toLocaleString(locale, { maximumFractionDigits: meters < 10 ? 2 : 0 })} m`;
  const km = meters / 1000;
  if (km < 1000) return `${km.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
  return `${km.toLocaleString(locale, { maximumFractionDigits: 0 })} km`;
}
