import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type {
  InputFile,
  ModelRun,
  ProcessResult,
  StemId,
  UpdateInfo,
} from "../types";

export const inTauri = isTauri();

export async function resolveInputs(paths: string[]): Promise<InputFile[]> {
  return invoke<InputFile[]>("resolve_inputs", { paths });
}

export async function processJob(payload: {
  paths: string[];
  stems: StemId[];
  plan: ModelRun[];
  keepVideo: boolean;
  outputDirectory?: string;
  demoMode: boolean;
}): Promise<ProcessResult> {
  return invoke<ProcessResult>("process_job", { request: payload });
}

export async function requiredModelDownloads(plan: ModelRun[]): Promise<number[]> {
  if (!inTauri) return [];
  return invoke<number[]>("required_model_downloads", { plan });
}

export async function cancelJob(jobId?: string): Promise<boolean> {
  if (!inTauri) return true;
  return invoke<boolean>("cancel_job", { jobId });
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!inTauri) return { configured: false, available: false, currentVersion: "browser" };
  return invoke<UpdateInfo>("check_for_update");
}

export async function installUpdate(onProgress?: (progress: number) => void): Promise<void> {
  if (!inTauri) return;
  const unlisten = await listen<number>("update-progress", (event) => onProgress?.(event.payload));
  try {
    await invoke("install_update");
  } finally {
    unlisten();
  }
}

export async function revealPath(path: string): Promise<void> {
  if (!inTauri) return;
  await invoke("reveal_path", { path });
}

// A transparent drag image lets macOS show its native file-drag badge instead
// of a second, app-specific handle floating under the pointer.
const NATIVE_DRAG_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";

export async function dragFile(path: string): Promise<void> {
  if (!inTauri) return;
  await startDrag({ item: [path], icon: NATIVE_DRAG_IMAGE, mode: "copy" });
}

export function playableUrl(path: string): string {
  return inTauri ? convertFileSrc(path) : path;
}
