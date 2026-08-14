from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, fields as dataclass_fields
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .model_registry import ModelRegistry
from .updater import latest_release, running_in_container

APP_ROOT = Path(__file__).resolve().parent
WEB_ROOT = APP_ROOT / "web"
DATA_ROOT = Path(os.getenv("STEM_SEPARATOR_DATA_DIR", Path.home() / ".local/share/stem-separator-server"))
JOBS_ROOT = DATA_ROOT / "jobs"
MODEL_ROOT = Path(os.getenv("STEM_SEPARATOR_MODEL_DIR", DATA_ROOT / "models"))
SEPARATOR_BIN = os.getenv("AUDIO_SEPARATOR_BIN", "audio-separator")
MAX_UPLOAD_BYTES = int(os.getenv("STEM_SEPARATOR_MAX_UPLOAD_BYTES", str(8 * 1024**3)))
ALLOWED_SUFFIXES = {
    ".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".aiff", ".aif", ".wma",
    ".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi",
}
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}
REGISTRY = ModelRegistry(DATA_ROOT / "registry")


@dataclass
class Job:
    id: str
    filenames: list[str]
    stems: list[str]
    multi_track: bool = False
    status: Literal["queued", "running", "complete", "failed", "cancelled"] = "queued"
    stage: str = "Waiting for the GPU"
    detail: str = "The upload is ready to process."
    progress: float = 0.0
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    phase: Literal["prepare", "download", "separate", "finish", "complete"] = "prepare"
    phase_progress: float = 0.0
    model_name: str | None = None
    model_index: int | None = None
    model_count: int | None = None
    file_index: int = 0
    file_count: int = 1
    outputs: list[dict] = field(default_factory=list)
    error: str | None = None
    process: asyncio.subprocess.Process | None = field(default=None, repr=False)


JOBS: dict[str, Job] = {}
GPU_QUEUE = asyncio.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    JOBS_ROOT.mkdir(parents=True, exist_ok=True)
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(REGISTRY.refresh)
    yield


app = FastAPI(title="Stem Separator Server", version=__version__, lifespan=lifespan)


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "_", Path(value).name).strip(" ._")
    return cleaned or "upload.wav"


def job_payload(job: Job) -> dict:
    payload = {item.name: getattr(job, item.name) for item in dataclass_fields(job) if item.name != "process"}
    payload["filename"] = job.filenames[0] if len(job.filenames) == 1 else f"{len(job.filenames)} files"
    payload["outputs"] = [
        {
            **output,
            "url": f"/api/jobs/{job.id}/outputs/{output['name']}",
        }
        for output in job.outputs
    ]
    payload["downloadUrl"] = f"/api/jobs/{job.id}/download" if job.status == "complete" else None
    return payload


def environment_payload() -> dict:
    torch_cuda = False
    cuda_device = None
    torch_version = None
    try:
        import torch

        torch_version = torch.__version__
        torch_cuda = bool(torch.cuda.is_available())
        if torch_cuda:
            cuda_device = torch.cuda.get_device_name(0)
    except Exception:
        pass

    ort_providers: list[str] = []
    try:
        import onnxruntime

        ort_providers = onnxruntime.get_available_providers()
    except Exception:
        pass

    return {
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
        "separator": shutil.which(SEPARATOR_BIN) is not None,
        "torchVersion": torch_version,
        "torchCuda": torch_cuda,
        "cudaDevice": cuda_device,
        "onnxProviders": ort_providers,
        "cudaReady": torch_cuda,
        "onnxCudaReady": "CUDAExecutionProvider" in ort_providers,
        "dataDirectory": str(DATA_ROOT),
        "modelDirectory": str(MODEL_ROOT),
    }


async def write_upload(upload: UploadFile, target: Path) -> None:
    written = 0
    with target.open("wb") as output:
        while chunk := await upload.read(1024 * 1024):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                output.close()
                target.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="Upload exceeds the configured size limit.")
            output.write(chunk)
    await upload.close()


def matching_output(directory: Path, stem: str) -> Path | None:
    search = re.sub(r"[^a-z0-9]", "", stem.lower())
    matches = [
        path for path in directory.rglob("*")
        if path.is_file()
        and path.suffix.lower() == ".wav"
        and search in re.sub(r"[^a-z0-9]", "", path.name.lower())
    ]
    return sorted(matches)[0] if matches else None


def probe_duration(path: Path) -> float | None:
    try:
        output = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
            check=True,
            capture_output=True,
            text=True,
        )
        value = json.loads(output.stdout).get("format", {}).get("duration")
        return float(value) if value is not None else None
    except (OSError, ValueError, TypeError, json.JSONDecodeError, subprocess.SubprocessError):
        return None


def ensure_running(job: Job) -> None:
    if job.status == "cancelled":
        raise asyncio.CancelledError


async def run_command(
    command: list[str],
    job: Job,
    progress_range: tuple[float, float] | None = None,
    download_watch: Path | None = None,
    separation_stage: str | None = None,
    separation_detail: str | None = None,
) -> None:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    job.process = process
    started = time.monotonic()
    separating_started: float | None = None
    communication = asyncio.create_task(process.communicate())
    try:
        while not communication.done():
            ensure_running(job)
            if progress_range:
                if download_watch is not None and not download_watch.is_file():
                    elapsed = time.monotonic() - started
                    job.phase = "download"
                    job.phase_progress = min(92.0, 2.5 + elapsed * 3.2)
                    job.progress = progress_range[0]
                    await asyncio.sleep(0.7)
                    continue
                if separating_started is None:
                    separating_started = time.monotonic()
                    if separation_stage:
                        job.stage = separation_stage
                    if separation_detail:
                        job.detail = separation_detail
                    job.phase = "separate"
                elapsed = time.monotonic() - separating_started
                local_progress = min(90.0, 0.6 + 0.13 * elapsed + 0.0009 * elapsed * elapsed)
                job.phase_progress = local_progress
                start, end = progress_range
                job.progress = start + (end - start) * local_progress / 100
            await asyncio.sleep(0.7)
        stdout, stderr = await communication
    except asyncio.CancelledError:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        communication.cancel()
        raise
    finally:
        job.process = None
    if process.returncode:
        detail = (stderr or stdout).decode(errors="replace").strip()
        raise RuntimeError(detail[-4000:] or f"audio-separator exited with {process.returncode}")


async def process_job(job_id: str) -> None:
    job = JOBS[job_id]
    job_dir = JOBS_ROOT / job_id
    output_root = job_dir / "outputs"
    try:
        async with GPU_QUEUE:
            ensure_running(job)
            job.status = "running"
            job.started_at = time.time()
            plan = REGISTRY.plan(job.stems, job.multi_track)
            job.model_count = len(plan)
            output_root.mkdir(parents=True, exist_ok=True)
            file_share = 96 / max(len(job.filenames), 1)
            for file_index, filename in enumerate(job.filenames):
                ensure_running(job)
                input_path = job_dir / "input" / filename
                duration = await asyncio.to_thread(probe_duration, input_path)
                file_work = job_dir / "work" / f"file-{file_index}"
                file_work.mkdir(parents=True, exist_ok=True)
                job.file_index = file_index
                file_base = 1 + file_index * file_share
                separation_input = input_path
                if input_path.suffix.lower() in VIDEO_SUFFIXES:
                    separation_input = file_work / "source-audio.wav"
                    job.stage = "Preparing video"
                    job.detail = f"Extracting the soundtrack from {filename}"
                    job.phase = "prepare"
                    job.phase_progress = 4.0
                    job.progress = file_base + file_share * 0.02
                    await run_command(
                        [
                            "ffmpeg", "-y", "-i", str(input_path), "-vn", "-map", "0:a:0?",
                            "-c:a", "pcm_s24le", "-ar", "44100", str(separation_input),
                        ],
                        job,
                    )

                model_region = file_share * 0.92
                model_share = model_region / max(len(plan), 1)
                for index, model in enumerate(plan):
                    ensure_running(job)
                    run_dir = file_work / f"model-{index}"
                    run_dir.mkdir(parents=True, exist_ok=True)
                    covered = list(model.stems)
                    job.stage = f"Separating {' + '.join(stem.title() for stem in covered)}"
                    job.detail = f"{model.name} · running on the CUDA server"
                    model_path = MODEL_ROOT / model.filename
                    downloading = not model_path.is_file()
                    job.phase = "download" if downloading else "separate"
                    if downloading:
                        job.stage = "Downloading model"
                        job.detail = f"{model.name} · needed for {' + '.join(stem.title() for stem in covered)}"
                    job.phase_progress = 0.0
                    job.model_name = model.name
                    job.model_index = index + 1
                    start = file_base + index * model_share
                    end = start + model_share
                    job.progress = start
                    command = [
                        SEPARATOR_BIN,
                        str(separation_input),
                        "--model_filename", model.filename,
                        "--output_format", "WAV",
                        "--sample_rate", "44100",
                        "--output_dir", str(run_dir),
                        "--model_file_dir", str(MODEL_ROOT),
                        "--log_level", "info",
                    ]
                    if os.getenv("STEM_SEPARATOR_TORCH_COMPILE", "0") == "1":
                        command.append("--use_torch_compile")
                    await run_command(
                        command,
                        job,
                        (start, end),
                        download_watch=model_path if downloading else None,
                        separation_stage=f"Separating {' + '.join(stem.title() for stem in covered)}",
                        separation_detail=f"{model.name} · running on the CUDA server",
                    )
                    job.phase_progress = 100.0
                    job.progress = end

                job.stage = "Finishing up"
                job.detail = f"Writing output files for {filename}"
                job.phase = "finish"
                job.phase_progress = 18.0
                job.model_name = None
                job.progress = file_base + file_share * 0.93
                source_base = Path(filename).stem
                source_output = output_root / source_base if len(job.filenames) > 1 else output_root
                source_output.mkdir(parents=True, exist_ok=True)
                for stem_index, stem in enumerate(job.stems):
                    ensure_running(job)
                    model_index = next(index for index, model in enumerate(plan) if stem in model.stems)
                    source = matching_output(file_work / f"model-{model_index}", stem)
                    if not source:
                        raise RuntimeError(f"The selected model did not return a {stem} WAV file.")
                    relative = Path(source_base) / f"{source_base}_{stem}.wav" if len(job.filenames) > 1 else Path(f"{source_base}_{stem}.wav")
                    target = output_root / relative
                    shutil.copy2(source, target)
                    job.outputs.append({
                        "name": relative.as_posix(),
                        "stem": stem,
                        "sourceName": filename,
                        "isVideo": False,
                        "durationSeconds": duration,
                    })
                    if input_path.suffix.lower() in VIDEO_SUFFIXES:
                        video_relative = Path(source_base) / f"{source_base}_{stem}.mp4" if len(job.filenames) > 1 else Path(f"{source_base}_{stem}.mp4")
                        video_target = output_root / video_relative
                        job.stage = f"Creating {stem.title()} video"
                        job.detail = "Replacing the source soundtrack without re-encoding the picture"
                        command = [
                            "ffmpeg", "-y", "-i", str(input_path), "-i", str(target),
                            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
                        ]
                        if duration is not None:
                            command.extend(["-t", f"{duration:.6f}"])
                        command.append(str(video_target))
                        await run_command(command, job)
                        job.outputs.append({
                            "name": video_relative.as_posix(),
                            "stem": stem,
                            "sourceName": filename,
                            "isVideo": True,
                            "durationSeconds": duration,
                        })
                    job.phase_progress = 20 + 75 * (stem_index + 1) / max(len(job.stems), 1)

            output_root.mkdir(parents=True, exist_ok=True)
            archive = job_dir / f"stem-separator-{job.id}.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
                for output in output_root.rglob("*"):
                    if output.is_file():
                        bundle.write(output, output.relative_to(output_root))
            job.status = "complete"
            job.stage = "Your stems are ready"
            job.detail = f"Created {len(job.outputs)} WAV file(s)."
            job.progress = 100.0
            job.phase = "complete"
            job.phase_progress = 100.0
            job.finished_at = time.time()
    except asyncio.CancelledError:
        job.status = "cancelled"
        job.stage = "Separation stopped"
        job.detail = "The current server job was cancelled."
        job.finished_at = time.time()
    except Exception as error:
        if job.status == "cancelled":
            return
        job.status = "failed"
        job.stage = "Separation failed"
        job.detail = "See the job error for technical details."
        job.error = str(error)
        job.finished_at = time.time()


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


@app.get("/api/environment")
async def environment() -> dict:
    return environment_payload()


@app.get("/api/models")
async def models() -> dict:
    await asyncio.to_thread(REGISTRY.refresh)
    return REGISTRY.payload()


@app.get("/api/update")
async def update() -> dict:
    try:
        payload = await asyncio.to_thread(latest_release)
        payload["method"] = "container" if running_in_container() else "native"
        return payload
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Could not check GitHub releases: {error}") from error


@app.get("/api/jobs")
async def list_jobs() -> list[dict]:
    return [job_payload(job) for job in sorted(JOBS.values(), key=lambda value: value.created_at, reverse=True)]


@app.post("/api/jobs", status_code=202)
async def create_job(
    files: list[UploadFile] = File(default=[]),
    file: UploadFile | None = File(default=None),
    stems: str = Form("vocals,instrumental"),
    multi_track: bool = Form(False),
) -> dict:
    if file is not None:
        files = [file, *files]
    if not files:
        raise HTTPException(status_code=400, detail="Choose at least one audio or video file.")
    filenames: list[str] = []
    seen: set[str] = set()
    for upload in files:
        filename = safe_name(upload.filename or "upload.wav")
        if Path(filename).suffix.lower() not in ALLOWED_SUFFIXES:
            raise HTTPException(status_code=400, detail=f"Unsupported audio or video format: {filename}")
        candidate = filename
        counter = 2
        while candidate.lower() in seen:
            source = Path(filename)
            candidate = f"{source.stem}-{counter}{source.suffix}"
            counter += 1
        seen.add(candidate.lower())
        filenames.append(candidate)
    selected = list(dict.fromkeys(value.strip().lower() for value in stems.split(",") if value.strip()))
    await asyncio.to_thread(REGISTRY.refresh)
    supported = set(REGISTRY.stems())
    invalid = [stem for stem in selected if stem not in supported]
    if not selected or invalid:
        raise HTTPException(status_code=400, detail=f"Invalid stem selection: {', '.join(invalid) or 'none'}")

    job_id = uuid.uuid4().hex[:12]
    job_dir = JOBS_ROOT / job_id
    input_dir = job_dir / "input"
    input_dir.mkdir(parents=True, exist_ok=False)
    for upload, filename in zip(files, filenames, strict=True):
        await write_upload(upload, input_dir / filename)
    job = Job(id=job_id, filenames=filenames, stems=selected, multi_track=multi_track, file_count=len(filenames))
    JOBS[job_id] = job
    asyncio.create_task(process_job(job_id))
    return job_payload(job)


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job_payload(job)


@app.get("/api/jobs/{job_id}/download")
async def download_job(job_id: str) -> FileResponse:
    job = JOBS.get(job_id)
    archive = JOBS_ROOT / job_id / f"stem-separator-{job_id}.zip"
    if not job or job.status != "complete" or not archive.is_file():
        raise HTTPException(status_code=404, detail="Completed archive not found.")
    return FileResponse(archive, filename=archive.name, media_type="application/zip")


@app.get("/api/jobs/{job_id}/outputs/{output_name:path}")
async def download_output(job_id: str, output_name: str, download: bool = Query(False)) -> FileResponse:
    job = JOBS.get(job_id)
    root = (JOBS_ROOT / job_id / "outputs").resolve()
    output = (root / output_name).resolve()
    if not job or job.status != "complete" or root not in output.parents or not output.is_file():
        raise HTTPException(status_code=404, detail="Completed output not found.")
    return FileResponse(output, filename=output.name if download else None)


@app.delete("/api/jobs/{job_id}", status_code=202)
async def cancel_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job.status in {"complete", "failed", "cancelled"}:
        return job_payload(job)
    job.status = "cancelled"
    process = job.process
    if process and process.returncode is None:
        process.terminate()
    return job_payload(job)


app.mount("/", StaticFiles(directory=WEB_ROOT, html=True), name="webui")
