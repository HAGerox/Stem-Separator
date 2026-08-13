from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

REGISTRY_URL = os.getenv(
    "STEM_SEPARATOR_MODEL_REGISTRY_URL",
    "https://raw.githubusercontent.com/HAGerox/Stem-Separator-Models/main/registry.json",
)
REFRESH_SECONDS = int(os.getenv("STEM_SEPARATOR_MODEL_REGISTRY_REFRESH_SECONDS", "21600"))
MAX_CACHE_AGE_SECONDS = int(os.getenv("STEM_SEPARATOR_MODEL_REGISTRY_MAX_CACHE_AGE_SECONDS", str(30 * 24 * 60 * 60)))

APP_STEMS = {
    "vocals", "instrumental", "drums", "bass", "guitar", "piano",
    "kick", "snare", "toms", "hihat", "cymbals", "other",
}

FALLBACK = {
    "generatedAt": "2026-08-13",
    "source": "bundled fallback",
    "models": {
        "resurrection-vocals": {
            "name": "BS RoFormer Resurrection Vocals",
            "filename": "bs_roformer_vocals_resurrection_unwa.ckpt",
            "stems": ["vocals"],
        },
        "gabox-fv7z": {
            "name": "MelBand RoFormer Inst Gabox Fv7z",
            "filename": "mel_band_roformer_instrumental_fv7z_gabox.ckpt",
            "stems": ["instrumental"],
        },
        "bs-roformer-sw": {
            "name": "BS RoFormer SW 6-Stem",
            "filename": "BS-Roformer-SW.ckpt",
            "stems": ["vocals", "drums", "bass", "guitar", "piano", "other"],
        },
        "jarredou-drumsep-5": {
            "name": "Jarredou DrumSep 5",
            "filename": "MDX23C-DrumSep-aufr33-jarredou.ckpt",
            "stems": ["kick", "snare", "toms", "hihat", "cymbals"],
        },
        "htdemucs-ft": {
            "name": "HTDemucs Fine-Tuned",
            "filename": "htdemucs_ft.yaml",
            "stems": ["vocals", "drums", "bass", "other"],
        },
    },
    "recommendations": {
        "vocals": "resurrection-vocals",
        "instrumental": "gabox-fv7z",
        "drums": "bs-roformer-sw",
        "bass": "bs-roformer-sw",
        "guitar": "bs-roformer-sw",
        "piano": "bs-roformer-sw",
        "kick": "jarredou-drumsep-5",
        "snare": "jarredou-drumsep-5",
        "toms": "jarredou-drumsep-5",
        "hihat": "jarredou-drumsep-5",
        "cymbals": "jarredou-drumsep-5",
        "other": "bs-roformer-sw",
        "multitrack_4": "htdemucs-ft",
        "multitrack_6": "bs-roformer-sw",
    },
}


@dataclass(frozen=True)
class ModelChoice:
    id: str
    name: str
    filename: str
    stems: tuple[str, ...]


class ModelRegistry:
    def __init__(self, cache_root: Path):
        self.cache_file = cache_root / "model-registry.json"
        self.meta_file = cache_root / "model-registry-meta.json"
        self.catalog = FALLBACK
        self.etag: str | None = None
        self.last_checked = 0.0
        self.remote = False
        self._load_cache()

    def _load_cache(self) -> None:
        try:
            payload = json.loads(self.cache_file.read_text())
            if time.time() - self.cache_file.stat().st_mtime > MAX_CACHE_AGE_SECONDS:
                return
            self.catalog = self._convert(payload)
            meta = json.loads(self.meta_file.read_text()) if self.meta_file.is_file() else {}
            self.etag = meta.get("etag")
            self.remote = True
        except (OSError, ValueError, TypeError, KeyError):
            self.catalog = FALLBACK

    @staticmethod
    def _compatible(model: dict) -> bool:
        backend = model.get("backends", {}).get("audio_separator", {})
        return (
            model.get("availability", {}).get("state") == "public_weights"
            and backend.get("state") == "listed"
            and isinstance(backend.get("model_filename"), str)
        )

    @classmethod
    def _convert(cls, payload: dict) -> dict:
        if payload.get("schema") != 3 or not isinstance(payload.get("models"), list):
            raise ValueError("Unsupported model registry schema")
        source_models = {model["id"]: model for model in payload["models"]}
        models: dict[str, dict] = {}
        recommendations: dict[str, str] = {}
        for task, recommendation in payload.get("recommendations", {}).items():
            candidate_ids = [recommendation.get("model")]
            candidate_ids.extend(item.get("model") for item in recommendation.get("alternatives", []))
            selected = next(
                (source_models.get(model_id) for model_id in candidate_ids if model_id in source_models and cls._compatible(source_models[model_id])),
                None,
            )
            if not selected:
                continue
            backend = selected["backends"]["audio_separator"]
            stems = [stem for stem in selected.get("tasks", []) if stem in APP_STEMS]
            if not stems:
                continue
            models[selected["id"]] = {
                "name": selected["name"],
                "filename": backend["model_filename"],
                "stems": stems,
                "license": selected.get("availability", {}).get("license", "unknown"),
                "status": selected.get("status", "unknown"),
            }
            recommendations[task] = selected["id"]
        if not models:
            raise ValueError("Registry has no audio-separator-compatible recommendations")
        return {
            "generatedAt": payload.get("generated_at"),
            "source": "HAGerox/Stem-Separator-Models",
            "models": models,
            "recommendations": recommendations,
        }

    def refresh(self, force: bool = False) -> bool:
        now = time.time()
        if not force and now - self.last_checked < REFRESH_SECONDS:
            return self.remote
        self.last_checked = now
        headers = {"Accept": "application/json", "User-Agent": "Stem-Separator-Server"}
        if self.etag:
            headers["If-None-Match"] = self.etag
        request = urllib.request.Request(REGISTRY_URL, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.load(response)
                catalog = self._convert(payload)
                self.cache_file.parent.mkdir(parents=True, exist_ok=True)
                self.cache_file.write_text(json.dumps(payload, indent=2) + "\n")
                self.etag = response.headers.get("ETag")
                self.meta_file.write_text(json.dumps({"etag": self.etag}) + "\n")
                self.catalog = catalog
                self.remote = True
        except urllib.error.HTTPError as error:
            if error.code != 304:
                return self.remote
        except (OSError, ValueError, TypeError, KeyError):
            return self.remote
        return self.remote

    def stems(self) -> list[str]:
        recommended = self.catalog["recommendations"]
        return sorted(stem for stem in APP_STEMS if stem in recommended)

    def plan(self, selected: list[str]) -> list[ModelChoice]:
        complete_mix = ["vocals", "drums", "bass", "guitar", "piano", "other"]
        task = "multitrack_6" if set(selected) == set(complete_mix) else None
        recommendation_ids = self.catalog["recommendations"]
        models = self.catalog["models"]
        if task and task in recommendation_ids:
            model_id = recommendation_ids[task]
            model = models[model_id]
            return [ModelChoice(model_id, model["name"], model["filename"], tuple(selected))]

        uncovered = set(selected)
        result: list[ModelChoice] = []
        while uncovered:
            stem = next(value for value in selected if value in uncovered)
            model_id = recommendation_ids.get(stem)
            if not model_id or model_id not in models:
                raise ValueError(f"No compatible recommended model is available for {stem}.")
            model = models[model_id]
            covered = tuple(value for value in model["stems"] if value in uncovered)
            if not covered:
                raise ValueError(f"The recommended model for {stem} does not expose that stem.")
            result.append(ModelChoice(model_id, model["name"], model["filename"], covered))
            uncovered.difference_update(covered)
        return result

    def payload(self) -> dict:
        return {
            "remote": self.remote,
            "source": self.catalog["source"],
            "generatedAt": self.catalog["generatedAt"],
            "stems": self.stems(),
            "models": list(self.catalog["models"].values()),
        }
