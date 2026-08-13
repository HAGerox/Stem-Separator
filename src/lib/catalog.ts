import fallbackCatalog from "../../catalog/models.v1.json";
import type { Catalog, CatalogModel, ModelRun, StemId } from "../types";

const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/HAGerox/Stem-Separator-Models/main/registry.json";
const BUILD_ENV = import.meta.env || {};
const REMOTE_REGISTRY_URL = (BUILD_ENV.VITE_MODEL_REGISTRY_URL as string | undefined)
  || (BUILD_ENV.VITE_MODEL_CATALOG_URL as string | undefined)
  || DEFAULT_REGISTRY_URL;
const CACHE_KEY = "stem-separator:model-registry:v4";
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type RegistryBackend = {
  state?: string;
  model_filename?: string;
};

type RegistryArtifact = {
  name?: string;
  url?: string;
  sha256?: string;
};

type RegistryModel = {
  id: string;
  name: string;
  architecture?: string;
  status?: string;
  tasks?: string[];
  availability?: { state?: string; license?: string; artifacts?: RegistryArtifact[] };
  backends?: { audio_separator?: RegistryBackend };
};

type RegistryRecommendation = {
  model: string;
  alternatives?: Array<{ model: string }>;
};

type Registry = {
  schema: number;
  generated_at: string;
  models: RegistryModel[];
  recommendations: Record<string, RegistryRecommendation>;
};

type CachedRegistry = {
  etag?: string;
  fetchedAt?: number;
  catalog: Catalog;
};

const APP_STEMS = new Set<StemId>([
  "vocals", "instrumental", "drums", "bass", "guitar", "piano",
  "kick", "snare", "toms", "hihat", "cymbals", "other",
]);

function validRegistry(value: unknown): value is Registry {
  if (!value || typeof value !== "object") return false;
  const registry = value as Partial<Registry>;
  return registry.schema === 3
    && typeof registry.generated_at === "string"
    && Array.isArray(registry.models)
    && !!registry.recommendations
    && typeof registry.recommendations === "object";
}

function registryArtifacts(model: RegistryModel) {
  return (model.availability?.artifacts || []).filter((artifact): artifact is Required<RegistryArtifact> =>
    typeof artifact.name === "string" && artifact.name.length > 0
    && typeof artifact.url === "string" && artifact.url.startsWith("https://")
    && typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/i.test(artifact.sha256));
}

function directModelFilename(model: RegistryModel) {
  return registryArtifacts(model).find((artifact) => /\.(ckpt|pth|onnx|th)$/i.test(artifact.name))?.name;
}

function compatibleModel(model: RegistryModel) {
  const backend = model.backends?.audio_separator;
  return model.availability?.state === "public_weights"
    && ((backend?.state === "listed"
      && typeof backend.model_filename === "string"
      && backend.model_filename.length > 0)
      || (!!directModelFilename(model)
        && registryArtifacts(model).some((artifact) => /\.ya?ml$/i.test(artifact.name))));
}

function modelFilename(model: RegistryModel) {
  return directModelFilename(model) || model.backends?.audio_separator?.model_filename;
}

function firstCompatibleRecommendation(
  registry: Registry,
  task: string,
  modelById: Map<string, RegistryModel>,
): RegistryModel | undefined {
  const recommendation = registry.recommendations[task];
  if (!recommendation) return undefined;
  return [recommendation.model, ...(recommendation.alternatives || []).map((item) => item.model)]
    .map((id) => modelById.get(id))
    .find((model): model is RegistryModel => !!model && compatibleModel(model));
}

export function catalogFromRegistry(registry: Registry): Catalog {
  const modelById = new Map(registry.models.map((model) => [model.id, model]));
  const recommendationTasks = [
    ...APP_STEMS,
    "multitrack_4",
    "multitrack_6",
  ];
  const selectedByTask = new Map<string, RegistryModel>();
  for (const task of recommendationTasks) {
    const model = firstCompatibleRecommendation(registry, task, modelById);
    if (model) selectedByTask.set(task, model);
  }

  const selectedModels = new Map<string, CatalogModel>();
  for (const model of selectedByTask.values()) {
    if (!compatibleModel(model)) continue;
    const filename = modelFilename(model);
    if (!filename) continue;
    const stems = (model.tasks || []).filter((task): task is StemId => APP_STEMS.has(task as StemId));
    if (!stems.length) continue;
    selectedModels.set(model.id, {
      id: `audio-separator:${model.id}`,
      filename,
      name: model.name,
      architecture: model.architecture || "Unknown",
      stems,
      quality: model.status === "current" ? 96 : model.status === "specialist" ? 94 : 86,
      speed: 50,
      memory: "high",
      note: "Selected from the capability-aware HAGerox model registry recommendations.",
      source: "HAGerox/Stem-Separator-Models",
      license: model.availability?.license,
      status: model.status,
      artifacts: registryArtifacts(model),
    });
  }

  const recommendations: Catalog["recommendations"] = {};
  for (const [task, model] of selectedByTask) {
    recommendations[task as keyof NonNullable<Catalog["recommendations"]>] = `audio-separator:${model.id}`;
  }

  return {
    schemaVersion: 1,
    generatedAt: registry.generated_at,
    sourceLabel: "HAGerox/Stem-Separator-Models · audio-separator-compatible recommendations",
    models: [...selectedModels.values()],
    recommendations,
  };
}

function readCache(): CachedRegistry | null {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) || "null") as CachedRegistry | null;
    return value?.catalog?.schemaVersion === 1 && Array.isArray(value.catalog.models) ? value : null;
  } catch {
    return null;
  }
}

export async function loadCatalog(): Promise<{ catalog: Catalog; remote: boolean }> {
  const cached = readCache();
  try {
    const headers = new Headers({ Accept: "application/json" });
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    const response = await fetch(REMOTE_REGISTRY_URL, { cache: "no-cache", headers });
    if (response.status === 304 && cached) return { catalog: cached.catalog, remote: true };
    if (response.ok) {
      const payload = await response.json() as unknown;
      const catalog = validRegistry(payload)
        ? catalogFromRegistry(payload)
        : (payload as Catalog);
      if (catalog.schemaVersion === 1 && Array.isArray(catalog.models) && catalog.models.length > 0) {
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ etag: response.headers.get("ETag") || undefined, fetchedAt: Date.now(), catalog }));
        } catch {
          // A read-only browser storage policy should not prevent offline fallback.
        }
        return { catalog, remote: true };
      }
    }
  } catch {
    // Offline-first: use the last known-good registry, then the bundled snapshot.
  }
  return cached && Date.now() - (cached.fetchedAt || 0) <= CACHE_MAX_AGE_MS
    ? { catalog: cached.catalog, remote: true }
    : { catalog: fallbackCatalog as Catalog, remote: false };
}

function recommendation(catalog: Catalog, task: StemId | "multitrack_4" | "multitrack_6") {
  const id = catalog.recommendations?.[task];
  return id ? catalog.models.find((model) => model.id === id) : undefined;
}

export function availableStems(catalog: Catalog | null): StemId[] {
  if (!catalog) return [];
  return [...APP_STEMS].filter((stem) => recommendation(catalog, stem)
    || catalog.models.some((model) => model.stems.includes(stem)));
}

export function buildModelPlan(catalog: Catalog, selected: StemId[], multiTrack = false): ModelRun[] {
  const completeMix = ["vocals", "drums", "bass", "guitar", "piano", "other"] satisfies StemId[];
  const isCompleteMix = multiTrack && selected.length === completeMix.length && completeMix.every((stem) => selected.includes(stem));
  if (isCompleteMix) {
    const model = recommendation(catalog, "multitrack_6")
      || catalog.models.find((candidate) => completeMix.every((stem) => candidate.stems.includes(stem)));
    if (model) return [{ id: model.id, modelFilename: model.filename, modelName: model.name, stems: completeMix, artifacts: model.artifacts }];
  }

  // Custom selections are independent extraction targets. Resolve the best
  // recommendation for every stem, then coalesce stems only when the registry
  // deliberately recommends the same model for them. A broad multi-stem model
  // must never win simply because it covers more checked boxes.
  const runsByModel = new Map<string, ModelRun>();
  for (const stem of selected) {
    const model = recommendation(catalog, stem)
      || catalog.models
        .filter((candidate) => candidate.stems.includes(stem))
        .sort((a, b) => b.quality - a.quality || b.speed - a.speed)[0];
    if (!model) continue;
    const existing = runsByModel.get(model.id);
    if (existing) {
      existing.stems.push(stem);
    } else {
      runsByModel.set(model.id, {
        id: model.id,
        modelFilename: model.filename,
        modelName: model.name,
        stems: [stem],
        artifacts: model.artifacts,
      });
    }
  }
  return [...runsByModel.values()];
}
