// Capability identifiers are registry data, not an application enum. Keeping
// this alias makes the request/response types readable without preventing a
// newly published stem from appearing in the app.
export type StemId = string;

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
  runtimeValidated?: boolean;
  artifacts?: ModelArtifact[];
  outputs?: ModelOutput[];
}

export interface ModelArtifact {
  name: string;
  url: string;
  sha256: string;
}

export interface ModelOutput {
  capability: StemId;
  runtimeKey: string;
  label?: string;
}

export interface CatalogCapability {
  id: StemId;
  label: string;
  description?: string;
  kind: "stem" | "complement" | "preset" | "transform" | "workflow";
  group: string;
  groupLabel: string;
  glyph?: string;
  promoted?: boolean;
}

export interface Catalog {
  schemaVersion: number;
  generatedAt: string;
  sourceLabel: string;
  models: CatalogModel[];
  recommendations?: Record<string, string>;
  capabilities?: Record<string, CatalogCapability>;
  promoted?: StemId[];
  groups?: string[];
  multiTrack?: { modelId: string; stems: StemId[] };
}

export interface ModelRun {
  modelFilename: string;
  modelName: string;
  stems: StemId[];
  artifacts?: ModelArtifact[];
  outputs?: ModelOutput[];
}

type JobPhase = "upload" | "prepare" | "download" | "separate" | "finish" | "complete";

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
}

export interface UpdateInfo {
  configured: boolean;
  available: boolean;
  currentVersion: string;
  version?: string;
  notes?: string;
  date?: string;
}
