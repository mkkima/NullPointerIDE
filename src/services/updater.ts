import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { isProductionBuild } from "./native";

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
  if (!(await isProductionBuild())) return { status: "not-available" };

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
