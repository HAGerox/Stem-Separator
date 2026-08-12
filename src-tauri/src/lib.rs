use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{process::Command as TokioCommand, time};
use walkdir::WalkDir;

const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "mp3", "flac", "m4a", "aac", "ogg", "opus", "aiff", "aif", "wma",
];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "mkv", "webm", "m4v", "avi"];

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

#[derive(Clone)]
struct EngineCommand {
    program: PathBuf,
    prefix_args: Vec<String>,
    label: String,
}

fn command_path(command: &str) -> Option<PathBuf> {
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
            prefix_args: vec![],
            label: "Audio Separator".into(),
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
                "audio-separator[cpu]==0.44.5".into(),
                "audio-separator".into(),
            ],
            label: "Audio Separator · managed on first use".into(),
        });
    }
    None
}

#[tauri::command]
fn detect_environment() -> EnvironmentStatus {
    let separator = available("audio-separator");
    let uv = available("uvx");
    EnvironmentStatus {
        is_tauri: true,
        ffmpeg_available: available("ffmpeg"),
        ffprobe_available: available("ffprobe"),
        separator_available: separator,
        uv_available: uv,
        engine_label: if separator {
            "Audio Separator · ready".into()
        } else if uv {
            "Audio Separator · installs on first use".into()
        } else {
            "Audio Separator · setup required".into()
        },
        acceleration: if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
            "Apple Silicon · CoreML when supported".into()
        } else {
            "Local processing".into()
        },
    }
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
    Ok(files.iter().map(|path| describe_input(path)).collect())
}

fn emit_progress(app: &AppHandle, progress: JobProgress) {
    let _ = app.emit("job-progress", progress);
}

fn extract_audio(source: &Path, target: &Path) -> Result<(), String> {
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
        Err(format!(
            "Could not extract video audio: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

async fn run_separator(
    app: &AppHandle,
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
    let mut command = TokioCommand::new(&engine.program);
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

    let child = command
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", engine.label))?;
    let output_future = child.wait_with_output();
    tokio::pin!(output_future);
    let mut interval = time::interval(std::time::Duration::from_millis(700));
    let file_share = 84.0 / file_count.max(1) as f64;
    let model_share = file_share / model_count.max(1) as f64;
    let base =
        7.0 + file_index as f64 * file_share + model_index.saturating_sub(1) as f64 * model_share;
    let mut local_progress = 0.0_f64;

    let output = loop {
        tokio::select! {
            result = &mut output_future => break result.map_err(|error| format!("Separation process failed: {error}"))?,
            _ = interval.tick() => {
                local_progress = (local_progress + (94.0 - local_progress) * 0.025).min(92.0);
                emit_progress(app, JobProgress {
                    job_id: job_id.into(), overall: (base + model_share * local_progress / 100.0).min(91.0),
                    file_index, file_count, stage: format!("Separating {}", run.stems.iter().map(|stem| title_case(stem)).collect::<Vec<_>>().join(" + ")),
                    detail: format!("{} · running locally", run.model_name), model_name: Some(run.model_name.clone()),
                    model_index: Some(model_index), model_count: Some(model_count), eta_seconds: None,
                });
            }
        }
    };

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        Err(format!(
            "{} could not finish the {} pass. {}",
            engine.label,
            run.model_name,
            tail(detail, 1400)
        ))
    }
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
    let search = if stem == "strings" { "other" } else { stem };
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
            .map(|value| value.to_ascii_lowercase().contains(search))
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
async fn process_job(app: AppHandle, request: ProcessRequest) -> Result<ProcessResult, String> {
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
    let engine = separator_engine().ok_or_else(|| "The separation engine is not available. Install uv, then reopen the app: brew install uv".to_string())?;
    let inputs = expand_paths(&request.paths);
    if inputs.is_empty() {
        return Err("No supported media files were found.".into());
    }

    let job_id = format!(
        "job-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
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

    for (file_index, source) in inputs.iter().enumerate() {
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
                    overall: 4.0,
                    file_index,
                    file_count,
                    stage: "Preparing video audio".into(),
                    detail: format!("Extracting the soundtrack from {source_name}"),
                    model_name: None,
                    model_index: None,
                    model_count: Some(model_count),
                    eta_seconds: None,
                },
            );
            let extracted = file_work.join("source-audio.wav");
            extract_audio(source, &extracted)?;
            extracted
        } else {
            source.clone()
        };

        for (index, run) in request.plan.iter().enumerate() {
            let run_dir = file_work.join(format!("model-{index}"));
            fs::create_dir_all(&run_dir)
                .map_err(|error| format!("Could not create a model workspace: {error}"))?;
            run_separator(
                &app,
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

        for stem in &request.stems {
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

            if stem == "strings" {
                warnings.push(format!("Strings for {} currently uses the broad “Other” output as an approximate local fallback. A dedicated strings model is planned for the live catalog.", source_name));
            }

            if request.keep_video && is_video(source) {
                let video_path =
                    unique_path(source_output_dir.join(format!("{}_{}.mp4", source_base, stem)));
                make_video(source, &wav_path, &video_path, duration)?;
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
            detail: "WAV files have been aligned and saved.".into(),
            model_name: None,
            model_index: Some(model_count),
            model_count: Some(model_count),
            eta_seconds: Some(0),
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            detect_environment,
            resolve_inputs,
            process_job,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stem Separator");
}
