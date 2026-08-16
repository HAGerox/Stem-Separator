import fallbackCatalog from "../../catalog/models.v1.json";
import type { Catalog, CatalogCapability, CatalogModel, ModelOutput, ModelRun, StemId } from "../types";
import { serverMode } from "./runtime";

const DEFAULT_PRODUCT_CATALOG_URL = "https://raw.githubusercontent.com/HAGerox/Stem-Separator-Models/main/product-catalog.json";
const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/HAGerox/Stem-Separator-Models/main/registry.json";
const BUILD_ENV = import.meta.env || {};
const REMOTE_PRODUCT_CATALOG_URL = (BUILD_ENV.VITE_MODEL_CATALOG_URL as string | undefined)
  || DEFAULT_PRODUCT_CATALOG_URL;
const REMOTE_REGISTRY_URL = (BUILD_ENV.VITE_MODEL_REGISTRY_URL as string | undefined)
  || DEFAULT_REGISTRY_URL;
const CACHE_KEY = "stem-separator:model-registry:v5";
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type RegistryBackend = {
  state?: string;
  validated?: boolean;
  model_filename?: string;
  outputs?: Array<{
    runtime_key?: string;
    runtimeKey?: string;
    capability?: string;
    label?: string;
  }>;
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
  capabilities?: Record<string, RegistryCapability> | RegistryCapability[];
};

type RegistryCapability = {
  id?: string;
  label?: string;
  description?: string;
  kind?: string;
  family?: string;
  group?: string;
  group_label?: string;
  groupLabel?: string;
  glyph?: string;
};

type CachedRegistry = {
  etag?: string;
  fetchedAt?: number;
  sourceUrl?: string;
  catalog: Catalog;
};

type ProductBackend = {
  id?: string;
  reference?: string;
  state?: string;
  validated?: boolean;
  installable?: boolean;
  ready?: boolean;
  stable?: boolean;
  model_filename?: string;
  outputs?: RegistryBackend["outputs"];
  artifacts?: RegistryArtifact[];
};

type ProductCapability = {
  id: string;
  label?: string;
  kind?: string;
  group?: string;
  promoted?: boolean;
  available?: boolean;
  recommendation?: { model?: string; model_name?: string };
  backends?: ProductBackend[];
};

type ProductModel = {
  name?: string;
  architecture?: string;
  status?: string;
  availability?: { license?: string };
  backends?: Record<string, ProductBackend>;
};

type ProductCatalog = {
  schema: number;
  policy?: string;
  generated_at: string;
  promoted?: string[];
  groups?: string[];
  capabilities: ProductCapability[];
  multitrack?: {
    available?: boolean;
    recommendation?: { model?: string; model_name?: string };
    decomposition?: { outputs?: string[] };
    output_backends?: Record<string, ProductBackend[]>;
  } | null;
  models: Record<string, ProductModel>;
};

const NON_STEM_TASKS = new Set([
  "denoise", "dereverb", "decrowd", "cinematic_dnr", "karaoke", "rvc_vocals",
  "drum_substems", "multitrack", "multitrack_4", "multitrack_6", "multitrack_many",
]);

const GROUP_LABELS: Record<string, string> = {
  voice: "Voices",
  rhythm: "Rhythm & percussion",
  guitar: "Guitars",
  keys: "Keys",
  instrument: "Instruments",
  orchestral: "Orchestral",
  other: "Other stems",
};

function titleCase(identifier: string) {
  if (identifier === "hihat") return "Hi-hat";
  if (identifier === "sfx") return "Sound effects";
  return identifier.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function validIdentifier(value: string, capability = false) {
  return value.length > 0
    && value === value.trim()
    && !/[\\/\0]/.test(value)
    && !(capability && value.includes(","))
    && ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
}

function fallbackGroup(identifier: string) {
  if (/vocal|voice|choir|dialogue/.test(identifier)) return "voice";
  if (/drum|kick|snare|tom|hat|cymbal|ride|crash|percussion|conga|bell/.test(identifier)) return "rhythm";
  if (/violin|viola|cello|strings|brass|trumpet|trombone|horn|flute|clarinet|bassoon|orchestra/.test(identifier)) return "orchestral";
  return "instrument";
}

function registryCapabilityMap(registry: Registry) {
  const entries = Array.isArray(registry.capabilities)
    ? registry.capabilities.flatMap((capability) => typeof capability.id === "string" ? [[capability.id, capability] as const] : [])
    : Object.entries(registry.capabilities || {});
  return new Map(entries);
}

function catalogCapability(id: string, metadata?: RegistryCapability): CatalogCapability {
  const inferredKind = NON_STEM_TASKS.has(id)
    ? id.startsWith("multitrack") || id === "drum_substems" ? "preset" : id === "karaoke" || id === "rvc_vocals" ? "workflow" : "transform"
    : id === "instrumental" || id === "other" ? "complement" : "stem";
  const kind = ["stem", "complement", "preset", "transform", "workflow"].includes(metadata?.kind || "")
    ? metadata!.kind as CatalogCapability["kind"]
    : inferredKind;
  const group = metadata?.group || metadata?.family || fallbackGroup(id);
  return {
    id,
    label: metadata?.label?.trim() || titleCase(id),
    description: metadata?.description?.trim() || undefined,
    kind,
    group,
    groupLabel: metadata?.groupLabel || metadata?.group_label || GROUP_LABELS[group] || titleCase(group),
    glyph: metadata?.glyph,
  };
}

function validRegistry(value: unknown): value is Registry {
  if (!value || typeof value !== "object") return false;
  const registry = value as Partial<Registry>;
  return (registry.schema === 3 || registry.schema === 4)
    && typeof registry.generated_at === "string"
    && Array.isArray(registry.models)
    && !!registry.recommendations
    && typeof registry.recommendations === "object";
}

function validProductCatalog(value: unknown): value is ProductCatalog {
  if (!value || typeof value !== "object") return false;
  const catalog = value as Partial<ProductCatalog>;
  return catalog.schema === 1
    && typeof catalog.generated_at === "string"
    && Array.isArray(catalog.capabilities)
    && !!catalog.models
    && typeof catalog.models === "object";
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
    && backend?.validated === true
    && ((backend?.state && ["listed", "validated"].includes(backend.state)
      && typeof backend.model_filename === "string"
      && backend.model_filename.length > 0)
      || (!!directModelFilename(model)
        && registryArtifacts(model).some((artifact) => /\.ya?ml$/i.test(artifact.name))));
}

function modelOutputs(model: RegistryModel): ModelOutput[] {
  return normalizedOutputs(model.backends?.audio_separator?.outputs);
}

function normalizedOutputs(outputs: RegistryBackend["outputs"]): ModelOutput[] {
  return (outputs || []).flatMap((output) => {
    const runtimeKey = output.runtime_key || output.runtimeKey;
    if (!runtimeKey || !output.capability
      || !validIdentifier(output.capability, true) || !validIdentifier(runtimeKey)) return [];
    return [{ capability: output.capability, runtimeKey, label: output.label }];
  });
}

function productArtifacts(artifacts: RegistryArtifact[] | undefined) {
  return (artifacts || []).filter((artifact): artifact is Required<RegistryArtifact> =>
    typeof artifact.name === "string" && artifact.name.length > 0
    && typeof artifact.url === "string" && artifact.url.startsWith("https://")
    && typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/i.test(artifact.sha256));
}

function readyAudioSeparatorBackend(backends: ProductBackend[] | undefined) {
  return (backends || []).find((backend) => backend.id === "audio_separator"
    && backend.ready === true
    && backend.stable === true
    && backend.installable === true
    && typeof backend.reference === "string"
    && validIdentifier(backend.reference)
    && productArtifacts(backend.artifacts).length > 0);
}

export function catalogFromProductCatalog(product: ProductCatalog): Catalog {
  const models = new Map<string, CatalogModel>();
  const capabilities: Record<string, CatalogCapability> = {};
  const recommendations: Record<string, string> = {};
  let multiTrackSelection: Catalog["multiTrack"];
  const addModel = (modelId: string, stems: string[], outputs: ModelOutput[], contract?: ProductBackend) => {
    const source = product.models[modelId];
    const backend = source?.backends?.audio_separator;
    const filename = contract?.reference || backend?.reference || backend?.model_filename;
    if (!source || !filename || !validIdentifier(filename)
      || !stems.every((stem) => validIdentifier(stem, true))) return false;
    const existing = models.get(modelId);
    const allOutputs = normalizedOutputs(backend?.outputs);
    const selectedOutputs = outputs.length ? outputs : allOutputs.filter((output) => stems.includes(output.capability));
    if (stems.some((stem) => !selectedOutputs.some((output) => output.capability === stem))) return false;
    const artifacts = productArtifacts(contract?.artifacts?.length ? contract.artifacts : backend?.artifacts);
    if (existing) {
      existing.stems = [...new Set([...existing.stems, ...stems])];
      existing.outputs = [...new Map([...(existing.outputs || []), ...selectedOutputs]
        .map((output) => [`${output.capability}\u0000${output.runtimeKey}`, output])).values()];
      existing.artifacts = existing.artifacts?.length ? existing.artifacts : artifacts;
      return true;
    }
    models.set(modelId, {
      id: `audio-separator:${modelId}`,
      filename,
      name: source.name || modelId,
      architecture: source.architecture || "Unknown",
      stems: [...new Set(stems)],
      quality: 90,
      speed: 50,
      memory: "high",
      note: `Selected by ${product.policy || "the Stem Separator product policy"}.`,
      source: "HAGerox/Stem-Separator-Models product catalog",
      license: source.availability?.license,
      status: source.status,
      runtimeValidated: true,
      artifacts,
      outputs: selectedOutputs,
    });
    return true;
  };

  for (const capability of product.capabilities) {
    if (!capability.available || !capability.recommendation?.model) continue;
    const contract = readyAudioSeparatorBackend(capability.backends);
    if (!contract) continue;
    const outputs = normalizedOutputs(contract.outputs).filter((output) => output.capability === capability.id);
    if (!outputs.length || !addModel(capability.recommendation.model, [capability.id], outputs, contract)) continue;
    const metadata = catalogCapability(capability.id, capability);
    if (metadata.kind !== "stem" && metadata.kind !== "complement") continue;
    metadata.promoted = capability.promoted === true;
    capabilities[capability.id] = metadata;
    recommendations[capability.id] = `audio-separator:${capability.recommendation.model}`;
  }

  const multitrack = product.multitrack;
  if (multitrack?.available && multitrack.recommendation?.model && Array.isArray(multitrack.decomposition?.outputs)) {
    const stems = multitrack.decomposition.outputs;
    const bindings: ModelOutput[] = [];
    let sharedContract: ProductBackend | undefined;
    const ready = stems.every((stem) => {
      const contract = readyAudioSeparatorBackend(multitrack.output_backends?.[stem]);
      if (!contract || (sharedContract?.reference && sharedContract.reference !== contract.reference)) return false;
      sharedContract ||= contract;
      const output = normalizedOutputs(contract.outputs).find((candidate) => candidate.capability === stem);
      if (!output) return false;
      bindings.push(output);
      return true;
    });
    if (ready && sharedContract && addModel(multitrack.recommendation.model, stems, bindings, sharedContract)) {
      recommendations.multitrack = `audio-separator:${multitrack.recommendation.model}`;
      multiTrackSelection = { modelId: recommendations.multitrack, stems: [...stems] };
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: product.generated_at,
    sourceLabel: `HAGerox/Stem-Separator-Models · ${product.policy || "generated product catalog"}`,
    models: [...models.values()],
    recommendations,
    capabilities,
    promoted: product.promoted,
    groups: product.groups,
    multiTrack: multiTrackSelection,
  };
}

function modelCanDeliver(model: RegistryModel, capability: string) {
  if (!(model.tasks || []).includes(capability)) return false;
  const outputs = modelOutputs(model);
  return outputs.some((output) => output.capability === capability);
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
    .find((model): model is RegistryModel => !!model && compatibleModel(model)
      && (task.startsWith("multitrack") || modelCanDeliver(model, task)));
}

export function catalogFromRegistry(registry: Registry): Catalog {
  const modelById = new Map(registry.models.map((model) => [model.id, model]));
  const capabilityMetadata = registryCapabilityMap(registry);
  const recommendationTasks = Object.keys(registry.recommendations);
  const selectedByTask = new Map<string, RegistryModel>();
  for (const task of recommendationTasks) {
    const model = firstCompatibleRecommendation(registry, task, modelById);
    if (model) selectedByTask.set(task, model);
  }

  const selectedModels = new Map<string, CatalogModel>();
  for (const model of selectedByTask.values()) {
    if (!compatibleModel(model)) continue;
    const filename = modelFilename(model);
    if (!filename || !validIdentifier(filename)) continue;
    const outputs = modelOutputs(model);
    const stems = (model.tasks || []).filter((task) =>
      outputs.some((output) => output.capability === task));
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
      runtimeValidated: true,
      artifacts: registryArtifacts(model),
      outputs,
    });
  }

  const recommendations: NonNullable<Catalog["recommendations"]> = {};
  for (const [task, model] of selectedByTask) {
    recommendations[task] = `audio-separator:${model.id}`;
  }

  const capabilities: Record<string, CatalogCapability> = {};
  for (const task of recommendationTasks) {
    const capability = catalogCapability(task, capabilityMetadata.get(task));
    if ((capability.kind === "stem" || capability.kind === "complement") && selectedByTask.has(task)) {
      capabilities[task] = capability;
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: registry.generated_at,
    sourceLabel: "HAGerox/Stem-Separator-Models · audio-separator-compatible recommendations",
    models: [...selectedModels.values()],
    recommendations,
    capabilities,
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
  if (serverMode) {
    try {
      const response = await fetch("/api/models", { cache: "no-cache", headers: { Accept: "application/json" } });
      if (response.ok) {
        const payload = await response.json() as {
          catalog?: Catalog;
          remote?: boolean;
          capabilities?: CatalogCapability[];
          productProfile?: { promoted?: string[]; groups?: string[] };
          multiTrack?: { modelId?: string; stems?: string[] } | null;
        } | ProductCatalog;
        const productPayload = validProductCatalog(payload);
        const catalog = productPayload
          ? catalogFromProductCatalog(payload)
          : "catalog" in payload ? payload.catalog : undefined;
        if (!productPayload && catalog && "catalog" in payload && Array.isArray(payload.capabilities)) {
          catalog.capabilities = Object.fromEntries(payload.capabilities
            .filter((capability) => capability && typeof capability.id === "string")
            .map((capability) => [capability.id, capability]));
          catalog.promoted = payload.productProfile?.promoted;
          catalog.groups = payload.productProfile?.groups;
          if (payload.multiTrack?.modelId && Array.isArray(payload.multiTrack.stems)) {
            catalog.multiTrack = { modelId: payload.multiTrack.modelId, stems: payload.multiTrack.stems };
          }
        }
        if (catalog?.recommendations) {
          for (const [capability, modelId] of Object.entries(catalog.recommendations)) {
            if (!catalog.models.some((model) => model.id === modelId)
              && catalog.models.some((model) => model.id === `audio-separator:${modelId}`)) {
              catalog.recommendations[capability] = `audio-separator:${modelId}`;
            }
          }
        }
        const multiTrackModelId = catalog?.multiTrack?.modelId;
        if (catalog?.multiTrack && multiTrackModelId
          && !catalog.models.some((model) => model.id === multiTrackModelId)
          && catalog.models.some((model) => model.id === `audio-separator:${multiTrackModelId}`)) {
          catalog.multiTrack.modelId = `audio-separator:${multiTrackModelId}`;
        }
        if (catalog?.schemaVersion === 1 && catalog.models.length > 0) {
          return { catalog, remote: "remote" in payload && payload.remote === true };
        }
      }
    } catch {
      // The bundled catalog still keeps the interface usable while the server starts.
    }
  }
  const cached = readCache();
  for (const sourceUrl of [REMOTE_PRODUCT_CATALOG_URL, REMOTE_REGISTRY_URL]) {
    try {
      const headers = new Headers({ Accept: "application/json" });
      if (cached?.etag && cached.sourceUrl === sourceUrl) headers.set("If-None-Match", cached.etag);
      const response = await fetch(sourceUrl, { cache: "no-cache", headers });
      if (response.status === 304 && cached) return { catalog: cached.catalog, remote: true };
      if (!response.ok) continue;
      const payload = await response.json() as unknown;
      const catalog = validProductCatalog(payload)
        ? catalogFromProductCatalog(payload)
        : validRegistry(payload)
          ? catalogFromRegistry(payload)
          : (payload as Catalog);
      if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.models) || catalog.models.length === 0) continue;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          etag: response.headers.get("ETag") || undefined,
          fetchedAt: Date.now(),
          sourceUrl,
          catalog,
        }));
      } catch {
        // A read-only browser storage policy should not prevent offline fallback.
      }
      return { catalog, remote: true };
    } catch {
      // Try the compatibility source before the cached or bundled snapshot.
    }
  }
  return cached && Date.now() - (cached.fetchedAt || 0) <= CACHE_MAX_AGE_MS
    ? { catalog: cached.catalog, remote: true }
    : { catalog: fallbackCatalog as Catalog, remote: false };
}

function recommendation(catalog: Catalog, task: string) {
  const id = catalog.recommendations?.[task];
  return id ? catalog.models.find((model) => model.id === id) : undefined;
}

function usableCatalogModel(model: CatalogModel | undefined): model is CatalogModel {
  return !!model && (model.runtimeValidated === true || model.status === "verified");
}

export function recommendedMultiTrackModel(catalog: Catalog | null): CatalogModel | undefined {
  if (!catalog) return undefined;
  const recommended = [
    catalog.multiTrack ? catalog.models.find((model) => model.id === catalog.multiTrack!.modelId) : undefined,
    recommendation(catalog, "multitrack"),
    recommendation(catalog, "multitrack_6"),
    recommendation(catalog, "multitrack_4"),
  ].filter(usableCatalogModel);
  return recommended.sort((a, b) => b.stems.length - a.stems.length || b.quality - a.quality)[0];
}

export function recommendedMultiTrackStems(catalog: Catalog | null): StemId[] {
  const model = recommendedMultiTrackModel(catalog);
  const stems = catalog?.multiTrack?.stems || model?.stems || [];
  return model && stems.every((stem) =>
    model.outputs?.some((output) => output.capability === stem)) ? stems : [];
}

export function availableStems(catalog: Catalog | null): StemId[] {
  if (!catalog) return [];
  return availableCapabilities(catalog).map((capability) => capability.id);
}

export function availableCapabilities(catalog: Catalog | null): CatalogCapability[] {
  if (!catalog) return [];
  const candidateIds = new Set([
    ...Object.keys(catalog.recommendations || {}),
    ...catalog.models.flatMap((model) => model.stems),
  ]);
  return [...candidateIds].flatMap((id) => {
    if (id.startsWith("multitrack")) return [];
    const declared = catalog.capabilities?.[id];
    const declaredGroup = declared
      ? declared.group || (declared as CatalogCapability & { family?: string }).family || fallbackGroup(id)
      : undefined;
    const metadata = declared
      ? {
        ...catalogCapability(id),
        ...declared,
        group: declaredGroup!,
        groupLabel: declared.groupLabel || GROUP_LABELS[declaredGroup!] || titleCase(declaredGroup!),
      }
      : catalogCapability(id);
    if (metadata.kind !== "stem" && metadata.kind !== "complement") return [];
    const preferred = recommendation(catalog, id);
    const model = usableCatalogModel(preferred) && preferred.stems.includes(id)
      ? preferred
      : catalog.models.find((candidate) => usableCatalogModel(candidate) && candidate.stems.includes(id));
    if (!model || !model.stems.includes(id)) return [];
    if (!usableCatalogModel(model)) return [];
    if (!model.outputs?.some((output) => output.capability === id)) return [];
    return [metadata];
  }).sort((a, b) => {
    const aGroup = catalog.groups?.indexOf(a.group) ?? -1;
    const bGroup = catalog.groups?.indexOf(b.group) ?? -1;
    return (aGroup < 0 ? Number.MAX_SAFE_INTEGER : aGroup) - (bGroup < 0 ? Number.MAX_SAFE_INTEGER : bGroup)
      || a.groupLabel.localeCompare(b.groupLabel)
      || a.label.localeCompare(b.label);
  });
}

export function capabilityLabel(catalog: Catalog | null, id: StemId) {
  return catalog?.capabilities?.[id]?.label || titleCase(id);
}

export function buildModelPlan(catalog: Catalog, selected: StemId[], multiTrack = false): ModelRun[] {
  if (multiTrack) {
    const model = recommendedMultiTrackModel(catalog);
    const stems = recommendedMultiTrackStems(catalog);
    const outputs = stems.flatMap((stem) => {
      const output = model?.outputs?.find((candidate) => candidate.capability === stem);
      return output ? [output] : [];
    });
    if (model && stems.length && outputs.length === stems.length) return [{
      modelFilename: model.filename,
      modelName: model.name,
      stems,
      artifacts: model.artifacts,
      outputs,
    }];
  }

  // Custom selections are independent extraction targets. Resolve the best
  // recommendation for every stem, then coalesce stems only when the registry
  // deliberately recommends the same model for them. A broad multi-stem model
  // must never win simply because it covers more checked boxes.
  const runsByModel = new Map<string, ModelRun>();
  for (const stem of selected) {
    const preferred = recommendation(catalog, stem);
    const model = usableCatalogModel(preferred) && preferred.stems.includes(stem)
      && preferred.outputs?.some((output) => output.capability === stem)
      ? preferred
      : catalog.models
        .filter((candidate) => usableCatalogModel(candidate) && candidate.stems.includes(stem)
          && candidate.outputs?.some((output) => output.capability === stem))
        .sort((a, b) => b.quality - a.quality || b.speed - a.speed)[0];
    if (!model) continue;
    const existing = runsByModel.get(model.id);
    if (existing) {
      existing.stems.push(stem);
      const output = model.outputs?.find((candidate) => candidate.capability === stem);
      if (output) existing.outputs = [...(existing.outputs || []), output];
    } else {
      runsByModel.set(model.id, {
        modelFilename: model.filename,
        modelName: model.name,
        stems: [stem],
        artifacts: model.artifacts,
        outputs: model.outputs?.filter((output) => output.capability === stem),
      });
    }
  }
  return [...runsByModel.values()];
}
