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
    "https://raw.githubusercontent.com/HAGerox/Stem-Separator-Models/main/product-catalog.json",
)
REFRESH_SECONDS = int(os.getenv("STEM_SEPARATOR_MODEL_REGISTRY_REFRESH_SECONDS", "21600"))
MAX_CACHE_AGE_SECONDS = int(os.getenv("STEM_SEPARATOR_MODEL_REGISTRY_MAX_CACHE_AGE_SECONDS", str(30 * 24 * 60 * 60)))

EMPTY_CATALOG = {
    "generatedAt": None,
    "source": "model registry unavailable",
    "models": {},
    "recommendations": {},
    "capabilities": {},
    "productProfile": {"promoted": [], "browseKinds": ["stem", "complement"]},
}


@dataclass(frozen=True)
class ModelArtifact:
    name: str
    url: str
    sha256: str


@dataclass(frozen=True)
class OutputBinding:
    capability: str
    runtime_key: str


@dataclass(frozen=True)
class ModelChoice:
    id: str
    name: str
    filename: str
    stems: tuple[str, ...]
    artifacts: tuple[ModelArtifact, ...] = ()
    bindings: tuple[OutputBinding, ...] = ()

    def runtime_key(self, capability: str) -> str:
        return next(binding.runtime_key for binding in self.bindings if binding.capability == capability)


class ModelRegistry:
    def __init__(self, cache_root: Path):
        self.cache_file = cache_root / "model-registry.json"
        self.meta_file = cache_root / "model-registry-meta.json"
        self.catalog = EMPTY_CATALOG
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
            self.catalog = EMPTY_CATALOG

    @staticmethod
    def _artifacts(model: dict) -> list[dict]:
        return ModelRegistry._valid_artifacts(model.get("availability", {}).get("artifacts", []))

    @staticmethod
    def _valid_artifacts(source: object) -> list[dict]:
        if not isinstance(source, list):
            return []
        return [
            artifact
            for artifact in source
            if isinstance(artifact, dict)
            and isinstance(artifact.get("name"), str)
            and ModelRegistry._valid_model_filename(artifact["name"])
            and isinstance(artifact.get("url"), str)
            and artifact["url"].startswith("https://")
            and isinstance(artifact.get("sha256"), str)
            and len(artifact["sha256"]) == 64
            and all(character in "0123456789abcdefABCDEF" for character in artifact["sha256"])
        ]

    @staticmethod
    def _ready_audio_separator_contract(contracts: object, capability: str) -> dict | None:
        if not isinstance(contracts, list):
            return None
        for contract in contracts:
            if (
                not isinstance(contract, dict)
                or contract.get("id") != "audio_separator"
                or contract.get("ready") is not True
                or contract.get("stable") is not True
                or not isinstance(contract.get("reference"), str)
                or not ModelRegistry._valid_model_filename(contract["reference"])
            ):
                continue
            outputs = contract.get("outputs", [])
            matching = [
                item for item in outputs
                if isinstance(item, dict)
                and item.get("capability") == capability
                and isinstance(item.get("runtime_key"), str)
                and ModelRegistry._valid_output_identifier(item["runtime_key"])
            ]
            if len(matching) == 1:
                return contract
        return None

    @staticmethod
    def _valid_output_identifier(value: str) -> bool:
        return (
            bool(value)
            and value == value.strip()
            and not any(character in value for character in ("/", "\\", "\0"))
            and not any(ord(character) < 32 or ord(character) == 127 for character in value)
        )

    @staticmethod
    def _valid_model_filename(value: str) -> bool:
        path = Path(value)
        return bool(value) and path.name == value and len(path.parts) == 1

    @classmethod
    def _convert_product_catalog(cls, payload: dict) -> dict:
        source_models = payload.get("models", {})
        capabilities_source = payload.get("capabilities", [])
        if not isinstance(source_models, dict) or not isinstance(capabilities_source, list):
            raise ValueError("Invalid product catalogue")

        models: dict[str, dict] = {}
        recommendations: dict[str, str] = {}
        capabilities: dict[str, dict] = {}

        def add_contract(model_id: str, capability: str, contract: dict) -> bool:
            source_model = source_models.get(model_id)
            if not isinstance(source_model, dict):
                return False
            output = next(
                item for item in contract["outputs"]
                if isinstance(item, dict) and item.get("capability") == capability
            )
            filename = contract["reference"]
            existing = models.get(model_id)
            if existing and existing["filename"] != filename:
                return False
            backend = source_model.get("backends", {}).get("audio_separator", {})
            artifacts = cls._valid_artifacts(contract.get("artifacts", []))
            if not artifacts and isinstance(backend, dict):
                artifacts = cls._valid_artifacts(backend.get("artifacts", []))
            if not artifacts:
                artifacts = cls._artifacts(source_model)
            model = models.setdefault(model_id, {
                "name": source_model.get("name", model_id),
                "filename": filename,
                "stems": [],
                "bindings": {},
                "license": (
                    source_model.get("availability", {}).get("license", "unknown")
                    if isinstance(source_model.get("availability"), dict) else "unknown"
                ),
                "status": source_model.get("status", "unknown"),
                "artifacts": artifacts,
                "runtimeValidated": True,
            })
            if capability not in model["bindings"]:
                model["stems"].append(capability)
            model["bindings"][capability] = output["runtime_key"]
            return True

        for entry in capabilities_source:
            if not isinstance(entry, dict) or entry.get("available") is not True:
                continue
            capability = entry.get("id")
            recommendation = entry.get("recommendation", {})
            model_id = recommendation.get("model") if isinstance(recommendation, dict) else None
            if (
                not isinstance(capability, str)
                or not cls._valid_output_identifier(capability)
                or not isinstance(model_id, str)
            ):
                continue
            contract = cls._ready_audio_separator_contract(entry.get("backends"), capability)
            if contract is None or not add_contract(model_id, capability, contract):
                continue
            capabilities[capability] = {
                "id": capability,
                "label": entry.get("label") or capability.replace("_", " ").title(),
                "kind": entry.get("kind", "stem"),
                "group": entry.get("group", "other"),
                "family": entry.get("group", "other"),
            }
            recommendations[capability] = model_id

        multitrack = payload.get("multitrack")
        if isinstance(multitrack, dict) and multitrack.get("available") is True:
            recommendation = multitrack.get("recommendation", {})
            decomposition = multitrack.get("decomposition", {})
            model_id = recommendation.get("model") if isinstance(recommendation, dict) else None
            outputs = decomposition.get("outputs", []) if isinstance(decomposition, dict) else []
            contracts = multitrack.get("output_backends", {})
            accepted = isinstance(model_id, str) and isinstance(outputs, list) and bool(outputs)
            selected_contracts: list[tuple[str, dict]] = []
            for capability in outputs if accepted else []:
                choices = contracts.get(capability) if isinstance(contracts, dict) else None
                contract = cls._ready_audio_separator_contract(choices, capability)
                if (
                    not isinstance(capability, str)
                    or not cls._valid_output_identifier(capability)
                    or contract is None
                ):
                    accepted = False
                    break
                selected_contracts.append((capability, contract))
            if accepted and len({contract["reference"] for _, contract in selected_contracts}) != 1:
                accepted = False
            if accepted:
                accepted = all(
                    add_contract(model_id, capability, contract)
                    for capability, contract in selected_contracts
                )
            if accepted:
                recommendations["multitrack"] = model_id

        if not capabilities and "multitrack" not in recommendations:
            raise ValueError("Product catalogue has no ready audio-separator outputs")
        promoted = payload.get("promoted", [])
        groups = payload.get("groups", [])
        return {
            "generatedAt": payload.get("generated_at"),
            "source": "HAGerox/Stem-Separator-Models product catalogue",
            "models": models,
            "recommendations": recommendations,
            "capabilities": capabilities,
            "productProfile": {
                "promoted": [item for item in promoted if isinstance(item, str) and item in capabilities],
                "browseKinds": ["stem", "complement"],
                "groups": [item for item in groups if isinstance(item, str)],
                "policy": payload.get("policy"),
            },
        }

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
            and backend.get("state") == "validated"
            and backend.get("validated") is True
            and (
                (
                    isinstance(backend.get("model_filename"), str)
                    and cls._valid_model_filename(backend["model_filename"])
                )
                or (direct_filename is not None and has_config)
            )
        )

    @staticmethod
    def _output_bindings(model: dict) -> dict[str, str]:
        """Return registry-declared capability -> exact runtime output identifiers.

        Runtime identifiers deliberately are not normalized or inferred. In
        particular, this is where a registry can explicitly say that the
        capability ``hihat`` is emitted by audio-separator as ``hh``.
        """
        backend = model.get("backends", {}).get("audio_separator", {})
        outputs = backend.get("outputs")
        if not isinstance(outputs, list):
            return {}
        bindings: dict[str, str] = {}
        for output in outputs:
            if isinstance(output, dict):
                capability = output.get("capability")
                runtime_key = output.get("runtime_key")
            else:
                continue
            if (
                isinstance(capability, str)
                and ModelRegistry._valid_output_identifier(capability)
                and isinstance(runtime_key, str)
                and ModelRegistry._valid_output_identifier(runtime_key)
            ):
                bindings[capability] = runtime_key
        return bindings

    @staticmethod
    def _capabilities(payload: dict) -> dict[str, dict]:
        source = payload.get("capabilities", {})
        if isinstance(source, list):
            source = {
                item.get("id"): item
                for item in source
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
        if not isinstance(source, dict):
            return {}
        return {
            capability_id: {
                "id": capability_id,
                "label": metadata.get("label") or capability_id.replace("_", " ").title(),
                "kind": metadata.get("kind", "stem"),
                "group": metadata.get("group", metadata.get("family", "other")),
                "family": metadata.get("family", metadata.get("group", "other")),
            }
            for capability_id, metadata in source.items()
            if isinstance(capability_id, str) and capability_id and isinstance(metadata, dict)
        }

    @staticmethod
    def _product_profile(payload: dict) -> dict:
        profiles = payload.get("product_profiles", {})
        profile = profiles.get("stem_separator", {}) if isinstance(profiles, dict) else {}
        if not isinstance(profile, dict):
            profile = {}
        promoted = profile.get("promoted", [])
        browse_kinds = profile.get("browse_kinds", ["stem", "complement"])
        return {
            "promoted": [item for item in promoted if isinstance(item, str)],
            "browseKinds": [item for item in browse_kinds if isinstance(item, str)],
        }

    @classmethod
    def _convert(cls, payload: dict) -> dict:
        if payload.get("schema") == 1 and isinstance(payload.get("capabilities"), list):
            return cls._convert_product_catalog(payload)
        if payload.get("schema") not in {3, 4} or not isinstance(payload.get("models"), list):
            raise ValueError("Unsupported model registry schema")
        source_models = {model["id"]: model for model in payload["models"]}
        models: dict[str, dict] = {}
        recommendations: dict[str, str] = {}
        declared_capabilities = cls._capabilities(payload)
        profile = cls._product_profile(payload)
        for task, recommendation in payload.get("recommendations", {}).items():
            if not isinstance(recommendation, dict):
                continue
            candidate_ids = [recommendation.get("model")]
            candidate_ids.extend(
                item.get("model")
                for item in recommendation.get("alternatives", [])
                if isinstance(item, dict)
            )
            selected = next(
                (
                    source_models.get(model_id)
                    for model_id in candidate_ids
                    if model_id in source_models
                    and cls._compatible(source_models[model_id])
                    and (
                        task in cls._output_bindings(source_models[model_id])
                        or (task.startswith("multitrack") and bool(cls._output_bindings(source_models[model_id])))
                    )
                ),
                None,
            )
            if not selected:
                continue
            backend = selected.get("backends", {}).get("audio_separator", {})
            filename = cls._direct_filename(selected) or backend.get("model_filename")
            if not filename:
                continue
            bindings = cls._output_bindings(selected)
            if not bindings:
                continue
            models[selected["id"]] = {
                "name": selected["name"],
                "filename": filename,
                "stems": list(bindings),
                "bindings": bindings,
                "license": selected.get("availability", {}).get("license", "unknown"),
                "status": selected.get("status", "unknown"),
                "artifacts": cls._artifacts(selected),
            }
            recommendations[task] = selected["id"]
        if not models:
            raise ValueError("Registry has no audio-separator-compatible recommendations")
        if declared_capabilities:
            browse_kinds = set(profile["browseKinds"])
            capabilities = {
                capability_id: metadata
                for capability_id, metadata in declared_capabilities.items()
                if metadata["kind"] in browse_kinds and capability_id in recommendations
            }
        else:
            capabilities = {
                capability_id: {
                    "id": capability_id,
                    "label": capability_id.replace("_", " ").title(),
                    "kind": "stem",
                    "group": "other",
                    "family": "other",
                }
                for capability_id in recommendations
                if not capability_id.startswith("multitrack")
            }
        profile["promoted"] = [item for item in profile["promoted"] if item in capabilities]
        return {
            "generatedAt": payload.get("generated_at"),
            "source": "HAGerox/Stem-Separator-Models",
            "models": models,
            "recommendations": recommendations,
            "capabilities": capabilities,
            "productProfile": profile,
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
        return sorted(self.catalog.get("capabilities", {}))

    def recommended_multitrack(self) -> tuple[str, dict] | None:
        recommendations = self.catalog["recommendations"]
        models = self.catalog["models"]
        preferred_id = recommendations.get("multitrack")
        preferred = models.get(preferred_id) if preferred_id else None
        if preferred_id and preferred:
            return preferred_id, preferred
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
        if multi_track and not multitrack:
            raise ValueError("No compatible Multi-Track model is currently available.")
        if multitrack:
            model_id, model = multitrack
            if set(selected) != set(model["stems"]):
                raise ValueError("The Multi-Track stem selection does not match the recommended model.")
            artifacts = tuple(ModelArtifact(**artifact) for artifact in model.get("artifacts", []))
            bindings = tuple(OutputBinding(stem, model["bindings"][stem]) for stem in model["stems"])
            return [ModelChoice(model_id, model["name"], model["filename"], tuple(model["stems"]), artifacts, bindings)]

        result: list[ModelChoice] = []
        result_index: dict[str, int] = {}
        for stem in selected:
            model_id = recommendation_ids.get(stem)
            if not model_id or model_id not in models:
                raise ValueError(f"No compatible recommended model is available for {stem}.")
            model = models[model_id]
            if stem not in model.get("bindings", {}):
                raise ValueError(f"The recommended model for {stem} does not expose that stem.")
            if model_id in result_index:
                index = result_index[model_id]
                current = result[index]
                result[index] = ModelChoice(
                    current.id, current.name, current.filename, (*current.stems, stem), current.artifacts,
                    (*current.bindings, OutputBinding(stem, model["bindings"][stem])),
                )
                continue
            artifacts = tuple(ModelArtifact(**artifact) for artifact in model.get("artifacts", []))
            result_index[model_id] = len(result)
            result.append(ModelChoice(
                model_id, model["name"], model["filename"], (stem,), artifacts,
                (OutputBinding(stem, model["bindings"][stem]),),
            ))
        return result

    def payload(self) -> dict:
        models = [
            {
                "id": model_id,
                "filename": model["filename"],
                "name": model["name"],
                "architecture": "audio-separator",
                "stems": model["stems"],
                "outputs": [
                    {"capability": capability, "runtimeKey": runtime_key}
                    for capability, runtime_key in model.get("bindings", {}).items()
                ],
                "quality": 96 if model.get("status") == "current" else 94 if model.get("status") == "specialist" else 86,
                "speed": 50,
                "memory": "high",
                "note": "Selected from the capability-aware server model registry.",
                "source": self.catalog["source"],
                "license": model.get("license"),
                "status": model.get("status"),
                "runtimeValidated": model.get("runtimeValidated", True),
                "artifacts": model.get("artifacts", []),
            }
            for model_id, model in self.catalog["models"].items()
        ]
        multitrack = self.recommended_multitrack()
        return {
            "remote": self.remote,
            "source": self.catalog["source"],
            "generatedAt": self.catalog["generatedAt"],
            "stems": self.stems(),
            "capabilities": list(self.catalog.get("capabilities", {}).values()),
            "productProfile": self.catalog.get("productProfile", {}),
            "multiTrack": (
                {"modelId": multitrack[0], "stems": multitrack[1]["stems"]}
                if multitrack else None
            ),
            "models": models,
            "catalog": {
                "schemaVersion": 1,
                "generatedAt": self.catalog["generatedAt"],
                "sourceLabel": f"{self.catalog['source']} · server-compatible recommendations",
                "models": models,
                "recommendations": self.catalog["recommendations"],
            },
        }
