import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type {
  EnvironmentStatus,
  InputFile,
  ModelRun,
  ProcessResult,
  StemId,
  UpdateInfo,
} from "../types";

export const inTauri = isTauri();

export async function detectEnvironment(): Promise<EnvironmentStatus> {
  if (!inTauri) {
    return {
      isTauri: false,
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      separatorAvailable: false,
      uvAvailable: false,
      engineLabel: "Browser preview",
      acceleration: "Preview mode",
    };
  }
  return invoke<EnvironmentStatus>("detect_environment");
}

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

export async function cancelJob(jobId?: string): Promise<boolean> {
  if (!inTauri) return true;
  return invoke<boolean>("cancel_job", { jobId });
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!inTauri) return { configured: false, available: false, currentVersion: "browser" };
  return invoke<UpdateInfo>("check_for_update");
}

export async function installUpdate(): Promise<void> {
  if (!inTauri) return;
  await invoke("install_update");
}

export async function revealPath(path: string): Promise<void> {
  if (!inTauri) return;
  await invoke("reveal_path", { path });
}

const DRAG_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAABYUlEQVR4nO2csVHEMBBFJQ29XOJqSKmBiDqIqIGUapS4GkgvYOZJXp1t+d4r4Lx682+19lhOSUTkOPLIH7u9f/+mk7B+vQ1ZW76SlEfIKunicqJ15pEXrJ+v6SwsHz9D0pRHyKknEtMiqkdSjsipJxZDololbe5BdSI5kXrLlvTUyeT8V3dr4y5X2q16aVlX91+sTpqerfWH5qBnoDxD74n0IhMEKAhQEKAgQEGAggAFAQoCFAQoCFAQoCDgJR308Hwkj7yJNkGAggAFHd2D6uQP2UwQoCBAQYBzEGCCAAUBCgKcgwATBCgIUNAV5qB64P2cCQIUBCgIcA4CTBCgIEBBgIIABQEKAhQEKAhQUFTQenfwbI83Nfbgfh10sM4EAd2ClslT1Ft/2fOQ/tloWVdzgtYL9KKe3hPuQctkkrbW67l5wC8vAKHme5voNPTWjSY0B62T7G6ROv1+kIikA/kDYGx5nyXqamEAAAAASUVORK5CYII=";

export async function dragFile(path: string): Promise<void> {
  if (!inTauri) return;
  await startDrag({ item: [path], icon: DRAG_ICON, mode: "copy" });
}

export function playableUrl(path: string): string {
  return inTauri ? convertFileSrc(path) : path;
}
