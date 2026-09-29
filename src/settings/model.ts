export const DEFAULT_INTERFACE_SCALE = 100;
export const MIN_INTERFACE_SCALE = 75;
export const MAX_INTERFACE_SCALE = 150;
export const INTERFACE_SCALE_STEP = 5;

export function normalizeInterfaceScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERFACE_SCALE;
  const stepped = Math.round(value / INTERFACE_SCALE_STEP) * INTERFACE_SCALE_STEP;
  return Math.min(MAX_INTERFACE_SCALE, Math.max(MIN_INTERFACE_SCALE, stepped));
}

export function parseStoredInterfaceScale(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_INTERFACE_SCALE;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? normalizeInterfaceScale(parsed)
    : DEFAULT_INTERFACE_SCALE;
}

export function changeInterfaceScale(current: number, direction: -1 | 1): number {
  return normalizeInterfaceScale(current + direction * INTERFACE_SCALE_STEP);
}
