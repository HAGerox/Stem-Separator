from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
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
    filename: str
    stems: list[str]
    status: Literal["queued", "running", "complete", "failed"] = "queued"
    stage: str = "Waiting for the GPU"
    detail: str = "The upload is ready to process."
    progress: float = 0.0
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    outputs: list[dict[str, str]] = field(default_factory=list)
    error: str | None = None


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
    payload = asdict(job)
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


async def run_command(command: list[str], job: Job) -> None:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode:
        detail = (stderr or stdout).decode(errors="replace").strip()
        raise RuntimeError(detail[-4000:] or f"audio-separator exited with {process.returncode}")


async def process_job(job_id: str) -> None:
    job = JOBS[job_id]
    job_dir = JOBS_ROOT / job_id
    input_path = job_dir / "input" / job.filename
    output_root = job_dir / "outputs"
    try:
        async with GPU_QUEUE:
            job.status = "running"
            job.stage = "Preparing CUDA separation"
            job.detail = "The server is loading the selected models."
            job.started_at = time.time()
            separation_input = input_path
            if input_path.suffix.lower() in VIDEO_SUFFIXES:
                separation_input = job_dir / "work" / "source-audio.wav"
                separation_input.parent.mkdir(parents=True, exist_ok=True)
                job.stage = "Extracting video audio"
                job.detail = "FFmpeg is preparing a 44.1 kHz WAV soundtrack."
                job.progress = 2.0
                await run_command(
                    [
                        "ffmpeg", "-y", "-i", str(input_path), "-vn", "-map", "0:a:0",
                        "-c:a", "pcm_s24le", "-ar", "44100", str(separation_input),
                    ],
                    job,
                )
            plan = REGISTRY.plan(job.stems)
            for index, model in enumerate(plan):
                run_dir = job_dir / "work" / f"model-{index}"
                run_dir.mkdir(parents=True, exist_ok=True)
                covered = list(model.stems)
                job.stage = f"Separating {' + '.join(stem.title() for stem in covered)}"
                job.detail = f"{model.name} · CUDA worker"
                job.progress = 5 + (index / max(len(plan), 1)) * 80
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
                await run_command(command, job)

            output_root.mkdir(parents=True, exist_ok=True)
            source_base = Path(job.filename).stem
            for stem in job.stems:
                model_index = next(index for index, model in enumerate(plan) if stem in model.stems)
                source = matching_output(job_dir / "work" / f"model-{model_index}", stem)
                if not source:
                    raise RuntimeError(f"The selected model did not return a {stem} WAV file.")
                target = output_root / f"{source_base}_{stem}.wav"
                shutil.copy2(source, target)
                job.outputs.append({"name": target.name, "stem": stem})

            archive = job_dir / f"stem-separator-{job.id}.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
                for output in output_root.iterdir():
                    bundle.write(output, output.name)
            job.status = "complete"
            job.stage = "Your stems are ready"
            job.detail = f"Created {len(job.outputs)} WAV file(s)."
            job.progress = 100.0
            job.finished_at = time.time()
    except Exception as error:
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
    file: UploadFile = File(...),
    stems: str = Form("vocals,instrumental"),
) -> dict:
    filename = safe_name(file.filename or "upload.wav")
    if Path(filename).suffix.lower() not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=400, detail="Unsupported audio or video format.")
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
    await write_upload(file, input_dir / filename)
    job = Job(id=job_id, filename=filename, stems=selected)
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


app.mount("/", StaticFiles(directory=WEB_ROOT, html=True), name="webui")
