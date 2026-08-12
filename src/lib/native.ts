import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import type {
  EnvironmentStatus,
  InputFile,
  ModelRun,
  ProcessResult,
  StemId,
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

export async function revealPath(path: string): Promise<void> {
  if (!inTauri) return;
  await invoke("reveal_path", { path });
}

export function playableUrl(path: string): string {
  return inTauri ? convertFileSrc(path) : path;
}
