import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  Download,
  FileAudio,
  FileVideo,
  Folder,
  FolderOpen,
  Info,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
  Upload,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { availableStems, buildModelPlan, loadCatalog } from "./lib/catalog";
import { cancelJob, checkForUpdate, inTauri, installUpdate, playableUrl, processJob, resolveInputs, revealPath } from "./lib/native";
import type { Catalog, InputFile, JobProgress, OutputStem, ProcessResult, StemId, UpdateInfo, View } from "./types";

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
  { id: "kick", label: "Kick", description: "Kick drum and low-end hits", glyph: "drum", primary: false },
  { id: "snare", label: "Snare", description: "Snare and clap transients", glyph: "drum", primary: false },
  { id: "toms", label: "Toms", description: "Rack and floor toms", glyph: "drum", primary: false },
  { id: "hihat", label: "Hi-hat", description: "Open and closed hi-hats", glyph: "drum", primary: false },
  { id: "cymbals", label: "Cymbals", description: "Crashes, rides and cymbals", glyph: "drum", primary: false },
  { id: "other", label: "Other", description: "Everything not listed above", glyph: "dots", primary: false },
];

const MULTI_TRACK_STEMS: StemId[] = ["vocals", "drums", "bass", "guitar", "piano", "other"];

const QUICK_CONFIGS: Array<{ label: string; description: string; detail: string; glyph: string; stems: StemId[] }> = [
  { label: "Vocals Only", description: "Isolate lead and backing voices", detail: "Vocals", glyph: "voice", stems: ["vocals"] },
  { label: "Instrumental Only", description: "Keep the full mix without vocals", detail: "Instrumental", glyph: "wave", stems: ["instrumental"] },
  { label: "Multi-Track", description: "Split the complete mix into separate parts", detail: "Vocals · Drums · Bass · Guitar · Piano · Other", glyph: "multi", stems: MULTI_TRACK_STEMS },
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
  if (type === "multi") return <span className="glyph-multi"><i /><i /><i /><i /></span>;
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

function perceptualProgress(value: number) {
  const normalized = Math.min(1, Math.max(0, value) / 100);
  return 100 * Math.pow(normalized, 1.14);
}

function useSmoothedProgress(progress: JobProgress) {
  const target = perceptualProgress(progress.overall);
  const [displayed, setDisplayed] = useState(target);
  const jobId = progress.jobId;

  useEffect(() => {
    setDisplayed(perceptualProgress(progress.overall));
  }, [jobId]);

  useEffect(() => {
    if (progress.overall <= 1) {
      setDisplayed(target);
      return;
    }

    const timer = window.setInterval(() => {
      setDisplayed((current) => {
        if (target <= current) return current;
        const gap = target - current;
        const concluding = progress.overall >= 100
          || progress.stage === "Finishing up"
          || progress.stage.startsWith("Finished ")
          || progress.stage.startsWith("Creating ");
        const velocity = concluding
          ? Math.min(36, Math.max(12, gap * 0.45))
          : Math.min(9, Math.max(0.8 + current * 0.035, gap * 0.18));
        return Math.min(target, current + velocity / 10);
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [progress.overall, target]);

  return displayed;
}

function Header({ view, onBack, update, updating, onUpdate }: { view: View; onBack: () => void; update: UpdateInfo | null; updating: boolean; onUpdate: () => void }) {
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
        {showBack ? <button className="brand-lockup brand-button" onClick={onBack} aria-label="Go back">
          <Logo />
          <span className="brand-name">Stem Separator</span>
        </button> : <div className="brand-lockup" data-tauri-drag-region>
          <Logo />
          <span className="brand-name">Stem Separator</span>
        </div>}
      </div>
      <div className="header-drag-space" data-tauri-drag-region />
      {update?.available && <button className="update-button" disabled={updating} onClick={onUpdate} title={update.notes || `Install Stem Separator ${update.version}`}>
        {updating ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
        {updating ? "Updating…" : `Update ${update.version}`}
      </button>}
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
  dragging,
}: {
  files: InputFile[];
  selected: StemId[];
  setSelected: (stems: StemId[]) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onStart: () => void;
  catalog: Catalog | null;
  dragging: boolean;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const supportedStems = useMemo(() => new Set(availableStems(catalog)), [catalog]);
  const visibleStems = STEMS.filter((stem) => supportedStems.has(stem.id));
  const plan = useMemo(() => (catalog ? buildModelPlan(catalog, selected) : []), [catalog, selected]);

  const toggleStem = (stem: StemId) => {
    setSelected(selected.includes(stem) ? selected.filter((item) => item !== stem) : [...selected, stem]);
  };

  return (
    <main className="select-view content-shell">
      <section className={`file-row ${dragging ? "is-dragging" : ""}`}>
        {dragging && <div className="add-drop-hint"><Upload size={18} /><span>Drop files or a folder to add them</span></div>}
        <div className="file-list" aria-label={`${files.length} selected ${files.length === 1 ? "file" : "files"}`}>
          {files.map((file, index) => <FilePill key={`${file.path}-${index}`} file={file} onRemove={() => onRemove(index)} />)}
        </div>
        <button className="add-button" onClick={onAdd}><Plus size={16} /> Add</button>
      </section>

      <section className="stem-section">
        <h1>Choose your stems</h1>
        <p className="stem-intro">Start with a separation type, or customize the individual stems.</p>
        <div className="preset-grid" aria-label="Separation types">
          {QUICK_CONFIGS.map((preset) => (
            <button key={preset.label} className={`preset-card ${exactSelection(selected, preset.stems) ? "active" : ""}`} onClick={() => setSelected(preset.stems)}>
              <span className="preset-icon"><StemGlyph type={preset.glyph} /></span>
              <span className="preset-copy">
                <strong>{preset.label}</strong>
                <small>{preset.description}</small>
                <em>{preset.detail}</em>
              </span>
              <span className="preset-check">{exactSelection(selected, preset.stems) && <Check size={15} strokeWidth={3} />}</span>
            </button>
          ))}
        </div>

        <button className={`more-stems-toggle ${moreOpen ? "open" : ""}`} onClick={() => setMoreOpen((open) => !open)} aria-expanded={moreOpen}>
          <span><strong>More stems</strong></span>
          <ChevronDown size={16} />
        </button>
        {moreOpen && (
          <div className="manual-stems-panel">
            <div className="stem-grid more-stem-grid">
              {visibleStems.map((stem) => <StemCard key={stem.id} stem={stem} active={selected.includes(stem.id)} onClick={() => toggleStem(stem.id)} />)}
            </div>
          </div>
        )}
      </section>

      <section className="selection-footer">
        {plan.length > 1 ? (
          <div className="smart-plan">
            <span className="plan-bullet" />
            <span><strong>{plan.length} model passes required</strong></span>
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
  onStop,
}: {
  progress: JobProgress;
  files: InputFile[];
  plan: ReturnType<typeof buildModelPlan>;
  onStop: () => void;
}) {
  const displayedProgress = useSmoothedProgress(progress);
  const activeModel = Math.max(0, (progress.modelIndex || 1) - 1);
  const finishing = progress.overall >= 98 || progress.stage === "Finishing up" || progress.stage.startsWith("Creating ");
  const needsAlignment = files.some((file) => file.extension !== "wav");
  return (
    <main className="processing-view content-shell">
      <section className="processing-card">
        <div className="processing-topline">
          <span>Separating {files.length === 1 ? files[0].name : `${files.length} files`}</span>
          <strong>{Math.round(displayedProgress)}%</strong>
        </div>
        <div className="main-progress"><span style={{ width: `${Math.max(1, displayedProgress)}%` }} /></div>
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
            <div className="stage-copy"><strong>Finishing up</strong><span>{needsAlignment ? "Aligning and writing WAV files" : "Writing WAV files"}</span></div>
            <span className="stage-state">{finishing ? "Processing" : "Waiting"}</span>
          </div>
        </div>

        <div className="processing-footer">
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
  const [progress, setProgress] = useState<JobProgress>({ jobId: "", overall: 1, fileIndex: 0, fileCount: 1, stage: "Preparing your audio", detail: "Checking the source and separation plan…" });
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const previewTimer = useRef<number | null>(null);
  const previewCompletion = useRef<number | null>(null);
  const cancelled = useRef(false);
  const starting = useRef(false);
  const plan = useMemo(() => catalog ? buildModelPlan(catalog, selected) : [], [catalog, selected]);

  useEffect(() => {
    loadCatalog().then(({ catalog: nextCatalog }) => { setCatalog(nextCatalog); });
    if (inTauri) checkForUpdate().then(setUpdate).catch(() => undefined);
    if (new URLSearchParams(window.location.search).has("demo")) {
      setFiles([
        { path: "demo-session.wav", name: "studio-session.wav", extension: "wav", sizeBytes: 84_900_000, durationSeconds: 237, isVideo: false },
        { path: "demo-live.mov", name: "live-take.mov", extension: "mov", sizeBytes: 416_000_000, durationSeconds: 237, isVideo: true },
      ]);
      setView("select");
    }
  }, []);

  useEffect(() => {
    if (!catalog) return;
    const supported = new Set(availableStems(catalog));
    setSelected((current) => {
      const filtered = current.filter((stem) => supported.has(stem));
      return filtered.length ? filtered : supported.has("vocals") ? ["vocals"] : [...supported].slice(0, 1);
    });
  }, [catalog]);

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
    if (starting.current || !catalog || !files.length || !selected.length) return;
    starting.current = true;
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
        starting.current = false;
        setConfirmStop(false); setProgress((current) => ({ ...current, overall: 100 })); setView("results");
      }, 12500);
      return;
    }

    try {
      const nextResult = await processJob({ paths: files.map((file) => file.path), stems: selected, plan, keepVideo: true, demoMode: false });
      if (!cancelled.current) { setConfirmStop(false); setResult(nextResult); setView("results"); }
    } catch (reason) {
      if (!cancelled.current) { setError(String(reason)); setView("select"); }
    } finally {
      starting.current = false;
    }
  };

  const stop = async () => {
    setStopping(true);
    cancelled.current = true;
    if (previewTimer.current) window.clearInterval(previewTimer.current);
    if (previewCompletion.current) window.clearTimeout(previewCompletion.current);
    try { await cancelJob(progress.jobId === "starting" ? undefined : progress.jobId); }
    catch (reason) { setError(String(reason)); }
    finally { starting.current = false; setStopping(false); setConfirmStop(false); setView("select"); }
  };

  const reset = () => { setFiles([]); setResult(null); setSelected(["vocals"]); setView("drop"); };
  const goBack = () => { if (view === "select") reset(); else if (view === "results") setView("select"); };
  const removeFile = (index: number) => {
    setFiles((current) => {
      const remaining = current.filter((_, itemIndex) => itemIndex !== index);
      if (remaining.length === 0) setView("drop");
      return remaining;
    });
  };

  const applyUpdate = async () => {
    setUpdating(true);
    setError(null);
    try { await installUpdate(); }
    catch (reason) { setError(String(reason)); setUpdating(false); }
  };

  return (
    <div className={`app app-${view}`}>
      <Header view={view} onBack={goBack} update={update} updating={updating} onUpdate={applyUpdate} />
      {view === "drop" && <DropView onPick={pick} dragging={dragging} />}
      {view === "select" && <SelectView files={files} selected={selected} setSelected={setSelected} onRemove={removeFile} onAdd={() => pick(false)} onStart={start} catalog={catalog} dragging={dragging} />}
      {view === "processing" && <ProcessingView progress={progress} files={files} plan={plan} onStop={() => setConfirmStop(true)} />}
      {view === "results" && result && <ResultsView result={result} onReset={reset} />}
      {error && <div className="error-toast"><CircleAlert size={18} /><span>{error}</span><button onClick={() => setError(null)}><X size={16} /></button></div>}
      {view === "processing" && confirmStop && <ConfirmStop stopping={stopping} onCancel={() => setConfirmStop(false)} onConfirm={stop} />}
    </div>
  );
}
