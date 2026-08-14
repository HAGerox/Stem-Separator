export type StemId =
  | "vocals"
  | "instrumental"
  | "drums"
  | "bass"
  | "guitar"
  | "piano"
  | "kick"
  | "snare"
  | "toms"
  | "hihat"
  | "cymbals"
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
  license?: string;
  status?: string;
  artifacts?: ModelArtifact[];
}

export interface ModelArtifact {
  name: string;
  url: string;
  sha256: string;
}

export interface Catalog {
  schemaVersion: number;
  generatedAt: string;
  sourceLabel: string;
  models: CatalogModel[];
  recommendations?: Partial<Record<StemId | "multitrack_4" | "multitrack_6", string>>;
}

export interface ModelRun {
  id: string;
  modelFilename: string;
  modelName: string;
  stems: StemId[];
  artifacts?: ModelArtifact[];
}

export type JobPhase = "upload" | "prepare" | "download" | "separate" | "finish" | "complete";

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
  phase?: JobPhase;
  phaseProgress?: number;
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
  serverMode?: boolean;
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

export interface UpdateInfo {
  configured: boolean;
  available: boolean;
  currentVersion: string;
  version?: string;
  notes?: string;
  date?: string;
}
