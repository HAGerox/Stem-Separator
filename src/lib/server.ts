import type { JobProgress, ProcessResult, StemId } from "../types";

type ServerOutput = {
  name: string;
  stem: StemId;
  sourceName: string;
  isVideo: boolean;
  durationSeconds?: number;
  url: string;
};

type ServerJob = {
  id: string;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  stage: string;
  detail: string;
  progress: number;
  phase?: JobProgress["phase"];
  phaseProgress?: number;
  modelName?: string;
  modelIndex?: number;
  modelCount?: number;
  fileIndex?: number;
  fileCount?: number;
  outputs?: ServerOutput[];
  error?: string;
  downloadUrl?: string;
};

function messageFrom(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "detail" in value && typeof value.detail === "string") return value.detail;
  return fallback;
}

function progressFrom(job: ServerJob): JobProgress {
  return {
    jobId: job.id,
    overall: job.progress,
    fileIndex: job.fileIndex || 0,
    fileCount: job.fileCount || 1,
    stage: job.stage,
    detail: job.detail,
    phase: job.phase,
    phaseProgress: job.phaseProgress,
    modelName: job.modelName,
    modelIndex: job.modelIndex,
    modelCount: job.modelCount,
  };
}

export async function processServerJob(
  files: File[],
  stems: StemId[],
  multiTrack: boolean,
  onProgress: (progress: JobProgress) => void,
): Promise<ProcessResult> {
  const body = new FormData();
  for (const file of files) body.append("files", file, file.name);
  body.append("stems", stems.join(","));
  body.append("multi_track", String(multiTrack));
  const response = await fetch("/api/jobs", { method: "POST", body });
  const created = await response.json().catch(() => ({})) as ServerJob;
  if (!response.ok) throw new Error(messageFrom(created, "Could not upload these files."));
  onProgress(progressFrom(created));

  for (;;) {
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    const pollResponse = await fetch(`/api/jobs/${created.id}`, { cache: "no-store" });
    const job = await pollResponse.json().catch(() => ({})) as ServerJob;
    if (!pollResponse.ok) throw new Error(messageFrom(job, "Could not read the separation status."));
    onProgress(progressFrom(job));
    if (job.status === "failed") throw new Error(job.error || "The separation failed.");
    if (job.status === "cancelled") throw new DOMException("The separation was stopped.", "AbortError");
    if (job.status !== "complete") continue;
    return {
      jobId: job.id,
      outputDirectory: job.downloadUrl || `/api/jobs/${job.id}/download`,
      outputs: (job.outputs || []).map((output) => ({
        path: output.url,
        name: output.name,
        stem: output.stem,
        sourceName: output.sourceName,
        isVideo: output.isVideo,
        durationSeconds: output.durationSeconds,
      })),
      warnings: [],
      usedDemoMode: false,
      serverMode: true,
    };
  }
}

export async function cancelServerJob(jobId: string) {
  if (!jobId || jobId === "starting") return;
  const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error("Could not stop the separation.");
}
