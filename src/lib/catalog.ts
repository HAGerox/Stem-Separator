import fallbackCatalog from "../../catalog/models.v1.json";
import type { Catalog, ModelRun, StemId } from "../types";

const REMOTE_CATALOG_URL = import.meta.env.VITE_MODEL_CATALOG_URL as string | undefined;

export async function loadCatalog(): Promise<{ catalog: Catalog; remote: boolean }> {
  if (REMOTE_CATALOG_URL) {
    try {
      const response = await fetch(REMOTE_CATALOG_URL, { cache: "no-cache" });
      if (response.ok) {
        const catalog = (await response.json()) as Catalog;
        if (catalog.schemaVersion === 1 && Array.isArray(catalog.models)) {
          return { catalog, remote: true };
        }
      }
    } catch {
      // The app is deliberately offline-first; the bundled ranking remains usable.
    }
  }
  return { catalog: fallbackCatalog as Catalog, remote: false };
}

export function buildModelPlan(catalog: Catalog, selected: StemId[]): ModelRun[] {
  const uncovered = new Set(selected);
  const runs: ModelRun[] = [];

  while (uncovered.size > 0) {
    const candidates = catalog.models
      .map((model) => {
        const covers = model.stems.filter((stem) => uncovered.has(stem));
        const precisionBonus = covers.length / Math.max(model.stems.length, 1);
        return { model, covers, score: covers.length * 100 + model.quality + precisionBonus * 10 };
      })
      .filter((candidate) => candidate.covers.length > 0)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (!best) break;

    runs.push({
      id: best.model.id,
      modelFilename: best.model.filename,
      modelName: best.model.name,
      stems: best.covers,
    });
    best.covers.forEach((stem) => uncovered.delete(stem));
  }

  // Strings are currently derived from the broad "other" stem until the live
  // ranking catalog names a compatible dedicated model.
  if (uncovered.has("strings")) {
    const broad = catalog.models.find((model) => model.stems.includes("other"));
    if (broad) {
      const existing = runs.find((run) => run.id === broad.id);
      if (existing) existing.stems.push("strings");
      else {
        runs.push({
          id: broad.id,
          modelFilename: broad.filename,
          modelName: broad.name,
          stems: ["strings"],
        });
      }
      uncovered.delete("strings");
    }
  }

  return runs;
}
