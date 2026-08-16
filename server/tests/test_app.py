from __future__ import annotations

import asyncio
import hashlib
import importlib
import io
import zipfile

import pytest


def load_app(tmp_path, monkeypatch):
    monkeypatch.setenv("STEM_SEPARATOR_DATA_DIR", str(tmp_path))
    import stem_separator_server.app as server_app

    return importlib.reload(server_app)


def freeze_registry(server_app, monkeypatch):
    monkeypatch.setattr(server_app.REGISTRY, "refresh", lambda force=False: False)

    async def fake_artifacts(job, model, model_index, model_count):
        server_app.MODEL_ROOT.mkdir(parents=True, exist_ok=True)
        (server_app.MODEL_ROOT / model.filename).write_bytes(b"test-model")

    monkeypatch.setattr(server_app, "ensure_model_artifacts", fake_artifacts)


def test_health_and_environment(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    with TestClient(server_app.app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        payload = client.get("/api/environment").json()
        assert "cudaReady" in payload
        assert payload["dataDirectory"] == str(tmp_path)
        page = client.get("/")
        assert page.status_code == 200
        assert '<div id="root"></div>' in page.text
        assert "CUDA Server" not in page.text


def test_upload_rejects_unsupported_extension(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("notes.txt", b"not audio", "text/plain")},
            data={"stems": "vocals"},
        )
    assert response.status_code == 400


def test_job_processes_and_downloads_archive(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    async def fake_command(command, job, progress_range=None, **kwargs):
        if command[0] == "ffmpeg":
            server_app.Path(command[-1]).write_bytes(b"RIFFextracted")
            return
        output_dir = server_app.Path(command[command.index("--output_dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "track_(Vocals)_model.wav").write_bytes(b"RIFFvocals")
        (output_dir / "track_(Instrumental)_model.wav").write_bytes(b"RIFFinstrumental")

    monkeypatch.setattr(server_app, "run_command", fake_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("track.wav", b"RIFFinput", "audio/wav")},
            data={"stems": "vocals,instrumental"},
        )
        assert response.status_code == 202
        job_id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in {"complete", "failed"}:
                break
            import time

            time.sleep(0.01)
        assert job["status"] == "complete", job
        archive = client.get(job["downloadUrl"])
        assert archive.status_code == 200
        with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
            assert sorted(bundle.namelist()) == ["track_instrumental.wav", "track_vocals.wav"]
        output = client.get(job["outputs"][0]["url"])
        assert output.status_code == 200


def test_video_audio_is_extracted_before_separation(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    commands = []
    monkeypatch.setattr(
        server_app,
        "probe_media",
        lambda path: server_app.MediaInfo(12.5, audio_stream_index=1, video_stream_index=0, inspected=True),
    )

    async def fake_command(command, job, progress_range=None, **kwargs):
        commands.append(command)
        if command[0] == "ffmpeg":
            server_app.Path(command[-1]).write_bytes(b"RIFFextracted")
            return
        output_dir = server_app.Path(command[command.index("--output_dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "clip_(Vocals)_model.wav").write_bytes(b"RIFFvocals")

    monkeypatch.setattr(server_app, "run_command", fake_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("clip.mp4", b"video", "video/mp4")},
            data={"stems": "vocals"},
        )
        job_id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in {"complete", "failed"}:
                break
            import time

            time.sleep(0.01)
    assert job["status"] == "complete", job
    assert commands[0][0] == "ffmpeg"
    assert "0:1" in commands[0]
    assert commands[1][1].endswith("source-audio.wav")
    assert commands[2][commands[2].index("-map") + 1] == "0:0"
    assert [output["isVideo"] for output in job["outputs"]] == [False, True]


def test_audio_only_webm_does_not_attempt_to_create_video(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    commands = []
    monkeypatch.setattr(
        server_app,
        "probe_media",
        lambda path: server_app.MediaInfo(12.5, audio_stream_index=0, inspected=True),
    )

    async def fake_command(command, job, progress_range=None, **kwargs):
        commands.append(command)
        if command[0] == "ffmpeg":
            server_app.Path(command[-1]).write_bytes(b"RIFFextracted")
            return
        output_dir = server_app.Path(command[command.index("--output_dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "song_(Vocals)_model.wav").write_bytes(b"RIFFvocals")

    monkeypatch.setattr(server_app, "run_command", fake_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("song.webm", b"audio-only", "audio/webm")},
            data={"stems": "vocals"},
        )
        job_id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in {"complete", "failed"}:
                break
            import time

            time.sleep(0.01)

    assert job["status"] == "complete", job
    assert commands[0][commands[0].index("-map") + 1] == "0:0"
    assert all("-c:v" not in command for command in commands)
    assert [output["name"] for output in job["outputs"]] == ["song_vocals.wav"]


def test_probe_media_ignores_embedded_cover_art(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)

    completed = server_app.subprocess.CompletedProcess(
        args=["ffprobe"],
        returncode=0,
        stdout=server_app.json.dumps({
            "streams": [
                {"index": 0, "codec_type": "video", "disposition": {"attached_pic": 1}},
                {"index": 1, "codec_type": "audio", "disposition": {"attached_pic": 0}},
                {"index": 2, "codec_type": "video", "disposition": {"attached_pic": 0}},
            ],
            "format": {"duration": "42.25"},
        }),
        stderr="",
    )
    monkeypatch.setattr(server_app.subprocess, "run", lambda *args, **kwargs: completed)

    media = server_app.probe_media(tmp_path / "clip.mkv")

    assert media.duration == 42.25
    assert media.audio_stream_index == 1
    assert media.video_stream_index == 2
    assert media.inspected is True


def test_model_registry_exposes_only_compatible_stems(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    with TestClient(server_app.app) as client:
        payload = client.get("/api/models").json()
    assert "strings" not in payload["stems"]
    assert set(payload["stems"]) == {
        "vocals", "instrumental", "drums", "bass", "guitar", "piano", "other",
    }


def test_registry_builds_capability_aware_plan(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    plan = server_app.REGISTRY.plan(["vocals", "instrumental"])
    assert [model.filename for model in plan] == ["becruily_deux.ckpt"]
    assert plan[0].stems == ("vocals", "instrumental")
    assert plan[0].artifacts[0].name == "becruily_deux.ckpt"
    payload = server_app.REGISTRY.payload()
    assert payload["catalog"]["schemaVersion"] == 1
    assert payload["catalog"]["recommendations"]["vocals"] == "becruily-deux"


def test_registry_accepts_verified_direct_model_artifacts(tmp_path):
    from stem_separator_server.model_registry import ModelRegistry

    digest = "a" * 64
    converted = ModelRegistry._convert({
        "schema": 3,
        "generated_at": "2026-08-14",
        "models": [{
            "id": "becruily-deux",
            "name": "Becruily Deux",
            "status": "current",
            "tasks": ["vocals", "instrumental"],
            "availability": {
                "state": "public_weights",
                "license": "CC-BY-NC-4.0",
                "artifacts": [
                    {"name": "becruily_deux.ckpt", "url": "https://example.test/model", "sha256": digest},
                    {"name": "config_deux_becruily.yaml", "url": "https://example.test/config", "sha256": digest},
                ],
            },
            "backends": {
                "audio_separator": {
                    "state": "validated",
                    "validated": True,
                    "outputs": [
                        {"runtime_key": "vocals", "capability": "vocals"},
                        {"runtime_key": "instrumental", "capability": "instrumental"},
                    ],
                },
            },
        }],
        "recommendations": {"vocals": {"model": "becruily-deux", "alternatives": []}},
    })
    assert converted["recommendations"]["vocals"] == "becruily-deux"
    assert converted["models"]["becruily-deux"]["filename"] == "becruily_deux.ckpt"
    assert len(converted["models"]["becruily-deux"]["artifacts"]) == 2


def test_pinned_artifacts_are_staged_under_the_runtime_model_names(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    checkpoint = b"checkpoint"
    config = b"config"
    model = server_app.ModelChoice(
        "model", "Model", "runtime-name.ckpt", ("vocals",),
        (
            server_app.ModelArtifact(
                "upstream-name.ckpt", "https://example.test/checkpoint",
                hashlib.sha256(checkpoint).hexdigest(),
            ),
            server_app.ModelArtifact(
                "upstream-config.yaml", "https://example.test/config",
                hashlib.sha256(config).hexdigest(),
            ),
        ),
    )
    content = {"upstream-name.ckpt": checkpoint, "upstream-config.yaml": config}

    def fake_download(artifact, progress):
        target = server_app.MODEL_ROOT / artifact.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content[artifact.name])
        progress(1.0)
        return target

    monkeypatch.setattr(server_app, "download_artifact", fake_download)
    job = server_app.Job("job", ["track.wav"], ["vocals"])
    asyncio.run(server_app.ensure_model_artifacts(job, model, 1, 1))

    assert (server_app.MODEL_ROOT / "runtime-name.ckpt").read_bytes() == checkpoint
    assert (server_app.MODEL_ROOT / "runtime-name.yaml").read_bytes() == config
    assert server_app.model_artifacts_ready(model) is True


def test_registry_uses_dynamic_typed_capabilities_and_exact_bindings():
    from stem_separator_server.model_registry import ModelRegistry

    converted = ModelRegistry._convert({
        "schema": 3,
        "generated_at": "2026-08-16",
        "capabilities": {
            "accordion": {"label": "Accordion", "kind": "stem", "family": "instrument"},
            "hihat": {"label": "Hi-hat", "kind": "stem", "family": "drums"},
            "denoise": {"label": "Denoise", "kind": "transform", "family": "restoration"},
        },
        "product_profiles": {
            "stem_separator": {
                "promoted": ["accordion"],
                "browse_kinds": ["stem", "complement"],
            },
        },
        "models": [{
            "id": "dynamic-model",
            "name": "Dynamic model",
            "tasks": ["accordion", "hihat", "denoise"],
            "availability": {"state": "public_weights", "artifacts": []},
            "backends": {
                "audio_separator": {
                    "state": "validated",
                    "validated": True,
                    "model_filename": "dynamic.ckpt",
                    "outputs": [
                        {"runtime_key": "accordion", "capability": "accordion"},
                        {"runtime_key": "hh", "capability": "hihat"},
                        {"runtime_key": "noise", "capability": "denoise"},
                    ],
                },
            },
        }],
        "recommendations": {
            capability: {"model": "dynamic-model", "alternatives": []}
            for capability in ("accordion", "hihat", "denoise")
        },
    })

    registry = object.__new__(ModelRegistry)
    registry.catalog = converted
    assert registry.stems() == ["accordion", "hihat"]
    assert registry.plan(["hihat"])[0].runtime_key("hihat") == "hh"
    assert converted["productProfile"]["promoted"] == ["accordion"]


def test_server_consumes_only_ready_entries_from_generated_product_catalogue():
    from stem_separator_server.model_registry import ModelRegistry

    def ready_contracts(capability, runtime_key):
        return [{
            "id": "audio_separator",
            "reference": "dynamic.ckpt",
            "state": "validated",
            "validated": True,
            "installable": True,
            "ready": True,
            "stable": True,
            "outputs": [{"runtime_key": runtime_key, "capability": capability}],
            "artifacts": [],
        }]
    converted = ModelRegistry._convert({
        "schema": 1,
        "policy": "stem-separator-v1",
        "generated_at": "2026-08-16",
        "promoted": ["hihat", "denoise"],
        "groups": ["rhythm", "other"],
        "capabilities": [
            {
                "id": "hihat", "label": "Hi-hat", "kind": "stem", "group": "rhythm",
                "available": True,
                "recommendation": {"model": "dynamic-model"},
                "backends": ready_contracts("hihat", "hh"),
            },
            {
                "id": "denoise", "label": "Denoise", "kind": "stem", "group": "other",
                "available": False,
                "recommendation": {"model": "dynamic-model"},
                "backends": [],
            },
        ],
        "multitrack": None,
        "models": {
            "dynamic-model": {
                "name": "Dynamic model",
                "status": "specialist",
                "availability": {"license": "example"},
                "backends": {"audio_separator": {"outputs": []}},
            },
        },
        "readiness": {},
    })

    registry = object.__new__(ModelRegistry)
    registry.catalog = converted
    assert registry.stems() == ["hihat"]
    assert registry.plan(["hihat"])[0].runtime_key("hihat") == "hh"
    assert converted["productProfile"] == {
        "promoted": ["hihat"],
        "browseKinds": ["stem", "complement"],
        "groups": ["rhythm", "other"],
        "policy": "stem-separator-v1",
    }


def test_product_catalogue_rejects_available_but_unstable_contract():
    from stem_separator_server.model_registry import ModelRegistry

    with pytest.raises(ValueError, match="no ready audio-separator outputs"):
        ModelRegistry._convert({
            "schema": 1,
            "generated_at": "2026-08-16",
            "promoted": ["vocals"],
            "groups": ["voice"],
            "capabilities": [{
                "id": "vocals",
                "label": "Vocals",
                "kind": "stem",
                "group": "voice",
                "available": True,
                "recommendation": {"model": "untested"},
                "backends": [{
                    "id": "audio_separator",
                    "reference": "untested.ckpt",
                    "ready": True,
                    "stable": False,
                    "outputs": [{"runtime_key": "vocals", "capability": "vocals"}],
                    "artifacts": [],
                }],
            }],
            "models": {"untested": {"name": "Untested", "availability": {}, "backends": {}}},
            "multitrack": None,
        })


def test_output_matching_is_exact_and_uses_runtime_key(tmp_path):
    from stem_separator_server.app import matching_output

    (tmp_path / "song_hihat_(Ride)_model.wav").write_bytes(b"ride")
    hh = tmp_path / "song_(HH)_model.wav"
    hh.write_bytes(b"hh")
    (tmp_path / "song_(Crash)_model.wav").write_bytes(b"crash")

    assert matching_output(tmp_path, "hh") == hh
    assert matching_output(tmp_path, "hihat") is None


def test_background_upload_can_be_promoted_to_a_job(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    async def fake_command(command, job, progress_range=None, **kwargs):
        output_dir = server_app.Path(command[command.index("--output_dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "track_(Vocals)_model.wav").write_bytes(b"RIFFvocals")

    monkeypatch.setattr(server_app, "run_command", fake_command)
    with TestClient(server_app.app) as client:
        created = client.post("/api/uploads")
        assert created.status_code == 201
        upload_id = created.json()["id"]
        uploaded = client.post(
            f"/api/uploads/{upload_id}",
            files={"file": ("track.wav", b"RIFFinput", "audio/wav")},
        )
        assert uploaded.status_code == 200
        assert uploaded.json()["status"] == "complete"
        response = client.post(
            "/api/jobs",
            data={"upload_id": upload_id, "stems": "vocals"},
        )
        assert response.status_code == 202
        job_id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in {"complete", "failed"}:
                break
            import time

            time.sleep(0.01)
    assert job["status"] == "complete", job
    assert not (server_app.UPLOADS_ROOT / upload_id).exists()


def test_multitrack_is_an_explicit_special_case(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    selected = ["vocals", "drums", "bass", "guitar", "piano", "other"]
    individual = server_app.REGISTRY.plan(selected, multi_track=False)
    multitrack = server_app.REGISTRY.plan(selected, multi_track=True)
    assert len(multitrack) == 1
    assert multitrack[0].filename == "BS-Roformer-SW.ckpt"
    assert len(individual) > 1


def test_multitrack_stems_follow_the_recommended_model(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    server_app.REGISTRY.catalog["models"]["compact"] = {
        "name": "Compact Multi-Track",
        "filename": "compact.yaml",
        "stems": ["vocals", "drums", "bass", "other"],
        "bindings": {"vocals": "vocals", "drums": "drums", "bass": "bass", "other": "other"},
    }
    server_app.REGISTRY.catalog["recommendations"]["multitrack"] = "compact"
    selected = server_app.REGISTRY.catalog["models"]["compact"]["stems"]
    multitrack = server_app.REGISTRY.plan(selected, multi_track=True)
    assert len(multitrack) == 1
    assert multitrack[0].filename == "compact.yaml"
    assert multitrack[0].stems == tuple(selected)


def test_multiple_files_are_accepted_and_return_named_outputs(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    async def fake_command(command, job, progress_range=None, **kwargs):
        output_dir = server_app.Path(command[command.index("--output_dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "track_(Vocals)_model.wav").write_bytes(b"RIFFvocals")

    monkeypatch.setattr(server_app, "run_command", fake_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files=[
                ("files", ("first.wav", b"RIFFone", "audio/wav")),
                ("files", ("second.wav", b"RIFFtwo", "audio/wav")),
            ],
            data={"stems": "vocals"},
        )
        assert response.status_code == 202
        job_id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in {"complete", "failed"}:
                break
            import time

            time.sleep(0.01)
    assert job["status"] == "complete", job
    assert job["file_count"] == 2
    assert {output["sourceName"] for output in job["outputs"]} == {"first.wav", "second.wav"}


def test_model_failure_preserves_successful_requested_outputs(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    async def partly_failing_command(command, job, progress_range=None, **kwargs):
        if command[0] == "ffmpeg":
            return
        if command[command.index("--model_filename") + 1] == "BS-Roformer-SW.ckpt":
            raise RuntimeError("synthetic bass model failure")
        output_dir = server_app.Path(command[command.index("--output_dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "track_(Vocals)_model.wav").write_bytes(b"RIFFvocals")
        # An unrequested raw output must never leak into the delivered files.
        (output_dir / "track_(Instrumental)_model.wav").write_bytes(b"RIFFinstrumental")

    monkeypatch.setattr(server_app, "run_command", partly_failing_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("track.wav", b"RIFFinput", "audio/wav")},
            data={"stems": "vocals,bass"},
        )
        job_id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in {"complete", "failed"}:
                break
            import time

            time.sleep(0.01)

    assert job["status"] == "complete", job
    assert [output["stem"] for output in job["outputs"]] == ["vocals"]
    assert job["warnings"]
    assert "warning" in job["detail"].lower()


def test_job_fails_only_when_no_requested_output_is_produced(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    async def failing_command(command, job, progress_range=None, **kwargs):
        raise RuntimeError("synthetic model failure")

    monkeypatch.setattr(server_app, "run_command", failing_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("track.wav", b"RIFFinput", "audio/wav")},
            data={"stems": "vocals"},
        )
        job_id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in {"complete", "failed"}:
                break
            import time

            time.sleep(0.01)

    assert job["status"] == "failed"
    assert job["outputs"] == []
    assert job["warnings"]
    assert job["error"].startswith("No requested outputs could be produced.")


def test_job_can_be_cancelled(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    async def slow_command(command, job, progress_range=None, **kwargs):
        await server_app.asyncio.sleep(0.2)

    monkeypatch.setattr(server_app, "run_command", slow_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("track.wav", b"RIFFinput", "audio/wav")},
            data={"stems": "vocals"},
        )
        job_id = response.json()["id"]
        cancelled = client.delete(f"/api/jobs/{job_id}")
        assert cancelled.status_code == 202
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] == "cancelled":
                break
            import time

            time.sleep(0.01)
    assert job["status"] == "cancelled"
