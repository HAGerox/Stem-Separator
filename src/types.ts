export type StemId =
  | "vocals"
  | "instrumental"
  | "drums"
  | "bass"
  | "guitar"
  | "piano"
  | "strings"
  | "other";

export type View = "drop" | "select" | "processing" | "results";

export interface InputFile {
  path: string;
  name: string;
  extension: string;
  durationSeconds?: number;
  sizeBytes?: number;
  isVideo: boolean;
}

export interface CatalogModel {
  id: string;
  filename: string;
  name: string;
  architecture: string;
  stems: StemId[];
  quality: number;
  speed: number;
  memory: "low" | "medium" | "high";
  note: string;
  source?: string;
}

export interface Catalog {
  schemaVersion: number;
  generatedAt: string;
  sourceLabel: string;
  models: CatalogModel[];
}

export interface ModelRun {
  id: string;
  modelFilename: string;
  modelName: string;
  stems: StemId[];
}

export interface JobProgress {
  jobId: string;
  overall: number;
  fileIndex: number;
  fileCount: number;
  stage: string;
  detail: string;
  modelName?: string;
  modelIndex?: number;
  modelCount?: number;
  etaSeconds?: number;
}

export interface OutputStem {
  path: string;
  name: string;
  stem: StemId;
  sourceName: string;
  isVideo: boolean;
  durationSeconds?: number;
}

export interface ProcessResult {
  jobId: string;
  outputDirectory: string;
  outputs: OutputStem[];
  warnings: string[];
  usedDemoMode: boolean;
}

export interface EnvironmentStatus {
  isTauri: boolean;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  separatorAvailable: boolean;
  uvAvailable: boolean;
  engineLabel: string;
  acceleration: string;
}
