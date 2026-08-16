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
  phase_progress?: number;
  modelName?: string;
  model_name?: string;
  modelIndex?: number;
  model_index?: number;
  modelCount?: number;
  model_count?: number;
  fileIndex?: number;
  file_index?: number;
  fileCount?: number;
  file_count?: number;
  outputs?: ServerOutput[];
  error?: string;
  downloadUrl?: string;
};

export type ServerUploadSnapshot = {
  state: "uploading" | "complete" | "failed" | "cancelled";
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
};

export type ServerUploadHandle = {
  ready: Promise<string>;
  snapshot: () => ServerUploadSnapshot;
  cancel: () => Promise<void>;
};

function messageFrom(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "detail" in value && typeof value.detail === "string") return value.detail;
  return fallback;
}

function progressFrom(job: ServerJob): JobProgress {
  return {
    jobId: job.id,
    overall: job.progress,
    fileIndex: job.fileIndex ?? job.file_index ?? 0,
    fileCount: job.fileCount ?? job.file_count ?? 1,
    stage: job.stage,
    detail: job.detail,
    phase: job.phase,
    phaseProgress: job.phaseProgress ?? job.phase_progress,
    modelName: job.modelName ?? job.model_name,
    modelIndex: job.modelIndex ?? job.model_index,
    modelCount: job.modelCount ?? job.model_count,
  };
}

export function startServerUpload(
  files: File[],
  onProgress: (snapshot: ServerUploadSnapshot) => void,
): ServerUploadHandle {
  let uploadId: string | null = null;
  let request: XMLHttpRequest | null = null;
  let cancelled = false;
  let current: ServerUploadSnapshot = {
    state: "uploading",
    progress: 0,
    uploadedBytes: 0,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  };
  const update = (next: Partial<ServerUploadSnapshot>) => {
    current = { ...current, ...next };
    onProgress(current);
  };
  const abortError = () => new DOMException("The upload was stopped.", "AbortError");

  const ready = (async () => {
    const createResponse = await fetch("/api/uploads", { method: "POST" });
    const created = await createResponse.json().catch(() => ({})) as { id?: string; detail?: string };
    if (!createResponse.ok || !created.id) throw new Error(messageFrom(created, "Could not start the background upload."));
    uploadId = created.id;
    if (cancelled) {
      await fetch(`/api/uploads/${uploadId}`, { method: "DELETE" }).catch(() => undefined);
      throw abortError();
    }

    const body = new FormData();
    for (const file of files) body.append("files", file, file.name);
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      request = xhr;
      xhr.open("POST", `/api/uploads/${uploadId}`);
      xhr.upload.onprogress = (event) => {
        const total = event.lengthComputable ? event.total : current.totalBytes;
        update({
          uploadedBytes: event.loaded,
          totalBytes: total,
          progress: total > 0 ? Math.min(99, 100 * event.loaded / total) : 0,
        });
      };
      xhr.onerror = () => reject(new Error("The background upload was interrupted."));
      xhr.onabort = () => reject(abortError());
      xhr.onload = () => {
        let payload: unknown = {};
        try { payload = JSON.parse(xhr.responseText || "{}"); } catch { /* handled below */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(messageFrom(payload, "Could not upload these files.")));
      };
      xhr.send(body);
    });
    if (cancelled) throw abortError();
    update({ state: "complete", progress: 100, uploadedBytes: current.totalBytes });
    return uploadId;
  })().catch((reason) => {
    update({ state: reason instanceof DOMException && reason.name === "AbortError" ? "cancelled" : "failed" });
    throw reason;
  });

  return {
    ready,
    snapshot: () => current,
    cancel: async () => {
      if (cancelled) return;
      cancelled = true;
      request?.abort();
      update({ state: "cancelled" });
      if (uploadId) await fetch(`/api/uploads/${uploadId}`, { method: "DELETE" }).catch(() => undefined);
    },
  };
}

export async function processServerJob(
  upload: ServerUploadHandle,
  stems: StemId[],
  multiTrack: boolean,
  onProgress: (progress: JobProgress) => void,
  processingFloor = 0,
  onCreated?: (jobId: string) => void,
): Promise<ProcessResult> {
  const uploadId = await upload.ready;
  const body = new FormData();
  body.append("upload_id", uploadId);
  body.append("stems", stems.join(","));
  body.append("multi_track", String(multiTrack));
  const response = await fetch("/api/jobs", { method: "POST", body });
  const created = await response.json().catch(() => ({})) as ServerJob;
  if (!response.ok) throw new Error(messageFrom(created, "Could not upload these files."));
  onCreated?.(created.id);
  const report = (job: ServerJob) => {
    const progress = progressFrom(job);
    onProgress({ ...progress, overall: processingFloor + (100 - processingFloor) * progress.overall / 100 });
  };
  report(created);

  for (;;) {
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    const pollResponse = await fetch(`/api/jobs/${created.id}`, { cache: "no-store" });
    const job = await pollResponse.json().catch(() => ({})) as ServerJob;
    if (!pollResponse.ok) throw new Error(messageFrom(job, "Could not read the separation status."));
    report(job);
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
    };
  }
}

export async function cancelServerJob(jobId: string) {
  if (!jobId || jobId === "starting") return;
  const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error("Could not stop the separation.");
}
