import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import {
  checkPortableUpdate,
  installAppVersion,
  isPortableBuild,
  isProductionBuild,
} from "./native";

export type UpdateOutcome =
  | { readonly status: "not-available" }
  | { readonly status: "deferred"; readonly version: string }
  | { readonly status: "installed"; readonly version: string };

interface UpdateCallbacks {
  readonly canInstall: () => boolean;
  readonly onAvailable: (version: string) => void;
  readonly onProgress: (downloaded: number, total: number | null) => void;
}

export async function checkAndInstallUpdate(
  callbacks: UpdateCallbacks,
): Promise<UpdateOutcome> {
  const [production, portable] = await Promise.all([
    isProductionBuild(),
    isPortableBuild(),
  ]);
  if (!production) return { status: "not-available" };

  if (portable) {
    const version = await checkPortableUpdate();
    if (!version) return { status: "not-available" };
    if (!callbacks.canInstall()) {
      return { status: "deferred", version };
    }

    callbacks.onAvailable(version);
    let downloaded = 0;
    let total: number | null = null;
    await installAppVersion(version, (event) => {
      if (event.event === "started") {
        total = event.data.content_length;
        callbacks.onProgress(0, total);
      } else if (event.event === "progress") {
        downloaded += event.data.chunk_length;
        callbacks.onProgress(downloaded, total);
      } else {
        callbacks.onProgress(total ?? downloaded, total);
      }
    });
    return { status: "installed", version };
  }

  const update = await check();
  if (!update) return { status: "not-available" };
  if (!callbacks.canInstall()) {
    return { status: "deferred", version: update.version };
  }

  callbacks.onAvailable(update.version);
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      callbacks.onProgress(0, total);
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      callbacks.onProgress(downloaded, total);
    } else if (event.event === "Finished") {
      callbacks.onProgress(total ?? downloaded, total);
    }
  });

  await relaunch();
  return { status: "installed", version: update.version };
}
