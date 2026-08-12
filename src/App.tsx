import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  FileAudio,
  FileVideo,
  Folder,
  FolderOpen,
  Gauge,
  Info,
  ListMusic,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Upload,
  Volume2,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { buildModelPlan, loadCatalog } from "./lib/catalog";
import {
  detectEnvironment,
  inTauri,
  playableUrl,
  processJob,
  resolveInputs,
  revealPath,
} from "./lib/native";
import type {
  Catalog,
  EnvironmentStatus,
  InputFile,
  JobProgress,
  OutputStem,
  ProcessResult,
  StemId,
  View,
} from "./types";

const STEMS: Array<{ id: StemId; label: string; description: string; glyph: string }> = [
  { id: "vocals", label: "Vocals", description: "Lead and backing voices", glyph: "voice" },
  { id: "instrumental", label: "Instrumental", description: "Everything except vocals", glyph: "wave" },
  { id: "drums", label: "Drums", description: "Kicks, snares and percussion", glyph: "drum" },
  { id: "bass", label: "Bass", description: "Bass guitar and synth bass", glyph: "bass" },
  { id: "guitar", label: "Guitar", description: "Electric and acoustic guitar", glyph: "guitar" },
  { id: "piano", label: "Piano", description: "Piano and keyboard parts", glyph: "keys" },
  { id: "strings", label: "Strings", description: "Violin and string sections", glyph: "strings" },
  { id: "other", label: "Other", description: "Everything not listed above", glyph: "dots" },
];

const PRESETS: Array<{ label: string; stems: StemId[] }> = [
  { label: "Vocals + instrumental", stems: ["vocals", "instrumental"] },
  { label: "Band mix", stems: ["vocals", "drums", "bass", "guitar", "piano", "other"] },
];

function basename(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function extension(name: string) {
  const value = name.split(".").pop();
  return value && value !== name ? value.toLowerCase() : "";
}

function formatBytes(bytes?: number) {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function formatTime(seconds?: number) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const mins = Math.floor(seconds / 60);
  return `${mins}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function stemLabel(stem: StemId) {
  return STEMS.find((item) => item.id === stem)?.label || stem;
}

function StemGlyph({ type }: { type: string }) {
  if (type === "drum") return <span className="glyph-drum"><i /><i /></span>;
  if (type === "keys") return <span className="glyph-keys">▥</span>;
  if (type === "dots") return <MoreHorizontal size={25} strokeWidth={1.8} />;
  if (type === "voice") return <span className="glyph-bars"><i /><i /><i /><i /><i /></span>;
  if (type === "wave") return <span className="glyph-wave">⌁</span>;
  if (type === "bass") return <span className="glyph-string">𝄢</span>;
  if (type === "guitar") return <span className="glyph-string">♩</span>;
  return <span className="glyph-string">𝄞</span>;
}

function Logo() {
  return (
    <div className="brand-mark" aria-label="Stem Separator">
      <i /><i /><i /><i /><i />
    </div>
  );
}

function Header({
  onSettings,
  view,
  onBack,
}: {
  onSettings: () => void;
  view: View;
  onBack: () => void;
}) {
  return (
    <header className="app-header" data-tauri-drag-region>
      <div className="header-left">
        {view !== "drop" && view !== "processing" && (
          <button className="icon-button back-button" onClick={onBack} aria-label="Go back">
            <ArrowLeft size={20} />
          </button>
        )}
        <Logo />
        <span className="brand-name">Stem Separator</span>
      </div>
      <button className="icon-button" onClick={onSettings} aria-label="Settings">
        <Settings2 size={19} />
      </button>
    </header>
  );
}

function DropView({ onPick, dragging }: { onPick: (folder?: boolean) => void; dragging: boolean }) {
  return (
    <main className={`drop-view ${dragging ? "is-dragging" : ""}`}>
      <section className="drop-copy">
        <div className="drop-icon"><Upload size={28} strokeWidth={1.75} /></div>
        <h1>Drop audio or video here</h1>
        <p>We’ll choose the best separation method for you.</p>
        <button className="primary-button" onClick={() => onPick(false)}>Choose files</button>
        <button className="text-button" onClick={() => onPick(true)}><Folder size={15} /> Choose a folder</button>
      </section>
      <div className="format-note">WAV · MP3 · FLAC · M4A · MP4 · MOV and more</div>
    </main>
  );
}

function FilePill({ file, onRemove }: { file: InputFile; onRemove: () => void }) {
  return (
    <div className="file-pill">
      <div className={`file-type ${file.isVideo ? "video" : "audio"}`}>
        {file.isVideo ? <FileVideo size={22} /> : <FileAudio size={22} />}
      </div>
      <div className="file-meta">
        <strong>{file.name}</strong>
        <span>{[file.extension.toUpperCase(), formatBytes(file.sizeBytes), formatTime(file.durationSeconds)].filter(Boolean).join(" · ")}</span>
      </div>
      <button className="remove-file" onClick={onRemove} aria-label={`Remove ${file.name}`}><X size={17} /></button>
    </div>
  );
}

function SelectView({
  files,
  selected,
  setSelected,
  onRemove,
  onAdd,
  onStart,
  catalog,
  catalogRemote,
}: {
  files: InputFile[];
  selected: StemId[];
  setSelected: (stems: StemId[]) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onStart: () => void;
  catalog: Catalog | null;
  catalogRemote: boolean;
}) {
  const plan = useMemo(() => (catalog ? buildModelPlan(catalog, selected) : []), [catalog, selected]);

  const toggleStem = (stem: StemId) => {
    setSelected(selected.includes(stem) ? selected.filter((item) => item !== stem) : [...selected, stem]);
  };

  return (
    <main className="select-view content-shell">
      <section className="file-row">
        <div className="file-list">
          {files.slice(0, 2).map((file, index) => (
            <FilePill key={`${file.path}-${index}`} file={file} onRemove={() => onRemove(index)} />
          ))}
          {files.length > 2 && <div className="more-files">+{files.length - 2} more files</div>}
        </div>
        <button className="add-button" onClick={onAdd}><Plus size={16} /> Add</button>
      </section>

      <section className="stem-section">
        <div className="eyebrow">What would you like?</div>
        <h1>Choose your stems</h1>
        <div className="preset-row">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              className={preset.stems.every((stem) => selected.includes(stem)) && selected.length === preset.stems.length ? "active" : ""}
              onClick={() => setSelected(preset.stems)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="stem-grid">
          {STEMS.map((stem) => {
            const active = selected.includes(stem.id);
            return (
              <button key={stem.id} className={`stem-card ${active ? "selected" : ""}`} onClick={() => toggleStem(stem.id)}>
                <span className="stem-icon"><StemGlyph type={stem.glyph} /></span>
                <span className="stem-copy"><strong>{stem.label}</strong><small>{stem.description}</small></span>
                <span className="stem-check">{active && <Check size={14} strokeWidth={3} />}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="selection-footer">
        <div className="smart-plan">
          <Sparkles size={16} />
          <span>
            <strong>Automatic model selection</strong>
            {selected.length > 0 && plan.length > 0
              ? ` · ${plan.length} ${plan.length === 1 ? "pass" : "passes"} for the best available result`
              : " · Choose at least one stem"}
          </span>
          <span className={`catalog-dot ${catalogRemote ? "remote" : ""}`} title={catalogRemote ? "Live catalog" : "Bundled catalog"} />
        </div>
        <button className="primary-button start-button" disabled={selected.length === 0} onClick={onStart}>
          Separate {selected.length || ""} {selected.length === 1 ? "stem" : "stems"}
        </button>
      </section>
    </main>
  );
}

function ProcessingView({
  progress,
  files,
  plan,
  selected,
}: {
  progress: JobProgress;
  files: InputFile[];
  plan: ReturnType<typeof buildModelPlan>;
  selected: StemId[];
}) {
  const activeModel = Math.max(0, (progress.modelIndex || 1) - 1);
  return (
    <main className="processing-view content-shell">
      <section className="processing-card">
        <div className="processing-topline">
          <span>Separating {files.length === 1 ? files[0].name : `${files.length} files`}</span>
          <strong>{Math.round(progress.overall)}%</strong>
        </div>
        <div className="main-progress"><span style={{ width: `${Math.max(2, progress.overall)}%` }} /></div>
        <div className="processing-summary">
          <div className="pulse-disc"><span /></div>
          <div>
            <h1>{progress.stage || "Preparing your audio"}</h1>
            <p>{progress.detail || "Checking the source and preparing the separation plan…"}</p>
          </div>
        </div>

        <div className="stage-list">
          {plan.map((run, index) => {
            const done = index < activeModel || progress.overall >= 95;
            const active = index === activeModel && progress.overall < 95;
            return (
              <div className={`stage-row ${done ? "done" : ""} ${active ? "active" : ""}`} key={run.id}>
                <span className="stage-status">
                  {done ? <CircleCheck size={19} /> : active ? <LoaderCircle className="spin" size={19} /> : <span className="empty-circle" />}
                </span>
                <div className="stage-copy">
                  <strong>{run.stems.map(stemLabel).join(" + ")}</strong>
                  <span>{run.modelName}</span>
                </div>
                <span className="stage-state">{done ? "Done" : active ? "Processing" : "Waiting"}</span>
              </div>
            );
          })}
          <div className={`stage-row ${progress.overall >= 96 ? "active" : ""}`}>
            <span className="stage-status">{progress.overall >= 100 ? <CircleCheck size={19} /> : <span className="empty-circle" />}</span>
            <div className="stage-copy"><strong>Finishing up</strong><span>Aligning and writing WAV files</span></div>
            <span className="stage-state">{progress.overall >= 96 ? "Processing" : "Waiting"}</span>
          </div>
        </div>

        <details className="technical-details">
          <summary><Gauge size={15} /> Technical details <ChevronDown size={15} /></summary>
          <div className="detail-grid">
            <span>Current file</span><strong>{progress.fileIndex + 1} of {progress.fileCount}</strong>
            <span>Selected output</span><strong>{selected.map(stemLabel).join(", ")}</strong>
            <span>Processing mode</span><strong>Local · WAV 44.1 kHz</strong>
            <span>Estimated time</span><strong>{progress.etaSeconds ? `About ${Math.max(1, Math.ceil(progress.etaSeconds / 60))} min` : "Calculating…"}</strong>
          </div>
        </details>
      </section>
      <div className="processing-note"><Clock3 size={15} /> First use may take longer while the selected models download.</div>
    </main>
  );
}

function Waveform({ seed, active }: { seed: string; active: boolean }) {
  const bars = useMemo(() => Array.from({ length: 54 }, (_, index) => {
    const char = seed.charCodeAt(index % Math.max(seed.length, 1)) || 71;
    return 22 + ((char * (index + 5) * 13) % 54);
  }), [seed]);
  return <div className={`waveform ${active ? "playing" : ""}`}>{bars.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>;
}

function StemPlayer({ output }: { output: OutputStem }) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) await audio.play();
    else audio.pause();
  };

  return (
    <div className="result-row">
      <audio
        ref={audioRef}
        src={playableUrl(output.path)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
      />
      <button className="play-button" onClick={toggle} aria-label={`${playing ? "Pause" : "Play"} ${stemLabel(output.stem)}`}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
      <div className="result-label"><strong>{stemLabel(output.stem)}</strong><span>{output.sourceName}</span></div>
      <Waveform seed={output.name} active={playing} />
      <span className="player-time">{formatTime(current)} / {formatTime(output.durationSeconds)}</span>
      <button className="row-menu" aria-label="More options"><MoreHorizontal size={20} /></button>
    </div>
  );
}

function ResultsView({ result, onReset }: { result: ProcessResult; onReset: () => void }) {
  const videoCount = result.outputs.filter((output) => output.isVideo).length;
  return (
    <main className="results-view content-shell">
      <section className="result-heading">
        <div className="success-icon"><Check size={23} strokeWidth={2.5} /></div>
        <h1>Your stems are ready</h1>
        <p>{result.outputs.length} outputs ready · WAV{videoCount > 0 ? ` + ${videoCount} stem ${videoCount === 1 ? "video" : "videos"}` : ""}</p>
      </section>

      {result.usedDemoMode && (
        <div className="warning-banner"><CircleAlert size={18} /><span><strong>Preview processing was used.</strong> Install the audio-separator engine for AI-separated results.</span></div>
      )}

      <section className="results-list">
        {result.outputs.map((output) => <StemPlayer key={`${output.path}-${output.stem}-${output.isVideo}`} output={output} />)}
      </section>

      <section className="result-actions">
        <button className="primary-button" onClick={() => revealPath(result.outputDirectory)}><FolderOpen size={17} /> Show in Finder</button>
        <button className="secondary-button" onClick={onReset}><RotateCcw size={16} /> Separate something else</button>
      </section>

      {result.warnings.length > 0 && (
        <details className="warning-details"><summary><Info size={15} /> Notes from this run</summary>{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>
      )}
    </main>
  );
}

function SettingsSheet({ environment, onClose }: { environment: EnvironmentStatus | null; onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <aside className="settings-sheet" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-header"><div><span className="eyebrow">Preferences</span><h2>Settings</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
        <div className="setting-group">
          <h3>Output</h3>
          <div className="setting-row"><div><strong>Audio format</strong><span>Uncompressed, production-ready audio</span></div><b>WAV</b></div>
          <div className="setting-row"><div><strong>Video files</strong><span>Also create a copy of the video with each stem</span></div><b>On</b></div>
          <div className="setting-row"><div><strong>Save location</strong><span>A “Stem Separator” folder beside the source</span></div><b>Automatic</b></div>
        </div>
        <div className="setting-group">
          <h3>Engine</h3>
          <div className="engine-card">
            <span className={environment?.ffmpegAvailable ? "status-ok" : "status-warn"}>{environment?.ffmpegAvailable ? <CircleCheck size={18} /> : <CircleAlert size={18} />}</span>
            <div><strong>{environment?.engineLabel || "Checking local tools…"}</strong><span>{environment?.acceleration || ""}</span></div>
          </div>
          <p className="setting-note">Models are selected automatically from the ranking catalog and run locally. Your media is never uploaded.</p>
        </div>
      </aside>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("drop");
  const [files, setFiles] = useState<InputFile[]>([]);
  const [selected, setSelected] = useState<StemId[]>(["vocals", "instrumental"]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogRemote, setCatalogRemote] = useState(false);
  const [environment, setEnvironment] = useState<EnvironmentStatus | null>(null);
  const [progress, setProgress] = useState<JobProgress>({ jobId: "", overall: 2, fileIndex: 0, fileCount: 1, stage: "Preparing your audio", detail: "Checking the source and separation plan…" });
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = useMemo(() => catalog ? buildModelPlan(catalog, selected) : [], [catalog, selected]);

  useEffect(() => {
    loadCatalog().then(({ catalog: nextCatalog, remote }) => { setCatalog(nextCatalog); setCatalogRemote(remote); });
    detectEnvironment().then(setEnvironment).catch(() => undefined);
    if (new URLSearchParams(window.location.search).has("demo")) {
      setFiles([
        { path: "demo-session.wav", name: "studio-session.wav", extension: "wav", sizeBytes: 84_900_000, durationSeconds: 237, isVideo: false },
        { path: "demo-live.mov", name: "live-take.mov", extension: "mov", sizeBytes: 416_000_000, durationSeconds: 237, isVideo: true },
      ]);
      setView("select");
    }
  }, []);

  const addPaths = useCallback(async (paths: string[]) => {
    setError(null);
    if (!paths.length) return;
    try {
      const resolved = await resolveInputs(paths);
      setFiles((current) => [...current, ...resolved.filter((file) => !current.some((item) => item.path === file.path))]);
      setView("select");
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  useEffect(() => {
    if (!inTauri) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") setDragging(true);
      if (event.payload.type === "leave") setDragging(false);
      if (event.payload.type === "drop") {
        setDragging(false);
        void addPaths(event.payload.paths);
      }
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [addPaths]);

  useEffect(() => {
    if (!inTauri) return;
    let unlisten: (() => void) | undefined;
    listen<JobProgress>("job-progress", (event) => setProgress(event.payload)).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  const pick = async (folder = false) => {
    setError(null);
    if (!inTauri) {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = "audio/*,video/*";
      input.onchange = () => {
        const picked = Array.from(input.files || []).map<InputFile>((file) => ({
          path: URL.createObjectURL(file),
          name: file.name,
          extension: extension(file.name),
          sizeBytes: file.size,
          isVideo: file.type.startsWith("video/"),
        }));
        setFiles((current) => [...current, ...picked]);
        if (picked.length) setView("select");
      };
      input.click();
      return;
    }
    const selection = await open({
      multiple: !folder,
      directory: folder,
      filters: folder ? undefined : [{ name: "Audio and video", extensions: ["wav", "mp3", "flac", "m4a", "aac", "ogg", "mp4", "mov", "mkv", "webm"] }],
    });
    const paths = selection ? (Array.isArray(selection) ? selection : [selection]) : [];
    await addPaths(paths);
  };

  const start = async () => {
    if (!catalog || !files.length || !selected.length) return;
    setView("processing");
    setError(null);
    setProgress({ jobId: "starting", overall: 2, fileIndex: 0, fileCount: files.length, stage: "Preparing your audio", detail: "Checking the source and separation plan…", modelCount: plan.length });

    if (!inTauri) {
      let value = 2;
      const timer = window.setInterval(() => {
        value = Math.min(96, value + Math.max(1, (100 - value) * 0.07));
        const modelIndex = Math.min(plan.length, Math.max(1, Math.ceil((value / 94) * plan.length)));
        setProgress({ jobId: "preview", overall: value, fileIndex: 0, fileCount: files.length, stage: `Separating ${plan[modelIndex - 1]?.stems.map(stemLabel).join(" + ") || "audio"}`, detail: plan[modelIndex - 1]?.modelName || "Automatic model selection", modelIndex, modelCount: plan.length });
      }, 450);
      window.setTimeout(() => {
        window.clearInterval(timer);
        const outputs: OutputStem[] = selected.map((stem) => ({ path: files[0].path, name: `${files[0].name}-${stem}.wav`, stem, sourceName: files[0].name, isVideo: false, durationSeconds: files[0].durationSeconds }));
        setResult({ jobId: "preview", outputDirectory: "", outputs, warnings: ["The browser preview demonstrates the complete interface. Run the Tauri app for local AI separation."], usedDemoMode: true });
        setProgress((current) => ({ ...current, overall: 100 }));
        setView("results");
      }, 5200);
      return;
    }

    try {
      const nextResult = await processJob({ paths: files.map((file) => file.path), stems: selected, plan, keepVideo: true, demoMode: false });
      setResult(nextResult);
      setView("results");
    } catch (reason) {
      setError(String(reason));
      setView("select");
    }
  };

  const reset = () => {
    setFiles([]);
    setResult(null);
    setSelected(["vocals", "instrumental"]);
    setView("drop");
  };

  const goBack = () => {
    if (view === "select") reset();
    else if (view === "results") setView("select");
  };

  return (
    <div className={`app app-${view}`}>
      <Header view={view} onBack={goBack} onSettings={() => setSettingsOpen(true)} />
      {view === "drop" && <DropView onPick={pick} dragging={dragging} />}
      {view === "select" && <SelectView files={files} selected={selected} setSelected={setSelected} onRemove={(index) => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} onAdd={() => pick(false)} onStart={start} catalog={catalog} catalogRemote={catalogRemote} />}
      {view === "processing" && <ProcessingView progress={progress} files={files} plan={plan} selected={selected} />}
      {view === "results" && result && <ResultsView result={result} onReset={reset} />}
      {error && <div className="error-toast"><CircleAlert size={18} /><span>{error}</span><button onClick={() => setError(null)}><X size={16} /></button></div>}
      {settingsOpen && <SettingsSheet environment={environment} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
