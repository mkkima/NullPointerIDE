import type {
  AndroidAvdStatus,
  AndroidDevice,
  AndroidEmulatorSnapshot,
} from "../types";

export interface EmulatorSummary {
  readonly installed: number;
  readonly running: number;
  readonly connected: number;
}

function arraysEqual<T>(
  left: readonly T[],
  right: readonly T[],
  equal: (leftValue: T, rightValue: T) => boolean,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => equal(value, right[index]!))
  );
}

export function emulatorSnapshotsEqual(
  left: AndroidEmulatorSnapshot | null,
  right: AndroidEmulatorSnapshot | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.sdkRoot === right.sdkRoot &&
    left.adbAvailable === right.adbAvailable &&
    left.emulatorAvailable === right.emulatorAvailable &&
    arraysEqual(left.warnings, right.warnings, (a, b) => a === b) &&
    arraysEqual(left.avds, right.avds, (a, b) =>
      a.name === b.name &&
      a.displayName === b.displayName &&
      a.target === b.target &&
      a.abi === b.abi &&
      a.device === b.device &&
      a.resolution === b.resolution &&
      a.playStore === b.playStore &&
      a.status === b.status &&
      a.serial === b.serial &&
      a.model === b.model,
    ) &&
    arraysEqual(left.devices, right.devices, (a, b) =>
      a.serial === b.serial &&
      a.state === b.state &&
      a.model === b.model &&
      a.product === b.product &&
      a.device === b.device &&
      a.isEmulator === b.isEmulator &&
      a.avdName === b.avdName,
    )
  );
}

export function summarizeEmulators(snapshot: AndroidEmulatorSnapshot): EmulatorSummary {
  return {
    installed: snapshot.avds.length,
    running: snapshot.avds.filter((avd) => avd.status === "running").length,
    connected: snapshot.devices.filter((device) => device.state === "device").length,
  };
}

export function emulatorStatusLabel(status: AndroidAvdStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "offline":
      return "Offline";
    default:
      return "Stopped";
  }
}

export function secondaryAndroidDevices(
  snapshot: AndroidEmulatorSnapshot,
): readonly AndroidDevice[] {
  const mappedSerials = new Set(
    snapshot.avds
      .map((avd) => avd.serial)
      .filter((serial): serial is string => serial !== null),
  );
  return snapshot.devices.filter((device) => !mappedSerials.has(device.serial));
}
