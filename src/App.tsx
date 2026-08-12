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
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { buildModelPlan, loadCatalog } from "./lib/catalog";
import { cancelJob, inTauri, playableUrl, processJob, resolveInputs, revealPath } from "./lib/native";
import type { Catalog, InputFile, JobProgress, OutputStem, ProcessResult, StemId, View } from "./types";

type StemOption = {
  id: StemId;
  label: string;
  description: string;
  glyph: string;
  primary: boolean;
};

const STEMS: StemOption[] = [
  { id: "vocals", label: "Vocals", description: "Lead and backing voices", glyph: "voice", primary: true },
  { id: "instrumental", label: "Instrumental", description: "Everything except vocals", glyph: "wave", primary: true },
  { id: "drums", label: "Drums", description: "Kicks, snares and percussion", glyph: "drum", primary: true },
  { id: "bass", label: "Bass", description: "Bass guitar and synth bass", glyph: "bass", primary: true },
  { id: "guitar", label: "Guitar", description: "Electric and acoustic guitar", glyph: "guitar", primary: false },
  { id: "piano", label: "Piano", description: "Piano and keyboard parts", glyph: "keys", primary: false },
  { id: "strings", label: "Strings", description: "Approximate string section", glyph: "strings", primary: false },
  { id: "other", label: "Other", description: "Everything not listed above", glyph: "dots", primary: false },
];

const QUICK_CONFIGS: Array<{ label: string; stems: StemId[] }> = [
  { label: "Vocals only", stems: ["vocals"] },
  { label: "Instrumental only", stems: ["instrumental"] },
  { label: "Multi-Track", stems: ["vocals", "drums", "bass", "guitar", "piano", "other"] },
];

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

function exactSelection(first: StemId[], second: StemId[]) {
  return first.length === second.length && first.every((stem) => second.includes(stem));
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
  return <div className="brand-mark" aria-label="Stem Separator"><i /><i /><i /><i /><i /></div>;
}

function Header({ view, onBack }: { view: View; onBack: () => void }) {
  const showBack = view === "select" || view === "results";

  const startDragging = async (event: React.MouseEvent<HTMLElement>) => {
    if (!inTauri || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, summary")) return;
    await getCurrentWindow().startDragging();
  };

  return (
    <header className={`app-header ${showBack ? "has-back" : ""}`} data-tauri-drag-region onMouseDown={startDragging}>
      <div className="window-control-space" data-tauri-drag-region />
      <div className="header-content" data-tauri-drag-region>
        <div className="brand-lockup" data-tauri-drag-region>
          <Logo />
          <span className="brand-name">Stem Separator</span>
        </div>
        {showBack && (
          <button className="icon-button back-button" onClick={onBack} aria-label="Go back">
            <ArrowLeft size={19} strokeWidth={2} />
          </button>
        )}
      </div>
      <div className="header-drag-space" data-tauri-drag-region />
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

function StemCard({ stem, active, onClick }: { stem: StemOption; active: boolean; onClick: () => void }) {
  return (
    <button className={`stem-card ${active ? "selected" : ""}`} onClick={onClick}>
      <span className="stem-icon"><StemGlyph type={stem.glyph} /></span>
      <span className="stem-copy"><strong>{stem.label}</strong><small>{stem.description}</small></span>
      <span className="stem-check">{active && <Check size={14} strokeWidth={3} />}</span>
    </button>
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
  const [moreOpen, setMoreOpen] = useState(false);
  const plan = useMemo(() => (catalog ? buildModelPlan(catalog, selected) : []), [catalog, selected]);
  const primaryStems = STEMS.filter((stem) => stem.primary);
  const moreStems = STEMS.filter((stem) => !stem.primary);
  const hiddenSelected = moreStems.filter((stem) => selected.includes(stem.id)).length;

  const toggleStem = (stem: StemId) => {
    setSelected(selected.includes(stem) ? selected.filter((item) => item !== stem) : [...selected, stem]);
  };

  return (
    <main className="select-view content-shell">
      <section className="file-row">
        <div className="file-list">
          {files.slice(0, 2).map((file, index) => <FilePill key={`${file.path}-${index}`} file={file} onRemove={() => onRemove(index)} />)}
          {files.length > 2 && <div className="more-files">+{files.length - 2} more files</div>}
        </div>
        <button className="add-button" onClick={onAdd}><Plus size={16} /> Add</button>
      </section>

      <section className="stem-section">
        <div className="eyebrow">What would you like?</div>
        <h1>Choose your stems</h1>
        <div className="preset-row" aria-label="Quick configurations">
          {QUICK_CONFIGS.map((preset) => (
            <button key={preset.label} className={exactSelection(selected, preset.stems) ? "active" : ""} onClick={() => setSelected(preset.stems)}>
              {preset.label}
            </button>
          ))}
        </div>

        <div className="stem-grid">
          {primaryStems.map((stem) => <StemCard key={stem.id} stem={stem} active={selected.includes(stem.id)} onClick={() => toggleStem(stem.id)} />)}
        </div>

        <button className={`more-stems-toggle ${moreOpen ? "open" : ""}`} onClick={() => setMoreOpen((open) => !open)}>
          <span>More stems{hiddenSelected > 0 ? ` · ${hiddenSelected} selected` : ""}</span>
          <ChevronDown size={16} />
        </button>
        {moreOpen && (
          <div className="stem-grid more-stem-grid">
            {moreStems.map((stem) => <StemCard key={stem.id} stem={stem} active={selected.includes(stem.id)} onClick={() => toggleStem(stem.id)} />)}
          </div>
        )}
      </section>

      <section className="selection-footer">
        {plan.length > 1 ? (
          <div className="smart-plan">
            <Sparkles size={16} />
            <span><strong>{plan.length} model passes planned</strong> · handled automatically</span>
            <span className={`catalog-dot ${catalogRemote ? "remote" : ""}`} title={catalogRemote ? "Live catalog" : "Bundled catalog"} />
          </div>
        ) : <span />}
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
  onStop,
}: {
  progress: JobProgress;
  files: InputFile[];
  plan: ReturnType<typeof buildModelPlan>;
  selected: StemId[];
  onStop: () => void;
}) {
  const activeModel = Math.max(0, (progress.modelIndex || 1) - 1);
  const finishing = progress.overall >= 98 || progress.stage === "Finishing up" || progress.stage.startsWith("Creating ");
  return (
    <main className="processing-view content-shell">
      <section className="processing-card">
        <div className="processing-topline">
          <span>Separating {files.length === 1 ? files[0].name : `${files.length} files`}</span>
          <strong>{Math.round(progress.overall)}%</strong>
        </div>
        <div className="main-progress"><span style={{ width: `${Math.max(1, progress.overall)}%` }} /></div>
        <div className="processing-summary">
          <div className="pulse-disc"><span /></div>
          <div>
            <h1>{progress.stage || "Preparing your audio"}</h1>
            <p>{progress.detail || "Checking the source and preparing the separation plan…"}</p>
          </div>
        </div>

        <div className="stage-list">
          {plan.map((run, index) => {
            const done = index < activeModel || finishing;
            const active = index === activeModel && !finishing;
            return (
              <div className={`stage-row ${done ? "done" : ""} ${active ? "active" : ""}`} key={run.id}>
                <span className="stage-status">{done ? <CircleCheck size={19} /> : active ? <LoaderCircle className="spin" size={19} /> : <span className="empty-circle" />}</span>
                <div className="stage-copy"><strong>{run.stems.map(stemLabel).join(" + ")}</strong><span>{run.modelName}</span></div>
                <span className="stage-state">{done ? "Done" : active ? "Processing" : "Waiting"}</span>
              </div>
            );
          })}
          <div className={`stage-row ${finishing ? "active" : ""}`}>
            <span className="stage-status">{progress.overall >= 100 ? <CircleCheck size={19} /> : <span className="empty-circle" />}</span>
            <div className="stage-copy"><strong>Finishing up</strong><span>Aligning and writing WAV files</span></div>
            <span className="stage-state">{finishing ? "Processing" : "Waiting"}</span>
          </div>
        </div>

        <div className="processing-footer">
          <details className="technical-details">
            <summary><Gauge size={15} /> Technical details <ChevronDown size={15} /></summary>
            <div className="detail-grid">
              <span>Current file</span><strong>{progress.fileIndex + 1} of {progress.fileCount}</strong>
              <span>Selected output</span><strong>{selected.map(stemLabel).join(", ")}</strong>
              <span>Processing mode</span><strong>Local · WAV 44.1 kHz</strong>
              <span>Estimated time</span><strong>{progress.etaSeconds ? `About ${Math.max(1, Math.ceil(progress.etaSeconds / 60))} min` : "Calculating…"}</strong>
            </div>
          </details>
          <button className="stop-button" onClick={onStop}><Square size={13} fill="currentColor" /> Stop</button>
        </div>
      </section>
      <div className="processing-note"><Clock3 size={15} /> First use may take longer while the selected models download.</div>
    </main>
  );
}

function Waveform({ seed, active }: { seed: string; active: boolean }) {
  const bars = useMemo(() => Array.from({ length: 160 }, (_, index) => {
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
    if (audio.paused) await audio.play(); else audio.pause();
  };

  return (
    <div className="result-row">
      <audio ref={audioRef} src={playableUrl(output.path)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)} />
      <button className="play-button" onClick={toggle} aria-label={`${playing ? "Pause" : "Play"} ${stemLabel(output.stem)}`}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
      <div className="result-label"><strong>{stemLabel(output.stem)}</strong><span>{output.sourceName} · {output.isVideo ? "Video" : "WAV"}</span></div>
      <Waveform seed={output.name} active={playing} />
      <span className="player-time">{formatTime(current)} / {formatTime(output.durationSeconds)}</span>
    </div>
  );
}

function ResultsView({ result, onReset }: { result: ProcessResult; onReset: () => void }) {
  const visibleOutputs = useMemo(() => {
    const preferred = new Map<string, OutputStem>();
    for (const output of result.outputs) {
      const key = `${output.sourceName}\u0000${output.stem}`;
      const current = preferred.get(key);
      if (!current || output.isVideo) preferred.set(key, output);
    }
    return [...preferred.values()];
  }, [result.outputs]);
  const hasVideo = visibleOutputs.some((output) => output.isVideo);
  return (
    <main className="results-view content-shell">
      <section className="result-heading">
        <div className="success-icon"><Check size={23} strokeWidth={2.5} /></div>
        <h1>Your stems are ready</h1>
        <p>{visibleOutputs.length} {visibleOutputs.length === 1 ? "stem" : "stems"} ready{hasVideo ? " · Video versions shown" : " · WAV"}</p>
      </section>
      {result.usedDemoMode && <div className="warning-banner"><CircleAlert size={18} /><span><strong>Preview processing was used.</strong> Run the desktop app for local separation.</span></div>}
      <section className="results-list">{visibleOutputs.map((output) => <StemPlayer key={`${output.path}-${output.stem}-${output.isVideo}`} output={output} />)}</section>
      <section className="result-actions">
        <button className="primary-button" onClick={() => revealPath(result.outputDirectory)}><FolderOpen size={17} /> Show in Finder</button>
        <button className="secondary-button" onClick={onReset}><RotateCcw size={16} /> Separate something else</button>
      </section>
      {result.warnings.length > 0 && <details className="warning-details"><summary><Info size={15} /> Notes from this run</summary>{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}
    </main>
  );
}

function ConfirmStop({ stopping, onCancel, onConfirm }: { stopping: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={stopping ? undefined : onCancel}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="stop-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="confirm-icon"><Square size={15} fill="currentColor" /></div>
        <h2 id="stop-title">Stop separation?</h2>
        <p>The current model process will end. Any completed files will remain in the output folder.</p>
        <div className="confirm-actions">
          <button className="secondary-button" disabled={stopping} onClick={onCancel}>Keep processing</button>
          <button className="danger-button" disabled={stopping} onClick={onConfirm}>{stopping ? <LoaderCircle className="spin" size={16} /> : <Square size={12} fill="currentColor" />} Stop separation</button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("drop");
  const [files, setFiles] = useState<InputFile[]>([]);
  const [selected, setSelected] = useState<StemId[]>(["vocals"]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogRemote, setCatalogRemote] = useState(false);
  const [progress, setProgress] = useState<JobProgress>({ jobId: "", overall: 1, fileIndex: 0, fileCount: 1, stage: "Preparing your audio", detail: "Checking the source and separation plan…" });
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const previewTimer = useRef<number | null>(null);
  const previewCompletion = useRef<number | null>(null);
  const cancelled = useRef(false);
  const plan = useMemo(() => catalog ? buildModelPlan(catalog, selected) : [], [catalog, selected]);

  useEffect(() => {
    loadCatalog().then(({ catalog: nextCatalog, remote }) => { setCatalog(nextCatalog); setCatalogRemote(remote); });
    if (new URLSearchParams(window.location.search).has("demo")) {
      setFiles([
        { path: "demo-session.wav", name: "studio-session.wav", extension: "wav", sizeBytes: 84_900_000, durationSeconds: 237, isVideo: false },
        { path: "demo-live.mov", name: "live-take.mov", extension: "mov", sizeBytes: 416_000_000, durationSeconds: 237, isVideo: true },
      ]);
      setView("select");
    }
  }, []);

  useEffect(() => () => {
    if (previewTimer.current) window.clearInterval(previewTimer.current);
    if (previewCompletion.current) window.clearTimeout(previewCompletion.current);
  }, []);

  const addPaths = useCallback(async (paths: string[]) => {
    setError(null);
    if (!paths.length) return;
    try {
      const resolved = await resolveInputs(paths);
      setFiles((current) => [...current, ...resolved.filter((file) => !current.some((item) => item.path === file.path))]);
      setView("select");
    } catch (reason) { setError(String(reason)); }
  }, []);

  useEffect(() => {
    if (!inTauri) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") setDragging(true);
      if (event.payload.type === "leave") setDragging(false);
      if (event.payload.type === "drop") { setDragging(false); void addPaths(event.payload.paths); }
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
      input.type = "file"; input.multiple = true; input.accept = "audio/*,video/*";
      input.onchange = () => {
        const picked = Array.from(input.files || []).map<InputFile>((file) => ({ path: URL.createObjectURL(file), name: file.name, extension: extension(file.name), sizeBytes: file.size, isVideo: file.type.startsWith("video/") }));
        setFiles((current) => [...current, ...picked]);
        if (picked.length) setView("select");
      };
      input.click(); return;
    }
    const selection = await open({ multiple: !folder, directory: folder, filters: folder ? undefined : [{ name: "Audio and video", extensions: ["wav", "mp3", "flac", "m4a", "aac", "ogg", "mp4", "mov", "mkv", "webm"] }] });
    const paths = selection ? (Array.isArray(selection) ? selection : [selection]) : [];
    await addPaths(paths);
  };

  const start = async () => {
    if (!catalog || !files.length || !selected.length) return;
    cancelled.current = false;
    setView("processing");
    setError(null);
    setProgress({ jobId: "starting", overall: 1, fileIndex: 0, fileCount: files.length, stage: "Preparing your audio", detail: "Checking the source and separation plan…", modelCount: plan.length });

    if (!inTauri) {
      let value = 1;
      previewTimer.current = window.setInterval(() => {
        value = Math.min(92, value + 0.9);
        const modelIndex = Math.min(plan.length, Math.max(1, Math.ceil((value / 92) * plan.length)));
        setProgress({ jobId: "preview", overall: value, fileIndex: 0, fileCount: files.length, stage: `Separating ${plan[modelIndex - 1]?.stems.map(stemLabel).join(" + ") || "audio"}`, detail: plan[modelIndex - 1]?.modelName || "Automatic model selection", modelIndex, modelCount: plan.length });
      }, 120);
      previewCompletion.current = window.setTimeout(() => {
        if (previewTimer.current) window.clearInterval(previewTimer.current);
        const outputs: OutputStem[] = files.flatMap((file) => selected.flatMap((stem) => {
          const wav: OutputStem = { path: file.path, name: `${file.name}-${stem}.wav`, stem, sourceName: file.name, isVideo: false, durationSeconds: file.durationSeconds };
          return file.isVideo ? [wav, { ...wav, name: `${file.name}-${stem}.mp4`, isVideo: true }] : [wav];
        }));
        setResult({ jobId: "preview", outputDirectory: "", outputs, warnings: ["The browser preview demonstrates the complete interface."], usedDemoMode: true });
        setConfirmStop(false); setProgress((current) => ({ ...current, overall: 100 })); setView("results");
      }, 12500);
      return;
    }

    try {
      const nextResult = await processJob({ paths: files.map((file) => file.path), stems: selected, plan, keepVideo: true, demoMode: false });
      if (!cancelled.current) { setConfirmStop(false); setResult(nextResult); setView("results"); }
    } catch (reason) {
      if (!cancelled.current) { setError(String(reason)); setView("select"); }
    }
  };

  const stop = async () => {
    setStopping(true);
    cancelled.current = true;
    if (previewTimer.current) window.clearInterval(previewTimer.current);
    if (previewCompletion.current) window.clearTimeout(previewCompletion.current);
    try { await cancelJob(progress.jobId === "starting" ? undefined : progress.jobId); }
    catch (reason) { setError(String(reason)); }
    finally { setStopping(false); setConfirmStop(false); setView("select"); }
  };

  const reset = () => { setFiles([]); setResult(null); setSelected(["vocals"]); setView("drop"); };
  const goBack = () => { if (view === "select") reset(); else if (view === "results") setView("select"); };

  return (
    <div className={`app app-${view}`}>
      <Header view={view} onBack={goBack} />
      {view === "drop" && <DropView onPick={pick} dragging={dragging} />}
      {view === "select" && <SelectView files={files} selected={selected} setSelected={setSelected} onRemove={(index) => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} onAdd={() => pick(false)} onStart={start} catalog={catalog} catalogRemote={catalogRemote} />}
      {view === "processing" && <ProcessingView progress={progress} files={files} plan={plan} selected={selected} onStop={() => setConfirmStop(true)} />}
      {view === "results" && result && <ResultsView result={result} onReset={reset} />}
      {error && <div className="error-toast"><CircleAlert size={18} /><span>{error}</span><button onClick={() => setError(null)}><X size={16} /></button></div>}
      {view === "processing" && confirmStop && <ConfirmStop stopping={stopping} onCancel={() => setConfirmStop(false)} onConfirm={stop} />}
    </div>
  );
}
