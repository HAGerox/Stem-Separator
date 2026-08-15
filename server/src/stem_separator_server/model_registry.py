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
        "becruily-deux": {
            "name": "Becruily Deux",
            "filename": "becruily_deux.ckpt",
            "stems": ["vocals", "instrumental"],
            "license": "CC-BY-NC-4.0",
            "status": "current",
            "artifacts": [
                {
                    "name": "becruily_deux.ckpt",
                    "url": "https://huggingface.co/becruily/mel-band-roformer-deux/resolve/2da74427d682a3df47a774378fc24d7a1a0cdaad/becruily_deux.ckpt",
                    "sha256": "10255c02295bf3e3865d4ee50ff752d7b19b124ed5fd93b147babc4333eda3aa",
                },
                {
                    "name": "config_deux_becruily.yaml",
                    "url": "https://huggingface.co/becruily/mel-band-roformer-deux/resolve/2da74427d682a3df47a774378fc24d7a1a0cdaad/config_deux_becruily.yaml",
                    "sha256": "bb3ea9bce37ca96d63568490d5a92d7e41df3d7726788b6970c10d89eb62d902",
                },
            ],
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
        "vocals": "becruily-deux",
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
class ModelArtifact:
    name: str
    url: str
    sha256: str


@dataclass(frozen=True)
class ModelChoice:
    id: str
    name: str
    filename: str
    stems: tuple[str, ...]
    artifacts: tuple[ModelArtifact, ...] = ()


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
    def _artifacts(model: dict) -> list[dict]:
        return [
            artifact
            for artifact in model.get("availability", {}).get("artifacts", [])
            if isinstance(artifact, dict)
            and isinstance(artifact.get("name"), str)
            and bool(artifact["name"])
            and isinstance(artifact.get("url"), str)
            and artifact["url"].startswith("https://")
            and isinstance(artifact.get("sha256"), str)
            and len(artifact["sha256"]) == 64
            and all(character in "0123456789abcdefABCDEF" for character in artifact["sha256"])
        ]

    @classmethod
    def _direct_filename(cls, model: dict) -> str | None:
        return next(
            (
                artifact["name"]
                for artifact in cls._artifacts(model)
                if Path(artifact["name"]).suffix.lower() in {".ckpt", ".pth", ".onnx", ".th"}
            ),
            None,
        )

    @classmethod
    def _compatible(cls, model: dict) -> bool:
        backend = model.get("backends", {}).get("audio_separator", {})
        direct_filename = cls._direct_filename(model)
        has_config = any(Path(artifact["name"]).suffix.lower() in {".yaml", ".yml"} for artifact in cls._artifacts(model))
        return (
            model.get("availability", {}).get("state") == "public_weights"
            and (
                (
                    backend.get("state") == "listed"
                    and isinstance(backend.get("model_filename"), str)
                    and bool(backend["model_filename"])
                )
                or (direct_filename is not None and has_config)
            )
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
            backend = selected.get("backends", {}).get("audio_separator", {})
            filename = cls._direct_filename(selected) or backend.get("model_filename")
            if not filename:
                continue
            stems = [stem for stem in selected.get("tasks", []) if stem in APP_STEMS]
            if not stems:
                continue
            models[selected["id"]] = {
                "name": selected["name"],
                "filename": filename,
                "stems": stems,
                "license": selected.get("availability", {}).get("license", "unknown"),
                "status": selected.get("status", "unknown"),
                "artifacts": cls._artifacts(selected),
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

    def recommended_multitrack(self) -> tuple[str, dict] | None:
        recommendations = self.catalog["recommendations"]
        models = self.catalog["models"]
        candidates = []
        for task in ("multitrack_6", "multitrack_4"):
            model_id = recommendations.get(task)
            model = models.get(model_id) if model_id else None
            if model:
                candidates.append((model_id, model))
        return max(candidates, key=lambda item: len(item[1]["stems"]), default=None)

    def plan(self, selected: list[str], multi_track: bool = False) -> list[ModelChoice]:
        recommendation_ids = self.catalog["recommendations"]
        models = self.catalog["models"]
        multitrack = self.recommended_multitrack() if multi_track else None
        if multitrack:
            model_id, model = multitrack
            if set(selected) != set(model["stems"]):
                raise ValueError("The Multi-Track stem selection does not match the recommended model.")
            artifacts = tuple(ModelArtifact(**artifact) for artifact in model.get("artifacts", []))
            return [ModelChoice(model_id, model["name"], model["filename"], tuple(model["stems"]), artifacts)]

        result: list[ModelChoice] = []
        result_index: dict[str, int] = {}
        for stem in selected:
            model_id = recommendation_ids.get(stem)
            if not model_id or model_id not in models:
                raise ValueError(f"No compatible recommended model is available for {stem}.")
            model = models[model_id]
            if stem not in model["stems"]:
                raise ValueError(f"The recommended model for {stem} does not expose that stem.")
            if model_id in result_index:
                index = result_index[model_id]
                current = result[index]
                result[index] = ModelChoice(current.id, current.name, current.filename, (*current.stems, stem), current.artifacts)
                continue
            artifacts = tuple(ModelArtifact(**artifact) for artifact in model.get("artifacts", []))
            result_index[model_id] = len(result)
            result.append(ModelChoice(model_id, model["name"], model["filename"], (stem,), artifacts))
        return result

    def payload(self) -> dict:
        models = [
            {
                "id": model_id,
                "filename": model["filename"],
                "name": model["name"],
                "architecture": "audio-separator",
                "stems": model["stems"],
                "quality": 96 if model.get("status") == "current" else 94 if model.get("status") == "specialist" else 86,
                "speed": 50,
                "memory": "high",
                "note": "Selected from the capability-aware server model registry.",
                "source": self.catalog["source"],
                "license": model.get("license"),
                "status": model.get("status"),
                "artifacts": model.get("artifacts", []),
            }
            for model_id, model in self.catalog["models"].items()
        ]
        return {
            "remote": self.remote,
            "source": self.catalog["source"],
            "generatedAt": self.catalog["generatedAt"],
            "stems": self.stems(),
            "models": models,
            "catalog": {
                "schemaVersion": 1,
                "generatedAt": self.catalog["generatedAt"],
                "sourceLabel": f"{self.catalog['source']} · server-compatible recommendations",
                "models": models,
                "recommendations": self.catalog["recommendations"],
            },
        }
