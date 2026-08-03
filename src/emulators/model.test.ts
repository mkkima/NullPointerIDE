import { describe, expect, it } from "vitest";
import type { AndroidEmulatorSnapshot } from "../types";
import {
  emulatorSnapshotsEqual,
  emulatorStatusLabel,
  secondaryAndroidDevices,
  summarizeEmulators,
} from "./model";

const snapshot: AndroidEmulatorSnapshot = {
  sdkRoot: "C:\\Android\\Sdk",
  adbAvailable: true,
  emulatorAvailable: true,
  avds: [
    {
      name: "Pixel_8",
      displayName: "Pixel 8",
      target: "android-35",
      abi: "x86_64",
      device: "pixel_8",
      resolution: "1080 × 2400",
      playStore: true,
      status: "running",
      serial: "emulator-5554",
      model: "sdk_gphone64_x86_64",
    },
    {
      name: "Tablet",
      displayName: "Tablet",
      target: "android-35",
      abi: "x86_64",
      device: "pixel_tablet",
      resolution: null,
      playStore: false,
      status: "stopped",
      serial: null,
      model: null,
    },
  ],
  devices: [
    {
      serial: "emulator-5554",
      state: "device",
      model: "sdk_gphone64_x86_64",
      product: "sdk_gphone64_x86_64",
      device: "emu64xa",
      isEmulator: true,
      avdName: "Pixel_8",
    },
    {
      serial: "phone-1",
      state: "device",
      model: "Phone",
      product: "phone",
      device: "phone",
      isEmulator: false,
      avdName: null,
    },
  ],
  warnings: [],
};

describe("emulator view model", () => {
  it("summarizes installed, running, and connected devices", () => {
    expect(summarizeEmulators(snapshot)).toEqual({
      installed: 2,
      running: 1,
      connected: 2,
    });
  });

  it("keeps physical and otherwise-unmapped devices in the secondary list", () => {
    const withUnmappedEmulator: AndroidEmulatorSnapshot = {
      ...snapshot,
      devices: [
        ...snapshot.devices,
        {
          serial: "emulator-5556",
          state: "device",
          model: "External emulator",
          product: "sdk",
          device: "emu64xa",
          isEmulator: true,
          avdName: "No_longer_installed",
        },
      ],
    };

    expect(
      secondaryAndroidDevices(withUnmappedEmulator).map((device) => device.serial),
    ).toEqual(["phone-1", "emulator-5556"]);
  });

  it("uses stable user-facing status labels", () => {
    expect(emulatorStatusLabel("starting")).toBe("Starting");
    expect(emulatorStatusLabel("offline")).toBe("Offline");
  });

  it("detects whether polling data actually changed", () => {
    expect(emulatorSnapshotsEqual(snapshot, structuredClone(snapshot))).toBe(true);
    expect(
      emulatorSnapshotsEqual(snapshot, {
        ...snapshot,
        avds: snapshot.avds.map((avd, index) =>
          index === 0 ? { ...avd, status: "starting" } : avd,
        ),
      }),
    ).toBe(false);
  });
});
