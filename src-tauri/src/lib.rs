use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;
use tokio::{process::Command as TokioCommand, time};
use walkdir::WalkDir;

const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "mp3", "flac", "m4a", "aac", "ogg", "opus", "aiff", "aif", "wma",
];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "mkv", "webm", "m4v", "avi"];
const AUDIO_SEPARATOR_FORK: &str = "audio-separator[cpu] @ git+https://github.com/HAGerox/python-audio-separator.git@dccdbe5fafa8d2c4274ebf76a3ff1c27bf0c86d3";
static ARTIFACT_DOWNLOAD_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn bundled_resource(command: &str) -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let resources = executable.parent()?.parent()?.join("Resources");
    let candidates = [resources.join("bin").join(command), resources.join(command)];
    candidates.into_iter().find(|path| path.is_file())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EnvironmentStatus {
    is_tauri: bool,
    ffmpeg_available: bool,
    ffprobe_available: bool,
    separator_available: bool,
    uv_available: bool,
    engine_label: String,
    acceleration: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InputFile {
    path: String,
    name: String,
    extension: String,
    duration_seconds: Option<f64>,
    size_bytes: Option<u64>,
    is_video: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModelRun {
    #[allow(dead_code)]
    id: String,
    model_filename: String,
    model_name: String,
    stems: Vec<String>,
    #[serde(default)]
    artifacts: Vec<ModelArtifact>,
}

#[derive(Debug, Deserialize, Clone)]
struct ModelArtifact {
    name: String,
    url: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessRequest {
    paths: Vec<String>,
    stems: Vec<String>,
    plan: Vec<ModelRun>,
    keep_video: bool,
    output_directory: Option<String>,
    demo_mode: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    job_id: String,
    overall: f64,
    file_index: usize,
    file_count: usize,
    stage: String,
    detail: String,
    model_name: Option<String>,
    model_index: Option<usize>,
    model_count: Option<usize>,
    eta_seconds: Option<u64>,
    phase: String,
    phase_progress: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputStem {
    path: String,
    name: String,
    stem: String,
    source_name: String,
    is_video: bool,
    duration_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessResult {
    job_id: String,
    output_directory: String,
    outputs: Vec<OutputStem>,
    warnings: Vec<String>,
    used_demo_mode: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    configured: bool,
    available: bool,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Clone)]
struct EngineCommand {
    program: PathBuf,
    prefix_args: Vec<String>,
    label: String,
}

#[derive(Default)]
struct ActiveJob {
    state: Arc<Mutex<ActiveJobState>>,
}

#[derive(Default)]
struct ActiveJobState {
    job_id: Option<String>,
    pid: Option<u32>,
    cancelled: bool,
}

struct ActiveJobGuard {
    state: Arc<Mutex<ActiveJobState>>,
    job_id: String,
}

struct ActiveProcessGuard {
    state: Arc<Mutex<ActiveJobState>>,
    job_id: String,
    pid: u32,
}

impl Drop for ActiveJobGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.lock() {
            if active.job_id.as_ref() == Some(&self.job_id) {
                *active = ActiveJobState::default();
            }
        }
    }
}

impl Drop for ActiveProcessGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.lock() {
            if active.job_id.as_ref() == Some(&self.job_id) && active.pid == Some(self.pid) {
                active.pid = None;
            }
        }
    }
}

fn register_active_job(state: &ActiveJob, job_id: &str) -> Result<ActiveJobGuard, String> {
    let mut active = state
        .state
        .lock()
        .map_err(|_| "Could not track the active separation job.".to_string())?;
    if active.job_id.is_some() {
        return Err("A separation job is already running.".into());
    }
    *active = ActiveJobState {
        job_id: Some(job_id.into()),
        pid: None,
        cancelled: false,
    };
    Ok(ActiveJobGuard {
        state: state.state.clone(),
        job_id: job_id.into(),
    })
}

fn ensure_job_running(state: &ActiveJob, job_id: &str) -> Result<(), String> {
    let active = state
        .state
        .lock()
        .map_err(|_| "Could not check the active separation job.".to_string())?;
    if active.job_id.as_deref() == Some(job_id) && active.cancelled {
        Err("Separation stopped.".into())
    } else {
        Ok(())
    }
}

fn register_active_process(
    state: &ActiveJob,
    job_id: &str,
    pid: u32,
) -> Result<ActiveProcessGuard, String> {
    let mut active = state
        .state
        .lock()
        .map_err(|_| "Could not track the active separation process.".to_string())?;
    if active.job_id.as_deref() != Some(job_id) {
        return Err("The separation job is no longer active.".into());
    }
    if active.cancelled {
        drop(active);
        let _ = stop_process_tree(pid);
        return Err("Separation stopped.".into());
    }
    active.pid = Some(pid);
    Ok(ActiveProcessGuard {
        state: state.state.clone(),
        job_id: job_id.into(),
        pid,
    })
}

#[cfg(unix)]
fn stop_process_tree(pid: u32) -> Result<(), String> {
    let group_id = -(pid as i32);
    let result = unsafe { libc::kill(group_id, libc::SIGTERM) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(windows)]
fn stop_process_tree(pid: u32) -> Result<(), String> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|error| format!("Could not stop the separation process: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Windows could not stop the separation process.".into())
    }
}

fn command_path(command: &str) -> Option<PathBuf> {
    if let Some(path) = bundled_resource(command) {
        return Some(path);
    }
    if let Ok(path) = which::which(command) {
        return Some(path);
    }
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin").join(command),
        PathBuf::from("/usr/local/bin").join(command),
        PathBuf::from("/usr/bin").join(command),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin").join(command));
        candidates.push(home.join(".cargo/bin").join(command));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn available(command: &str) -> bool {
    command_path(command).is_some()
}

fn separator_engine() -> Option<EngineCommand> {
    if let Some(path) = command_path("audio-separator") {
        return Some(EngineCommand {
            program: path,
            prefix_args: Vec::new(),
            label: "Audio Separator · bundled HAGerox PR 298 + 299".into(),
        });
    }
    if let Some(path) = command_path("uvx") {
        return Some(EngineCommand {
            program: path,
            prefix_args: vec![
                "--python".into(),
                "3.12".into(),
                "--with".into(),
                "audioread".into(),
                "--with".into(),
                "librosa<0.11".into(),
                "--from".into(),
                AUDIO_SEPARATOR_FORK.into(),
                "audio-separator".into(),
            ],
            label: "Audio Separator · HAGerox PR 298 + 299".into(),
        });
    }
    None
}

#[tauri::command]
fn detect_environment() -> EnvironmentStatus {
    let uv = available("uvx");
    let bundled_separator = available("audio-separator");
    EnvironmentStatus {
        is_tauri: true,
        ffmpeg_available: available("ffmpeg"),
        ffprobe_available: available("ffprobe"),
        separator_available: uv || bundled_separator,
        uv_available: uv,
        engine_label: if bundled_separator {
            "Audio Separator · bundled custom PR 298 + 299 build".into()
        } else if uv {
            "Audio Separator · custom PR 298 + 299 build".into()
        } else {
            "Audio Separator · setup required".into()
        },
        acceleration: if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
            "Apple Silicon · compiled MPS / CoreML".into()
        } else {
            "Local processing".into()
        },
    }
}

fn updater_configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(|value| value.as_str())
        .is_some_and(|key| !key.trim().is_empty() && !key.contains("TAURI_UPDATER_PUBLIC_KEY"))
}

#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    if !updater_configured(&app) {
        return Ok(UpdateInfo {
            configured: false,
            available: false,
            current_version,
            version: None,
            notes: None,
            date: None,
        });
    }
    let update = app
        .updater()
        .map_err(|error| format!("Could not initialize the updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Could not check GitHub for updates: {error}"))?;
    Ok(UpdateInfo {
        configured: true,
        available: update.is_some(),
        current_version,
        version: update.as_ref().map(|value| value.version.to_string()),
        notes: update.as_ref().and_then(|value| value.body.clone()),
        date: update
            .as_ref()
            .and_then(|value| value.date.map(|date| date.to_string())),
    })
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    if !updater_configured(&app) {
        return Err("Automatic updates are not configured in this build.".into());
    }
    let Some(update) = app
        .updater()
        .map_err(|error| format!("Could not initialize the updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Could not check GitHub for updates: {error}"))?
    else {
        return Ok(());
    };
    let _ = app.emit("update-progress", 0_u8);
    let progress_app = app.clone();
    let finished_app = app.clone();
    let mut downloaded_bytes = 0_u64;
    let mut last_progress = 0_u8;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
                let Some(total_bytes) = content_length.filter(|total| *total > 0) else {
                    return;
                };
                let progress = ((downloaded_bytes as f64 / total_bytes as f64) * 100.0)
                    .floor()
                    .clamp(0.0, 99.0) as u8;
                if progress > last_progress {
                    last_progress = progress;
                    let _ = progress_app.emit("update-progress", progress);
                }
            },
            move || {
                let _ = finished_app.emit("update-progress", 100_u8);
            },
        )
        .await
        .map_err(|error| format!("Could not install the update: {error}"))?;
    app.restart();
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| {
            let ext = value.to_ascii_lowercase();
            AUDIO_EXTENSIONS.contains(&ext.as_str()) || VIDEO_EXTENSIONS.contains(&ext.as_str())
        })
        .unwrap_or(false)
}

fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| VIDEO_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn expand_paths(paths: &[String]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for value in paths {
        let path = PathBuf::from(value);
        if path.is_file() && is_supported(&path) {
            let canonical = path.canonicalize().unwrap_or(path);
            if seen.insert(canonical.clone()) {
                files.push(canonical);
            }
        } else if path.is_dir() {
            for entry in WalkDir::new(path)
                .max_depth(3)
                .follow_links(false)
                .into_iter()
                .flatten()
            {
                let entry_path = entry.path();
                if entry_path.is_file() && is_supported(entry_path) {
                    let canonical = entry_path
                        .canonicalize()
                        .unwrap_or_else(|_| entry_path.to_path_buf());
                    if seen.insert(canonical.clone()) {
                        files.push(canonical);
                    }
                }
            }
        }
    }
    files.sort();
    files
}

fn probe_duration(path: &Path) -> Option<f64> {
    let output = Command::new(command_path("ffprobe")?)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

fn has_audio_stream(path: &Path) -> bool {
    if !is_video(path) {
        return true;
    }
    let Some(ffprobe) = command_path("ffprobe") else {
        return true;
    };
    Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .is_ok_and(|output| output.status.success() && !output.stdout.is_empty())
}

fn silent_video_message(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("This video");
    format!("{name} has no audio track, so there is nothing to separate. Choose a video that contains audio.")
}

fn describe_input(path: &Path) -> InputFile {
    InputFile {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Media file")
            .into(),
        extension: path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase(),
        duration_seconds: if available("ffprobe") {
            probe_duration(path)
        } else {
            None
        },
        size_bytes: fs::metadata(path).ok().map(|metadata| metadata.len()),
        is_video: is_video(path),
    }
}

#[tauri::command]
fn resolve_inputs(paths: Vec<String>) -> Result<Vec<InputFile>, String> {
    let files = expand_paths(&paths);
    if files.is_empty() {
        return Err("No supported audio or video files were found.".into());
    }
    if let Some(path) = files.iter().find(|path| is_video(path) && !has_audio_stream(path)) {
        return Err(silent_video_message(path));
    }
    Ok(files.iter().map(|path| describe_input(path)).collect())
}

fn emit_progress(app: &AppHandle, progress: JobProgress) {
    let _ = app.emit("job-progress", progress);
}

fn extract_audio(source: &Path, target: &Path) -> Result<(), String> {
    if !has_audio_stream(source) {
        return Err(silent_video_message(source));
    }
    let ffmpeg = command_path("ffmpeg").ok_or_else(|| "FFmpeg is not installed.".to_string())?;
    let output = Command::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(source)
        .args(["-vn", "-map", "0:a:0", "-c:a", "pcm_s24le", "-ar", "44100"])
        .arg(target)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not extract the video's audio: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("The video's audio could not be prepared. Check that the file plays correctly, then try again.".into())
    }
}

fn safe_artifact_name(name: &str) -> Result<&str, String> {
    let path = Path::new(name);
    if path.components().count() == 1
        && path.file_name().and_then(|value| value.to_str()) == Some(name)
        && !name.is_empty()
    {
        Ok(name)
    } else {
        Err(format!(
            "The registry supplied an unsafe model filename: {name}"
        ))
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| {
        format!(
            "Could not read cached model artifact {}: {error}",
            path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| {
            format!(
                "Could not verify cached model artifact {}: {error}",
                path.display()
            )
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn install_verified_part(
    part: &Path,
    target: &Path,
    expected: &str,
    name: &str,
) -> Result<PathBuf, String> {
    if !part.is_file() {
        if target.is_file() && sha256_file(target)? == expected {
            return Ok(target.to_path_buf());
        }
        return Err(format!(
            "Could not finish installing model artifact {name}: the completed temporary file is missing."
        ));
    }
    let actual = sha256_file(part)?;
    if actual != expected {
        let _ = fs::remove_file(part);
        return Err(format!(
            "The downloaded {name} failed its SHA-256 check. Expected {expected}, received {actual}."
        ));
    }

    if target.is_file() {
        if sha256_file(target)? == expected {
            let _ = fs::remove_file(part);
            return Ok(target.to_path_buf());
        }
        fs::remove_file(target).map_err(|error| {
            format!(
                "Could not replace corrupt cached model artifact {}: {error}",
                target.display()
            )
        })?;
    }

    match fs::rename(part, target) {
        Ok(()) => Ok(target.to_path_buf()),
        Err(_error) if target.is_file() && sha256_file(target)? == expected => {
            let _ = fs::remove_file(part);
            Ok(target.to_path_buf())
        }
        Err(error) => Err(format!(
            "Could not finish installing model artifact {name}: {error}"
        )),
    }
}

async fn download_verified_artifact(
    app: &AppHandle,
    active_job: &ActiveJob,
    job_id: &str,
    client: &reqwest::Client,
    artifact: &ModelArtifact,
    model_dir: &Path,
    model_name: &str,
    model_index: usize,
    model_count: usize,
    artifact_index: usize,
    artifact_count: usize,
) -> Result<PathBuf, String> {
    let name = safe_artifact_name(&artifact.name)?;
    if !artifact.url.starts_with("https://")
        || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || artifact.sha256.len() != 64
    {
        return Err(format!(
            "The registry supplied invalid download metadata for {name}."
        ));
    }
    let target = model_dir.join(name);
    let expected = artifact.sha256.to_ascii_lowercase();
    if target.is_file() {
        if sha256_file(&target)? == expected {
            return Ok(target);
        }
        if let Err(error) = fs::remove_file(&target) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!(
                    "Could not replace corrupt cached model artifact {}: {error}",
                    target.display()
                ));
            }
        }
    }

    let sequence = ARTIFACT_DOWNLOAD_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let part = model_dir.join(format!(".{name}.{}.{}.part", std::process::id(), sequence));
    let mut response = client
        .get(&artifact.url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| format!("Could not download {name}: {error}"))?;
    let total_bytes = response.content_length();
    let mut downloaded_bytes = 0_u64;
    let mut file = fs::File::create(&part).map_err(|error| {
        format!(
            "Could not create model download {}: {error}",
            part.display()
        )
    })?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        let _ = fs::remove_file(&part);
        format!("The download of {name} was interrupted: {error}")
    })? {
        if let Err(error) = ensure_job_running(active_job, job_id) {
            let _ = fs::remove_file(&part);
            return Err(error);
        }
        file.write_all(&chunk).map_err(|error| {
            let _ = fs::remove_file(&part);
            format!("Could not save model artifact {name}: {error}")
        })?;
        hasher.update(&chunk);
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
        let artifact_progress = total_bytes
            .filter(|total| *total > 0)
            .map(|total| downloaded_bytes as f64 / total as f64)
            .unwrap_or(0.12);
        let phase_progress = 100.0
            * (artifact_index as f64 + artifact_progress.min(0.99))
            / artifact_count.max(1) as f64;
        emit_progress(app, JobProgress {
            job_id: job_id.into(),
            overall: 1.0,
            file_index: 0,
            file_count: 1,
            stage: format!("Downloading {model_name}"),
            detail: format!("{} · {} of {}", name, artifact_index + 1, artifact_count),
            model_name: Some(model_name.into()),
            model_index: Some(model_index),
            model_count: Some(model_count),
            eta_seconds: None,
            phase: "download".into(),
            phase_progress,
        });
    }
    file.sync_all().map_err(|error| {
        let _ = fs::remove_file(&part);
        format!("Could not finish saving model artifact {name}: {error}")
    })?;
    drop(file);
    let streamed = format!("{:x}", hasher.finalize());
    if streamed != expected {
        let _ = fs::remove_file(&part);
        return Err(format!("The downloaded {name} failed its SHA-256 check. Expected {expected}, received {streamed}."));
    }
    install_verified_part(&part, &target, &expected, name)
}

async fn ensure_model_artifacts(
    app: &AppHandle,
    active_job: &ActiveJob,
    job_id: &str,
    run: &ModelRun,
    model_dir: &Path,
    model_index: usize,
    model_count: usize,
) -> Result<(), String> {
    if run.artifacts.is_empty() {
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|error| format!("Could not initialize the model downloader: {error}"))?;
    let mut config_path = None;
    let artifact_count = run.artifacts.len();
    for (artifact_index, artifact) in run.artifacts.iter().enumerate() {
        let path = download_verified_artifact(
            app, active_job, job_id, &client, artifact, model_dir, &run.model_name,
            model_index, model_count, artifact_index, artifact_count,
        ).await?;
        if matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("yaml" | "yml")
        ) {
            config_path = Some(path);
        }
    }

    let checkpoint_stem = Path::new(&run.model_filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            format!(
                "The registry model filename is invalid: {}",
                run.model_filename
            )
        })?;
    let expected_config = model_dir.join(format!("{checkpoint_stem}.yaml"));
    if let Some(source) = config_path {
        if source != expected_config {
            let part = model_dir.join(format!(".{checkpoint_stem}.yaml.part"));
            fs::copy(&source, &part)
                .map_err(|error| format!("Could not prepare the model configuration: {error}"))?;
            if expected_config.exists() {
                fs::remove_file(&expected_config).map_err(|error| {
                    format!("Could not replace the model configuration: {error}")
                })?;
            }
            fs::rename(&part, &expected_config)
                .map_err(|error| format!("Could not install the model configuration: {error}"))?;
        }
    }
    Ok(())
}

fn model_artifacts_ready(run: &ModelRun, model_dir: &Path) -> bool {
    let artifacts_ready = !run.artifacts.is_empty() && run.artifacts.iter().all(|artifact| {
        let Ok(name) = safe_artifact_name(&artifact.name) else { return false; };
        let path = model_dir.join(name);
        path.is_file()
            && sha256_file(&path)
                .is_ok_and(|actual| actual.eq_ignore_ascii_case(&artifact.sha256))
    });
    if !artifacts_ready {
        return false;
    }
    let has_config = run.artifacts.iter().any(|artifact| {
        matches!(Path::new(&artifact.name).extension().and_then(|value| value.to_str()), Some("yaml" | "yml"))
    });
    if !has_config {
        return true;
    }
    Path::new(&run.model_filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(|stem| model_dir.join(format!("{stem}.yaml")).is_file())
}

#[tauri::command]
fn required_model_downloads(app: AppHandle, plan: Vec<ModelRun>) -> Result<Vec<usize>, String> {
    let model_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate the app cache: {error}"))?
        .join("models");
    Ok(plan
        .iter()
        .enumerate()
        .filter_map(|(index, run)| {
            (!run.artifacts.is_empty() && !model_artifacts_ready(run, &model_dir))
                .then_some(index + 1)
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
async fn run_separator(
    app: &AppHandle,
    active_job: &ActiveJob,
    job_id: &str,
    engine: &EngineCommand,
    input: &Path,
    output_dir: &Path,
    model_dir: &Path,
    run: &ModelRun,
    file_index: usize,
    file_count: usize,
    model_index: usize,
    model_count: usize,
) -> Result<(), String> {
    run_separator_attempt(
        app,
        active_job,
        job_id,
        engine,
        input,
        output_dir,
        model_dir,
        run,
        file_index,
        file_count,
        model_index,
        model_count,
        true,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_separator_attempt(
    app: &AppHandle,
    active_job: &ActiveJob,
    job_id: &str,
    engine: &EngineCommand,
    input: &Path,
    output_dir: &Path,
    model_dir: &Path,
    run: &ModelRun,
    file_index: usize,
    file_count: usize,
    model_index: usize,
    model_count: usize,
    repair_corrupt_cache: bool,
) -> Result<(), String> {
    let mut command = TokioCommand::new(&engine.program);
    #[cfg(unix)]
    command.process_group(0);
    let inherited_path = std::env::var_os("PATH").unwrap_or_default();
    let mut executable_paths = Vec::new();
    for tool in ["ffmpeg", "ffprobe"] {
        if let Some(directory) =
            command_path(tool).and_then(|path| path.parent().map(Path::to_path_buf))
        {
            if !executable_paths.contains(&directory) {
                executable_paths.push(directory);
            }
        }
    }
    executable_paths.extend(std::env::split_paths(&inherited_path));
    if let Ok(path) = std::env::join_paths(executable_paths) {
        command.env("PATH", path);
    }
    command
        .args(&engine.prefix_args)
        .arg(input)
        .args([
            "--model_filename",
            &run.model_filename,
            "--output_format",
            "WAV",
            "--sample_rate",
            "44100",
            "--log_level",
            "info",
        ])
        .arg("--output_dir")
        .arg(output_dir)
        .arg("--model_file_dir")
        .arg(model_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    command.arg("--use_torch_compile");

    let child = command
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", engine.label))?;
    let pid = child.id().ok_or_else(|| {
        "The separation process did not provide a process identifier.".to_string()
    })?;
    let _active_guard = register_active_process(active_job, job_id, pid)?;
    let output_future = child.wait_with_output();
    tokio::pin!(output_future);
    let mut interval = time::interval(std::time::Duration::from_millis(700));
    let file_share = 96.0 / file_count.max(1) as f64;
    let model_region = file_share * 0.92;
    let model_share = model_region / model_count.max(1) as f64;
    let base =
        1.0 + file_index as f64 * file_share + model_index.saturating_sub(1) as f64 * model_share;
    let progress_started = std::time::Instant::now();

    let output = loop {
        tokio::select! {
            result = &mut output_future => break result.map_err(|error| format!("Separation process failed: {error}"))?,
            _ = interval.tick() => {
                let seconds = progress_started.elapsed().as_secs_f64();
                let local_progress = (0.6 + 0.13 * seconds + 0.0009 * seconds * seconds).min(90.0);
                emit_progress(app, JobProgress {
                    job_id: job_id.into(), overall: (base + model_share * local_progress / 100.0).min(97.0),
                    file_index, file_count, stage: format!("Separating {}", run.stems.iter().map(|stem| title_case(stem)).collect::<Vec<_>>().join(" + ")),
                    detail: format!("{} · running locally", run.model_name), model_name: Some(run.model_name.clone()),
                    model_index: Some(model_index), model_count: Some(model_count), eta_seconds: None,
                    phase: "separate".into(), phase_progress: local_progress,
                });
            }
        }
    };

    if output.status.success() {
        emit_progress(
            app,
            JobProgress {
                job_id: job_id.into(),
                overall: (base + model_share).min(97.0),
                file_index,
                file_count,
                stage: format!(
                    "Finished {}",
                    run.stems
                        .iter()
                        .map(|stem| title_case(stem))
                        .collect::<Vec<_>>()
                        .join(" + ")
                ),
                detail: format!("{} completed", run.model_name),
                model_name: Some(run.model_name.clone()),
                model_index: Some(model_index),
                model_count: Some(model_count),
                eta_seconds: None,
                phase: "separate".into(),
                phase_progress: 100.0,
            },
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        if repair_corrupt_cache && is_corrupt_checkpoint_error(detail) {
            let checkpoint = model_dir.join(&run.model_filename);
            if checkpoint.is_file() {
                fs::remove_file(&checkpoint).map_err(|error| {
                    format!(
                        "The cached {} checkpoint is corrupt, but it could not be removed for a clean download: {error}",
                        run.model_name
                    )
                })?;
                emit_progress(
                    app,
                    JobProgress {
                        job_id: job_id.into(),
                        overall: base.min(97.0),
                        file_index,
                        file_count,
                        stage: format!("Repairing {}", run.model_name),
                        detail: "Discarding an incomplete checkpoint and downloading it again"
                            .into(),
                        model_name: Some(run.model_name.clone()),
                        model_index: Some(model_index),
                        model_count: Some(model_count),
                        eta_seconds: None,
                        phase: "download".into(),
                        phase_progress: 0.0,
                    },
                );
                emit_progress(
                    app,
                    JobProgress {
                        job_id: job_id.into(),
                        overall: base.min(97.0),
                        file_index,
                        file_count,
                        stage: format!("Downloading {}", run.model_name),
                        detail: "Fetching a clean copy of the model".into(),
                        model_name: Some(run.model_name.clone()),
                        model_index: Some(model_index),
                        model_count: Some(model_count),
                        eta_seconds: None,
                        phase: "download".into(),
                        phase_progress: 0.0,
                    },
                );
                ensure_model_artifacts(app, active_job, job_id, run, model_dir, model_index, model_count).await?;
                return Box::pin(run_separator_attempt(
                    app,
                    active_job,
                    job_id,
                    engine,
                    input,
                    output_dir,
                    model_dir,
                    run,
                    file_index,
                    file_count,
                    model_index,
                    model_count,
                    false,
                ))
                .await;
            }
        }
        Err(format!(
            "{} could not finish the {} pass. {}",
            engine.label,
            run.model_name,
            tail(detail, 1400)
        ))
    }
}

fn is_corrupt_checkpoint_error(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("failed finding central directory")
        || detail.contains("checkpoint file is corrupt")
        || detail.contains("model file is corrupt or incomplete")
}

fn tail(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.into();
    }
    value
        .chars()
        .rev()
        .take(max_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

fn sanitize(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    cleaned.trim().trim_matches('_').to_string()
}

fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let parent = path.parent().unwrap_or(Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("stem");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("wav");
    for index in 2..1000 {
        let candidate = parent.join(format!("{stem} {index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

fn find_stem_file(directory: &Path, stem: &str) -> Option<PathBuf> {
    let search = stem
        .chars()
        .filter(|value| value.is_ascii_alphanumeric())
        .collect::<String>();
    let mut candidates = WalkDir::new(directory)
        .max_depth(2)
        .into_iter()
        .flatten()
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.path().to_path_buf())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("wav"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().find(|path| {
        path.file_name()
            .and_then(|value| value.to_str())
            .map(|value| {
                value
                    .to_ascii_lowercase()
                    .chars()
                    .filter(|character| character.is_ascii_alphanumeric())
                    .collect::<String>()
                    .contains(&search)
            })
            .unwrap_or(false)
    })
}

fn align_wav(source: &Path, target: &Path, duration: Option<f64>) -> Result<(), String> {
    let Some(duration) = duration else {
        fs::copy(source, target).map_err(|error| format!("Could not save WAV: {error}"))?;
        return Ok(());
    };
    let ffmpeg = command_path("ffmpeg").ok_or_else(|| "FFmpeg is not installed.".to_string())?;
    let output = Command::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(source)
        .args([
            "-af",
            "apad",
            "-t",
            &format!("{duration:.6}"),
            "-c:a",
            "pcm_s24le",
            "-ar",
            "44100",
        ])
        .arg(target)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not align output WAV: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Could not align WAV output: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn make_video(
    source_video: &Path,
    stem_wav: &Path,
    target: &Path,
    duration: Option<f64>,
) -> Result<(), String> {
    let ffmpeg = command_path("ffmpeg").ok_or_else(|| "FFmpeg is not installed.".to_string())?;
    let mut command = Command::new(ffmpeg);
    command
        .arg("-y")
        .arg("-i")
        .arg(source_video)
        .arg("-i")
        .arg(stem_wav)
        .args([
            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
        ]);
    if let Some(duration) = duration {
        command.args(["-t", &format!("{duration:.6}")]);
    }
    let output = command
        .arg(target)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not create stem video: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Could not create stem video: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[tauri::command]
async fn process_job(
    app: AppHandle,
    active_job: State<'_, ActiveJob>,
    request: ProcessRequest,
) -> Result<ProcessResult, String> {
    if !available("ffmpeg") || !available("ffprobe") {
        return Err(
            "FFmpeg and FFprobe are required. Install them with Homebrew: brew install ffmpeg"
                .into(),
        );
    }
    if request.demo_mode {
        return Err("Demo processing is only available in the browser preview.".into());
    }
    if request.plan.is_empty() || request.stems.is_empty() {
        return Err("Choose at least one stem before starting.".into());
    }
    let engine = separator_engine().ok_or_else(|| "The bundled separation engine is missing. Install uv, then reopen the app: brew install uv".to_string())?;
    let inputs = expand_paths(&request.paths);
    if inputs.is_empty() {
        return Err("No supported media files were found.".into());
    }
    if let Some(path) = inputs.iter().find(|path| is_video(path) && !has_audio_stream(path)) {
        return Err(silent_video_message(path));
    }

    let job_id = format!(
        "job-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let _job_guard = register_active_job(active_job.inner(), &job_id)?;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate the app cache: {error}"))?;
    let job_root = cache_root.join("jobs").join(&job_id);
    let model_dir = cache_root.join("models");
    fs::create_dir_all(&job_root)
        .map_err(|error| format!("Could not prepare working space: {error}"))?;
    fs::create_dir_all(&model_dir)
        .map_err(|error| format!("Could not prepare model storage: {error}"))?;

    let output_root = request
        .output_directory
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            inputs[0]
                .parent()
                .unwrap_or(Path::new("."))
                .join("Stem Separator")
        });
    fs::create_dir_all(&output_root)
        .map_err(|error| format!("Could not create output folder: {error}"))?;

    let mut outputs = Vec::new();
    let mut warnings = Vec::new();
    let file_count = inputs.len();
    let model_count = request.plan.len();
    let file_share = 96.0 / file_count.max(1) as f64;

    for (index, run) in request.plan.iter().enumerate() {
        if run.artifacts.is_empty() || model_artifacts_ready(run, &model_dir) {
            continue;
        }
        ensure_job_running(active_job.inner(), &job_id)?;
        emit_progress(
            &app,
            JobProgress {
                job_id: job_id.clone(),
                overall: 1.0,
                file_index: 0,
                file_count,
                stage: format!("Downloading {}", run.model_name),
                detail: "Downloading and verifying registry model files".into(),
                model_name: Some(run.model_name.clone()),
                model_index: Some(index + 1),
                model_count: Some(model_count),
                eta_seconds: None,
                phase: "download".into(),
                phase_progress: 0.0,
            },
        );
        ensure_model_artifacts(&app, active_job.inner(), &job_id, run, &model_dir, index + 1, model_count).await?;
    }

    for (file_index, source) in inputs.iter().enumerate() {
        ensure_job_running(active_job.inner(), &job_id)?;
        let file_base = 1.0 + file_index as f64 * file_share;
        let source_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("media")
            .to_string();
        let source_base = sanitize(
            source
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("media"),
        );
        let duration = probe_duration(source);
        let file_work = job_root.join(format!("file-{file_index}"));
        fs::create_dir_all(&file_work)
            .map_err(|error| format!("Could not prepare a file workspace: {error}"))?;
        let separation_input = if is_video(source) {
            emit_progress(
                &app,
                JobProgress {
                    job_id: job_id.clone(),
                    overall: file_base + file_share * 0.02,
                    file_index,
                    file_count,
                    stage: "Preparing video".into(),
                    detail: format!("Extracting the soundtrack from {source_name}"),
                    model_name: None,
                    model_index: None,
                    model_count: Some(model_count),
                    eta_seconds: None,
                    phase: "prepare".into(),
                    phase_progress: 4.0,
                },
            );
            let extracted = file_work.join("source-audio.wav");
            extract_audio(source, &extracted)?;
            ensure_job_running(active_job.inner(), &job_id)?;
            extracted
        } else {
            source.clone()
        };

        for (index, run) in request.plan.iter().enumerate() {
            ensure_job_running(active_job.inner(), &job_id)?;
            let run_dir = file_work.join(format!("model-{index}"));
            fs::create_dir_all(&run_dir)
                .map_err(|error| format!("Could not create a model workspace: {error}"))?;
            run_separator(
                &app,
                active_job.inner(),
                &job_id,
                &engine,
                &separation_input,
                &run_dir,
                &model_dir,
                run,
                file_index,
                file_count,
                index + 1,
                model_count,
            )
            .await?;
        }

        let source_output_dir = if file_count > 1 {
            output_root.join(&source_base)
        } else {
            output_root.clone()
        };
        fs::create_dir_all(&source_output_dir)
            .map_err(|error| format!("Could not create an output folder: {error}"))?;

        emit_progress(
            &app,
            JobProgress {
                job_id: job_id.clone(),
                overall: file_base + file_share * 0.93,
                file_index,
                file_count,
                stage: "Finishing up".into(),
                detail: if source
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("wav"))
                {
                    format!("Writing WAV files for {source_name}")
                } else {
                    format!("Aligning and writing outputs for {source_name}")
                },
                model_name: None,
                model_index: Some(model_count),
                model_count: Some(model_count),
                eta_seconds: None,
                phase: "finish".into(),
                phase_progress: 18.0,
            },
        );

        for (stem_index, stem) in request.stems.iter().enumerate() {
            ensure_job_running(active_job.inner(), &job_id)?;
            let run_index = request.plan.iter().position(|run| run.stems.contains(stem));
            let found = run_index
                .and_then(|index| find_stem_file(&file_work.join(format!("model-{index}")), stem));
            let Some(found) = found else {
                warnings.push(format!("{} was requested for {}, but the selected model did not return a matching file.", title_case(stem), source_name));
                continue;
            };

            let wav_path =
                unique_path(source_output_dir.join(format!("{}_{}.wav", source_base, stem)));
            align_wav(&found, &wav_path, duration)?;
            ensure_job_running(active_job.inner(), &job_id)?;
            let wav_name = wav_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("stem.wav")
                .into();
            outputs.push(OutputStem {
                path: wav_path.to_string_lossy().into_owned(),
                name: wav_name,
                stem: stem.clone(),
                source_name: source_name.clone(),
                is_video: false,
                duration_seconds: duration,
            });

            if request.keep_video && is_video(source) {
                emit_progress(
                    &app,
                    JobProgress {
                        job_id: job_id.clone(),
                        overall: file_base
                            + file_share
                                * (0.94
                                    + 0.05 * stem_index as f64 / request.stems.len().max(1) as f64),
                        file_index,
                        file_count,
                        stage: format!("Creating {} video", title_case(stem)),
                        detail: "Replacing the source soundtrack without re-encoding the picture"
                            .into(),
                        model_name: None,
                        model_index: Some(model_count),
                        model_count: Some(model_count),
                        eta_seconds: None,
                        phase: "finish".into(),
                        phase_progress: 20.0 + 75.0 * stem_index as f64 / request.stems.len().max(1) as f64,
                    },
                );
                let video_path =
                    unique_path(source_output_dir.join(format!("{}_{}.mp4", source_base, stem)));
                make_video(source, &wav_path, &video_path, duration)?;
                ensure_job_running(active_job.inner(), &job_id)?;
                let video_name = video_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("stem.mp4")
                    .into();
                outputs.push(OutputStem {
                    path: video_path.to_string_lossy().into_owned(),
                    name: video_name,
                    stem: stem.clone(),
                    source_name: source_name.clone(),
                    is_video: true,
                    duration_seconds: duration,
                });
            }
        }
    }

    emit_progress(
        &app,
        JobProgress {
            job_id: job_id.clone(),
            overall: 100.0,
            file_index: file_count.saturating_sub(1),
            file_count,
            stage: "Your stems are ready".into(),
            detail: if inputs.iter().all(|source| {
                source
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("wav"))
            }) {
                "WAV files have been saved.".into()
            } else {
                "WAV files have been aligned and saved.".into()
            },
            model_name: None,
            model_index: Some(model_count),
            model_count: Some(model_count),
            eta_seconds: Some(0),
            phase: "complete".into(),
            phase_progress: 100.0,
        },
    );
    Ok(ProcessResult {
        job_id,
        output_directory: output_root.to_string_lossy().into_owned(),
        outputs,
        warnings,
        used_demo_mode: false,
    })
}

#[tauri::command]
fn cancel_job(active_job: State<'_, ActiveJob>, job_id: Option<String>) -> Result<bool, String> {
    let pid = {
        let mut active = active_job
            .state
            .lock()
            .map_err(|_| "Could not access the active separation job.".to_string())?;
        let Some(active_id) = active.job_id.as_ref() else {
            return Ok(false);
        };
        if job_id
            .as_ref()
            .is_some_and(|requested| requested != active_id)
        {
            return Ok(false);
        }
        active.cancelled = true;
        active.pid
    };
    if let Some(pid) = pid {
        stop_process_tree(pid)?;
    }
    Ok(true)
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut value = Command::new("open");
        value.arg(&path);
        value
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut value = Command::new("explorer");
        value.arg(&path);
        value
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut value = Command::new("xdg-open");
        value.arg(&path);
        value
    };
    command
        .spawn()
        .map_err(|error| format!("Could not open the output folder: {error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ActiveJob::default())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            detect_environment,
            check_for_update,
            install_update,
            resolve_inputs,
            required_model_downloads,
            process_job,
            cancel_job,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stem Separator");
}

#[cfg(test)]
mod tests {
    use super::{
        has_audio_stream, install_verified_part, is_corrupt_checkpoint_error, safe_artifact_name,
        sha256_file, silent_video_message,
    };
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn registry_artifact_names_cannot_escape_the_model_directory() {
        assert_eq!(
            safe_artifact_name("becruily_deux.ckpt"),
            Ok("becruily_deux.ckpt")
        );
        assert!(safe_artifact_name("../model.ckpt").is_err());
        assert!(safe_artifact_name("models/model.ckpt").is_err());
    }

    #[test]
    fn pytorch_zip_corruption_is_recognized_for_one_clean_retry() {
        assert!(is_corrupt_checkpoint_error(
            "PytorchStreamReader failed reading zip archive: failed finding central directory"
        ));
        assert!(!is_corrupt_checkpoint_error(
            "The input audio file is not supported"
        ));
    }

    #[test]
    fn completed_concurrent_download_is_accepted_after_its_part_was_moved() {
        let root = std::env::temp_dir().join(format!(
            "stem-separator-artifact-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let part = root.join(".model.ckpt.part");
        let target = root.join("model.ckpt");
        fs::write(&part, b"verified checkpoint").unwrap();
        let expected = sha256_file(&part).unwrap();
        fs::rename(&part, &target).unwrap();

        assert_eq!(
            install_verified_part(&part, &target, &expected, "model.ckpt").unwrap(),
            target
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn video_without_audio_is_rejected_with_a_short_message() {
        let root = std::env::temp_dir().join(format!(
            "stem-separator-silent-video-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let video = root.join("silent.mp4");
        let ffmpeg = super::command_path("ffmpeg").expect("ffmpeg is required for this test");
        let status = std::process::Command::new(ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=32x32:d=0.1",
                "-an",
                "-c:v",
                "libx264",
            ])
            .arg(&video)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(!has_audio_stream(&video));
        assert_eq!(
            silent_video_message(&video),
            "silent.mp4 has no audio track, so there is nothing to separate. Choose a video that contains audio."
        );
        fs::remove_dir_all(root).unwrap();
    }
}
