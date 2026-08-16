import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronDown,
  CircleAlert,
  CircleCheck,
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
  Search,
  Square,
  Upload,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { availableCapabilities, availableStems, buildModelPlan, capabilityLabel, loadCatalog, recommendedMultiTrackModel, recommendedMultiTrackStems } from "./lib/catalog";
import { cancelJob, checkForUpdate, dragFile, inTauri, installUpdate, playableUrl, processJob, quitApp, requiredModelDownloads, resolveInputs, revealPath, setSeparationActive } from "./lib/native";
import { cancelServerJob, processServerJob, startServerUpload } from "./lib/server";
import type { ServerUploadHandle } from "./lib/server";
import { serverMode } from "./lib/runtime";
import type { Catalog, CatalogCapability, InputFile, JobProgress, OutputStem, ProcessResult, StemId, UpdateInfo, View } from "./types";

type StemOption = {
  id: StemId;
  label: string;
  glyph: string;
  group: string;
  groupLabel: string;
};

const PROMOTED_STEMS = ["vocals", "instrumental", "drums", "bass", "guitar", "piano"];

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

function stemLabel(stem: StemId, catalog: Catalog | null = null) {
  return capabilityLabel(catalog, stem);
}

function capabilityGlyph(capability: CatalogCapability) {
  if (capability.glyph) return capability.glyph;
  if (/vocal|voice|choir|dialogue/.test(capability.id)) return "voice";
  if (capability.id === "instrumental") return "wave";
  if (/drum|kick|snare|tom|hat|cymbal|ride|crash|percussion/.test(capability.id)) return "drum";
  if (/piano|keys|organ/.test(capability.id)) return "keys";
  if (/bass/.test(capability.id)) return "bass";
  if (/guitar|banjo|ukulele/.test(capability.id)) return "guitar";
  if (capability.id === "other") return "dots";
  return "generic";
}

function stemOption(capability: CatalogCapability): StemOption {
  return {
    id: capability.id,
    label: capability.label,
    glyph: capabilityGlyph(capability),
    group: capability.group,
    groupLabel: capability.groupLabel,
  };
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

function Header({ update, updating, updateProgress, onUpdate }: { update: UpdateInfo | null; updating: boolean; updateProgress: number | null; onUpdate: () => void }) {
  const startDragging = async (event: React.MouseEvent<HTMLElement>) => {
    if (!inTauri || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, summary")) return;
    await getCurrentWindow().startDragging();
  };

  return (
    <header className="app-header" data-tauri-drag-region onMouseDown={startDragging}>
      <div className="window-control-space" data-tauri-drag-region />
      <div className="header-drag-space" data-tauri-drag-region />
      {update?.available && <button className="update-button" disabled={updating} onClick={onUpdate} title={update.notes || `Install Stem Separator ${update.version}`}>
        {updating ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
        {updating ? updateProgress == null ? "Updating…" : `Downloading ${updateProgress}%` : `Update ${update.version}`}
      </button>}
    </header>
  );
}

function usePresentedProgress(progress: JobProgress) {
  const [presented, setPresented] = useState(progress);
  const latest = useRef(progress);
  const downloadTimer = useRef<number | null>(null);
  const presentedRef = useRef(progress);

  useEffect(() => {
    latest.current = progress;
    presentedRef.current = presented;
    if (progress.phase !== "download") {
      if (downloadTimer.current !== null) window.clearTimeout(downloadTimer.current);
      downloadTimer.current = null;
      setPresented(progress);
      return;
    }
    if (presented.phase === "download") {
      setPresented(progress);
      return;
    }
    if (downloadTimer.current === null) {
      downloadTimer.current = window.setTimeout(() => {
        const next = latest.current;
        if (next.phase === "download" || presentedRef.current.phase === "download") setPresented(next);
        downloadTimer.current = null;
      }, 650);
    }
  }, [presented.phase, progress]);

  useEffect(() => () => {
    if (downloadTimer.current !== null) window.clearTimeout(downloadTimer.current);
  }, []);

  return presented;
}

function StageProgress({ progress, active, done }: { progress: number; active: boolean; done: boolean }) {
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const value = done ? 100 : active ? progress : 0;
  return (
    <span className="stage-status">
      {done ? <CircleCheck className="stage-check" size={21} strokeWidth={2.2} /> : <>
        <svg className="stage-ring" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="stage-ring-track" cx="12" cy="12" r={radius} />
          <circle className="stage-ring-value" cx="12" cy="12" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value / 100)} />
        </svg>
      </>}
    </span>
  );
}

function DropView({ onPick, dragging }: { onPick: (folder?: boolean) => void; dragging: boolean }) {
  return (
    <main className={`drop-view ${dragging ? "is-dragging" : ""}`}>
      <section className="drop-copy">
        <div className="drop-icon"><Upload size={28} strokeWidth={1.75} /></div>
        <h1>Drop audio or video here</h1>
        <p>Choose a file, then pick the parts you want to hear.</p>
        <button className="primary-button" onClick={() => onPick(false)}>Choose files</button>
        {!serverMode && <button className="text-button" onClick={() => onPick(true)}><Folder size={15} /> Choose a folder</button>}
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

function StemCard({ stem, active, prominent = false, onClick }: { stem: StemOption; active: boolean; prominent?: boolean; onClick: () => void }) {
  return (
    <button className={`stem-card ${prominent ? "prominent" : ""} ${active ? "selected" : ""}`} aria-pressed={active} onClick={onClick}>
      <span className="stem-icon"><StemGlyph type={stem.glyph} /></span>
      <span className="stem-copy"><strong>{stem.label}</strong></span>
    </button>
  );
}

function SelectView({
  files,
  selected,
  multiTrack,
  setSelected,
  setMultiTrack,
  onRemove,
  onAdd,
  onStart,
  onBack,
  catalog,
  dragging,
}: {
  files: InputFile[];
  selected: StemId[];
  multiTrack: boolean;
  setSelected: (stems: StemId[]) => void;
  setMultiTrack: (enabled: boolean) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onStart: () => void;
  onBack: () => void;
  catalog: Catalog | null;
  dragging: boolean;
}) {
  const [showOtherStems, setShowOtherStems] = useState(false);
  const [stemSearch, setStemSearch] = useState("");
  const capabilities = useMemo(() => availableCapabilities(catalog), [catalog]);
  const capabilityById = useMemo(() => new Map(capabilities.map((capability) => [capability.id, capability])), [capabilities]);
  const promotedIds = catalog?.promoted?.length ? catalog.promoted : PROMOTED_STEMS;
  const promotedStems = promotedIds.flatMap((id) => {
    const capability = capabilityById.get(id);
    return capability ? [stemOption(capability)] : [];
  });
  const otherStems = capabilities
    .filter((capability) => !promotedIds.includes(capability.id) && capability.id !== "other")
    .map(stemOption);
  const normalizedSearch = stemSearch.trim().toLocaleLowerCase();
  const filteredOtherStems = otherStems.filter((stem) => !normalizedSearch
    || stem.label.toLocaleLowerCase().includes(normalizedSearch)
    || stem.id.toLocaleLowerCase().includes(normalizedSearch)
    || stem.groupLabel.toLocaleLowerCase().includes(normalizedSearch));
  const groupedOtherStems = filteredOtherStems.reduce((groups, stem) => {
    const current = groups.get(stem.groupLabel) || [];
    current.push(stem);
    groups.set(stem.groupLabel, current);
    return groups;
  }, new Map<string, StemOption[]>());
  const multiTrackModel = useMemo(() => recommendedMultiTrackModel(catalog), [catalog]);
  const multiTrackStems = useMemo(() => recommendedMultiTrackStems(catalog), [catalog]);
  const selectionReady = !!catalog && selected.length > 0 && (multiTrack
    ? multiTrackStems.length > 0
    : selected.every((stem) => capabilityById.has(stem)) && buildModelPlan(catalog, selected).length > 0);

  const toggleStem = (stem: StemId) => {
    if (multiTrack) {
      setMultiTrack(false);
      setSelected([stem]);
      return;
    }
    setMultiTrack(false);
    setSelected(selected.includes(stem) ? selected.filter((item) => item !== stem) : [...selected, stem]);
  };

  const chooseMultiTrack = () => {
    if (!multiTrackStems.length) return;
    setMultiTrack(true);
    setSelected([...multiTrackStems]);
  };

  return (
    <main className="select-view content-shell">
      <button className="page-back-button" onClick={onBack}><ChevronLeft size={16} strokeWidth={2.2} /> Back</button>

      <div className="choose-layout">
        <aside className={`file-panel ${dragging ? "is-dragging" : ""}`}>
          {dragging && <div className="add-drop-hint"><Upload size={18} /><span>Drop files here</span></div>}
          <header className="file-panel-heading">
            <h2>Files</h2>
            <span>{files.length}</span>
          </header>
          <div className="file-panel-list" aria-label={`${files.length} selected ${files.length === 1 ? "file" : "files"}`}>
            {files.map((file, index) => <FilePill key={`${file.path}-${index}`} file={file} onRemove={() => onRemove(index)} />)}
          </div>
          <button className="add-button" onClick={onAdd}><Plus size={16} /> Add files</button>
        </aside>

        <section className="stem-picker">
          <h1>Choose your stems</h1>
          <div className="stem-grid promoted-stem-grid">
            {promotedStems.map((stem) => <StemCard key={stem.id} stem={stem} prominent active={!multiTrack && selected.includes(stem.id)} onClick={() => toggleStem(stem.id)} />)}
          </div>

          {otherStems.length > 0 && <section className={`other-stems-section ${showOtherStems ? "open" : ""}`}>
            <button className="other-stems-toggle" onClick={() => setShowOtherStems((shown) => !shown)} aria-expanded={showOtherStems}>
              <span><strong>Other stems</strong><small>{otherStems.length} available</small></span>
              <ChevronDown size={17} />
            </button>
            {showOtherStems && <div className="other-stems-browser">
              <label className="stem-search">
                <Search size={15} />
                <input value={stemSearch} onChange={(event) => setStemSearch(event.target.value)} placeholder="Search stems" autoFocus />
              </label>
              {groupedOtherStems.size > 0
                ? [...groupedOtherStems].map(([groupLabel, stems]) => <section className="stem-group" key={groupLabel}>
                  <h2>{groupLabel}</h2>
                  <div className="other-stem-grid">{stems.map((stem) => <StemCard key={stem.id} stem={stem} active={!multiTrack && selected.includes(stem.id)} onClick={() => toggleStem(stem.id)} />)}</div>
                </section>)
                : <p className="no-stems-found">No stems match “{stemSearch.trim()}”.</p>}
            </div>}
          </section>}

          {multiTrackModel && <section className="multitrack-section" aria-label="Multi-Track">
            <button className={`multitrack-option ${multiTrack ? "selected" : ""}`} aria-pressed={multiTrack} onClick={chooseMultiTrack}>
              <span className="multitrack-option-icon"><StemGlyph type="multi" /></span>
              <span className="multitrack-option-copy">
                <strong>Multi-Track</strong>
                <small>{multiTrackStems.map((stem) => stemLabel(stem, catalog)).join(" · ")}</small>
              </span>
            </button>
          </section>}
        </section>
      </div>

      <footer className="selection-action-bar">
        <button className="primary-button start-button" disabled={!selectionReady} onClick={onStart}>
          {multiTrack ? "Create Multi-Track" : `Separate ${selected.length || ""} ${selected.length === 1 ? "stem" : "stems"}`}
        </button>
      </footer>
    </main>
  );
}

function ProcessingView({
  progress,
  files,
  plan,
  plannedDownloads,
  catalog,
  onStop,
}: {
  progress: JobProgress;
  files: InputFile[];
  plan: ReturnType<typeof buildModelPlan>;
  plannedDownloads: number[];
  catalog: Catalog | null;
  onStop: () => void;
}) {
  const displayedProgress = useSmoothedProgress(progress);
  const presentedProgress = usePresentedProgress(progress);
  const needsVideoPreparation = files.some((file) => file.isVideo);
  const needsAlignment = files.some((file) => file.extension !== "wav");
  const [sawUpload, setSawUpload] = useState(progress.phase === "upload");
  const [downloads, setDownloads] = useState<number[]>(plannedDownloads);

  useEffect(() => {
    if (presentedProgress.phase === "upload") setSawUpload(true);
  }, [presentedProgress.phase]);

  useEffect(() => {
    if (presentedProgress.phase !== "download" || !presentedProgress.modelIndex) return;
    setDownloads((current) => current.includes(presentedProgress.modelIndex!) ? current : [...current, presentedProgress.modelIndex!]);
  }, [presentedProgress.phase, presentedProgress.modelIndex]);

  const visibleDownloads = presentedProgress.phase === "download" && presentedProgress.modelIndex && !downloads.includes(presentedProgress.modelIndex)
    ? [...downloads, presentedProgress.modelIndex]
    : downloads;
  const includesUpload = sawUpload || presentedProgress.phase === "upload";
  const stages = useMemo(() => [
    ...(includesUpload ? [{
      id: "upload",
      label: "Sending your files",
      detail: files.length === 1 ? `Uploading ${files[0].name} securely` : `Uploading ${files.length} files securely`,
      phase: "upload" as const,
      modelIndex: 0,
    }] : []),
    ...visibleDownloads.map((modelIndex) => ({
      id: `download-${modelIndex}`,
      label: "Downloading the separation model",
      detail: `${plan[modelIndex - 1]?.modelName || "Separation model"} · needed for ${plan[modelIndex - 1]?.stems.map((stem) => stemLabel(stem, catalog)).join(" + ") || "this separation"}`,
      phase: "download" as const,
      modelIndex,
    })),
    ...(needsVideoPreparation ? [{
      id: "prepare",
      label: "Preparing video",
      detail: "Extracting the soundtrack for separation",
      phase: "prepare" as const,
      modelIndex: 0,
    }] : []),
    ...plan.map((run, index) => ({
      id: `separate-${index + 1}`,
      label: `Separating ${run.stems.map((stem) => stemLabel(stem, catalog)).join(" + ")}`,
      detail: `${run.modelName} · ${serverMode ? "running on this server" : "running locally"}`,
      phase: "separate" as const,
      modelIndex: index + 1,
    })),
    {
      id: "finish",
      label: "Finishing up",
      detail: needsAlignment ? "Aligning audio and writing output files" : "Writing output files",
      phase: "finish" as const,
      modelIndex: plan.length,
    },
  ], [catalog, files, includesUpload, needsAlignment, needsVideoPreparation, plan, visibleDownloads]);
  const phase = presentedProgress.phase || (presentedProgress.stage.startsWith("Uploading ") ? "upload" : presentedProgress.stage.startsWith("Downloading ") ? "download" : presentedProgress.stage === "Preparing video" ? "prepare" : presentedProgress.overall >= 98 || presentedProgress.stage === "Finishing up" || presentedProgress.stage.startsWith("Creating ") ? "finish" : "separate");
  const activeId = phase === "upload"
    ? "upload"
    : phase === "download"
    ? `download-${presentedProgress.modelIndex || 1}`
    : phase === "prepare"
      ? needsVideoPreparation ? "prepare" : "separate-1"
    : phase === "finish" || phase === "complete"
      ? "finish"
      : `separate-${presentedProgress.modelIndex || 1}`;
  const activeIndex = Math.max(0, stages.findIndex((stage) => stage.id === activeId));
  const [shownActiveId, setShownActiveId] = useState(activeId);
  const [leavingStageId, setLeavingStageId] = useState<string | null>(null);
  const currentShownIndex = Math.max(0, stages.findIndex((stage) => stage.id === shownActiveId));
  useEffect(() => {
    if (shownActiveId === activeId) return;
    if (activeIndex <= currentShownIndex) {
      setShownActiveId(activeId);
      setLeavingStageId(null);
      return;
    }
    const completedId = shownActiveId;
    const leaveTimer = window.setTimeout(() => setLeavingStageId(completedId), 1050);
    const advanceTimer = window.setTimeout(() => {
      setShownActiveId(activeId);
      setLeavingStageId(null);
    }, 1470);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(advanceTimer);
    };
  }, [activeId, activeIndex, currentShownIndex, shownActiveId]);
  const shownActiveIndex = Math.max(0, stages.findIndex((stage) => stage.id === shownActiveId));
  const visibleStart = shownActiveIndex;
  const visibleStages = stages.slice(visibleStart, shownActiveIndex + 4);
  const shownStage = stages[shownActiveIndex] || stages[activeIndex];
  const shownStepComplete = shownActiveIndex < activeIndex || phase === "complete";
  const activeHeadline = shownStage?.label || "Preparing separation";
  const activeDetail = shownStage?.detail || "Preparing the next step";
  const displayedPercent = phase === "complete" ? 100 : Math.max(1, Math.round(displayedProgress));
  const hasMoreStages = stages.length > shownActiveIndex + 4;
  return (
    <main className="processing-view content-shell">
      <section className="processing-card">
        <div className="processing-summary">
          <div className="activity-disc"><LoaderCircle size={25} strokeWidth={2.1} /></div>
          <div>
            <h1>{activeHeadline}</h1>
            <p>{activeDetail}</p>
          </div>
        </div>

        <div className="processing-overall">
        <div className="processing-topline">
          <span>{phase === "upload" ? "Uploading" : "Separating"} {files.length === 1 ? files[0].name : `${files.length} files`}</span>
          <strong>{displayedPercent}%</strong>
        </div>
        <div className="main-progress"><span style={{ width: `${Math.max(1, displayedProgress)}%` }} /></div>
        </div>

        <div className="stage-list" style={{
          "--visible-stage-count": visibleStages.length,
          "--more-stage-height": hasMoreStages ? "12px" : "0px",
        } as React.CSSProperties}>
          {visibleStages.map((stage, visibleIndex) => {
            const index = visibleStart + visibleIndex;
            const done = index < activeIndex || phase === "complete";
            const active = index === shownActiveIndex && !shownStepComplete;
            const phaseProgress = done ? 100 : active ? Math.min(100, Math.max(0, presentedProgress.phaseProgress ?? (stage.phase === "separate" ? presentedProgress.overall : 4))) : 0;
            return (
              <div className={`stage-row ${done ? "done" : ""} ${stage.id === leavingStageId ? "leaving" : ""} ${active ? "active" : ""} future-${Math.max(0, index - shownActiveIndex)}`} key={stage.id}>
                <StageProgress progress={phaseProgress} active={active} done={done} />
                <div className="stage-copy">
                  <div className="stage-title"><strong>{stage.label}</strong><span>{done ? "Done" : active ? `${Math.round(phaseProgress)}%` : "Waiting"}</span></div>
                  <small>{stage.detail}</small>
                </div>
              </div>
            );
          })}
          {hasMoreStages && <div className="more-stages" aria-hidden="true"><i /><i /><i /></div>}
        </div>

        <div className="processing-footer">
          <button className="stop-button" onClick={onStop}><Square size={13} fill="currentColor" /> Stop</button>
        </div>
      </section>
    </main>
  );
}

function Waveform({ seed, current, duration, onSeek }: { seed: string; current: number; duration: number; onSeek: (seconds: number) => void }) {
  const bars = useMemo(() => Array.from({ length: 160 }, (_, index) => {
    const char = seed.charCodeAt(index % Math.max(seed.length, 1)) || 71;
    return 22 + ((char * (index + 5) * 13) % 54);
  }), [seed]);
  const waveformRef = useRef<HTMLDivElement>(null);
  const seekAt = (clientX: number) => {
    const bounds = waveformRef.current?.getBoundingClientRect();
    if (!bounds || !duration) return;
    onSeek(Math.min(duration, Math.max(0, (clientX - bounds.left) / bounds.width * duration)));
  };
  const beginSeek = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    seekAt(event.clientX);
  };
  const moveSeek = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) seekAt(event.clientX);
  };
  const played = duration > 0 ? current / duration : 0;
  return <div
    ref={waveformRef}
    className="waveform"
    role="slider"
    tabIndex={0}
    aria-label="Playback timeline"
    aria-valuemin={0}
    aria-valuemax={Math.round(duration)}
    aria-valuenow={Math.round(current)}
    onPointerDown={beginSeek}
    onPointerMove={moveSeek}
    onWheel={(event) => { event.preventDefault(); onSeek(Math.min(duration, Math.max(0, current + (event.deltaY || event.deltaX) * duration / 1400))); }}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        onSeek(Math.min(duration, Math.max(0, current + (event.key === "ArrowRight" ? 5 : -5))));
      }
    }}
  >{bars.map((height, index) => <i className={(index + 1) / bars.length <= played ? "played" : ""} key={index} style={{ height: `${height}%` }} />)}</div>;
}

function StemPlayer({ output, catalog }: { output: OutputStem; catalog: Catalog | null }) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) await audio.play(); else audio.pause();
  };
  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds)) return;
    audio.currentTime = seconds;
    setCurrent(seconds);
  };
  const beginFileDrag = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!inTauri || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, [role=slider]")) return;
    event.preventDefault();
    void dragFile(output.path);
  };

  return (
    <div className={`result-row ${inTauri ? "file-draggable" : ""}`} onMouseDown={beginFileDrag} title={inTauri ? `Drag ${stemLabel(output.stem, catalog)} to another app` : undefined}>
      <audio ref={audioRef} src={playableUrl(output.path)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)} />
      <button className="play-button" onClick={toggle} aria-label={`${playing ? "Pause" : "Play"} ${stemLabel(output.stem, catalog)}`}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
      <div className="result-label"><strong>{stemLabel(output.stem, catalog)}</strong><span>{output.sourceName} · {output.isVideo ? "Video" : "WAV"}</span></div>
      <Waveform seed={output.name} current={current} duration={output.durationSeconds || audioRef.current?.duration || 0} onSeek={seek} />
      <span className="player-time">{formatTime(current)} / {formatTime(output.durationSeconds)}</span>
      {serverMode && <a className="stem-download" href={`${output.path}?download=1`} download={output.name} aria-label={`Download ${stemLabel(output.stem, catalog)}`} title={`Download ${output.name}`}><Download size={15} /></a>}
    </div>
  );
}

function ResultsView({ result, catalog, onReset, onBack }: { result: ProcessResult; catalog: Catalog | null; onReset: () => void; onBack: () => void }) {
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
      <button className="page-back-button" onClick={onBack}><ChevronLeft size={16} strokeWidth={2.2} /> Back</button>
      <section className="result-heading">
        <div className="success-icon"><Check size={23} strokeWidth={2.5} /></div>
        <h1>Your stems are ready</h1>
        <p>{visibleOutputs.length} {visibleOutputs.length === 1 ? "stem" : "stems"} ready{hasVideo ? " · Video versions shown" : " · WAV"}</p>
      </section>
      {result.usedDemoMode && <div className="warning-banner"><CircleAlert size={18} /><span><strong>Preview processing was used.</strong> {serverMode ? "Choose your own files to process them on this server." : "Run the desktop app for local separation."}</span></div>}
      <section className="results-list">{visibleOutputs.map((output) => <StemPlayer key={`${output.path}-${output.stem}-${output.isVideo}`} output={output} catalog={catalog} />)}</section>
      <section className="result-actions">
        {serverMode
          ? <a className="primary-button result-download-all" href={result.outputDirectory} download><Download size={17} /> Download all stems</a>
          : <button className="primary-button" onClick={() => revealPath(result.outputDirectory)}><FolderOpen size={17} /> Show in Finder</button>}
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

type ExitIntent = "close" | "quit";

function ConfirmExit({ intent, stopping, onCancel, onConfirm }: { intent: ExitIntent; stopping: boolean; onCancel: () => void; onConfirm: () => void }) {
  const quitting = intent === "quit";
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={stopping ? undefined : onCancel}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="exit-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="confirm-icon"><CircleAlert size={17} /></div>
        <h2 id="exit-title">{quitting ? "Quit Stem Separator?" : "Close Stem Separator?"}</h2>
        <p>Your separation is still running. {quitting ? "Quitting" : "Closing"} now will stop it, and any unfinished separation files will be lost.</p>
        <div className="confirm-actions">
          <button className="secondary-button" disabled={stopping} onClick={onCancel}>Keep processing</button>
          <button className="danger-button" disabled={stopping} onClick={onConfirm}>{stopping ? <LoaderCircle className="spin" size={16} /> : null} {quitting ? "Quit anyway" : "Close anyway"}</button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const demoMode = new URLSearchParams(window.location.search).has("demo");
  const [view, setView] = useState<View>("drop");
  const [files, setFiles] = useState<InputFile[]>([]);
  const [selected, setSelected] = useState<StemId[]>(["vocals"]);
  const [multiTrack, setMultiTrack] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [progress, setProgress] = useState<JobProgress>({ jobId: "", overall: 1, fileIndex: 0, fileCount: 1, stage: "Preparing your audio", detail: "Checking the source and separation plan…", phase: "separate", phaseProgress: 1 });
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [exitIntent, setExitIntent] = useState<ExitIntent | null>(null);
  const [stopping, setStopping] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [plannedDownloads, setPlannedDownloads] = useState<number[]>([]);
  const previewTimer = useRef<number | null>(null);
  const previewCompletion = useRef<number | null>(null);
  const cancelled = useRef(false);
  const starting = useRef(false);
  const browserFiles = useRef(new Map<string, File>());
  const uploadHandle = useRef<ServerUploadHandle | null>(null);
  const activeServerJobId = useRef<string | null>(null);
  const nativeJobCompletion = useRef<Promise<void> | null>(null);
  const uploadKey = useRef<string | null>(null);
  const uploadGeneration = useRef(0);
  const filesRef = useRef<InputFile[]>(files);
  const viewRef = useRef<View>(view);
  const allowWindowClose = useRef(false);
  const plan = useMemo(() => catalog ? buildModelPlan(catalog, selected, multiTrack) : [], [catalog, multiTrack, selected]);

  filesRef.current = files;
  viewRef.current = view;

  useEffect(() => {
    void setSeparationActive(view === "processing").catch(() => undefined);
  }, [view]);

  const beginBackgroundUpload = useCallback(() => {
    if (!serverMode || demoMode || filesRef.current.length === 0) return null;
    const inputs = filesRef.current;
    const uploads = inputs.map((file) => browserFiles.current.get(file.path)).filter((file): file is File => !!file);
    if (uploads.length !== inputs.length) return null;
    const generation = ++uploadGeneration.current;
    void uploadHandle.current?.cancel();
    const handle = startServerUpload(uploads, (snapshot) => {
      if (uploadGeneration.current !== generation) return;
      if (starting.current && viewRef.current === "processing" && snapshot.state === "uploading") {
        setProgress({
          jobId: "uploading",
          overall: 1 + 4 * snapshot.progress / 100,
          fileIndex: 0,
          fileCount: inputs.length,
          stage: "Uploading files",
          detail: inputs.length === 1 ? `Sending ${inputs[0].name} to this server` : `Sending ${inputs.length} files to this server`,
          phase: "upload",
          phaseProgress: snapshot.progress,
        });
      }
    });
    uploadHandle.current = handle;
    uploadKey.current = inputs.map((file) => file.path).join("\u0000");
    void handle.ready.catch(() => undefined);
    return handle;
  }, [demoMode]);

  useEffect(() => {
    loadCatalog().then(({ catalog: nextCatalog }) => { setCatalog(nextCatalog); });
    if (inTauri) checkForUpdate().then(setUpdate).catch(() => undefined);
    if (demoMode) {
      setFiles([
        { path: "demo-session.wav", name: "studio-session.wav", extension: "wav", sizeBytes: 84_900_000, durationSeconds: 237, isVideo: false },
        { path: "demo-live.mov", name: "live-take.mov", extension: "mov", sizeBytes: 416_000_000, durationSeconds: 237, isVideo: true },
      ]);
      setView("select");
    }
  }, []);

  useEffect(() => {
    if (!catalog) return;
    if (multiTrack) {
      const stems = recommendedMultiTrackStems(catalog);
      if (stems.length) setSelected(stems);
      else setMultiTrack(false);
      return;
    }
    const supported = new Set(availableStems(catalog));
    setSelected((current) => {
      const filtered = current.filter((stem) => supported.has(stem));
      return filtered.length ? filtered : supported.has("vocals") ? ["vocals"] : [...supported].slice(0, 1);
    });
  }, [catalog, multiTrack]);

  useEffect(() => {
    if (!serverMode || demoMode || view !== "select") return;
    if (files.length === 0) {
      void uploadHandle.current?.cancel();
      uploadHandle.current = null;
      uploadKey.current = null;
      return;
    }
    const key = files.map((file) => file.path).join("\u0000");
    const snapshot = uploadHandle.current?.snapshot();
    if (uploadKey.current === key && snapshot && snapshot.state !== "failed" && snapshot.state !== "cancelled") return;
    beginBackgroundUpload();
  }, [beginBackgroundUpload, demoMode, files, view]);

  useEffect(() => () => {
    if (previewTimer.current) window.clearInterval(previewTimer.current);
    if (previewCompletion.current) window.clearTimeout(previewCompletion.current);
    void uploadHandle.current?.cancel();
  }, []);

  const addPaths = useCallback(async (paths: string[]) => {
    if (!paths.length || viewRef.current === "results") return;
    setError(null);
    try {
      const resolved = await resolveInputs(paths);
      if ((viewRef.current as View) === "results") return;
      setFiles((current) => [...current, ...resolved.filter((file) => !current.some((item) => item.path === file.path))]);
      setView("select");
    } catch (reason) { setError(String(reason)); }
  }, []);

  useEffect(() => {
    if (!inTauri) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((event) => {
      if (view === "results") {
        setDragging(false);
        return;
      }
      if (event.payload.type === "over") setDragging(true);
      if (event.payload.type === "leave") setDragging(false);
      if (event.payload.type === "drop") { setDragging(false); void addPaths(event.payload.paths); }
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [addPaths, view]);

  useEffect(() => {
    if (!inTauri) return;
    let unlisten: (() => void) | undefined;
    listen<JobProgress>("job-progress", (event) => setProgress(event.payload)).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!inTauri) return;
    let unlistenClose: (() => void) | undefined;
    let unlistenQuit: (() => void) | undefined;
    getCurrentWindow().onCloseRequested((event) => {
      if (viewRef.current !== "processing" || allowWindowClose.current) return;
      event.preventDefault();
      setConfirmStop(false);
      setExitIntent("close");
    }).then((dispose) => { unlistenClose = dispose; });
    listen("app-quit-requested", () => {
      if (viewRef.current !== "processing") {
        void quitApp();
        return;
      }
      setConfirmStop(false);
      setExitIntent("quit");
    }).then((dispose) => { unlistenQuit = dispose; });
    return () => { unlistenClose?.(); unlistenQuit?.(); };
  }, []);

  const pick = async (folder = false) => {
    setError(null);
    if (!inTauri) {
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.accept = "audio/*,video/*";
      input.onchange = () => {
        const picked = Array.from(input.files || []).map<InputFile>((file) => {
          const path = URL.createObjectURL(file);
          browserFiles.current.set(path, file);
          return { path, name: file.name, extension: extension(file.name), sizeBytes: file.size, isVideo: file.type.startsWith("video/") || ["mp4", "mov", "mkv", "webm", "m4v", "avi"].includes(extension(file.name)) };
        });
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
    const plannedStems = new Set(plan.flatMap((run) => run.stems));
    if (plan.length === 0 || selected.some((stem) => !plannedStems.has(stem))) {
      setError("One or more selected stems are no longer available. Choose from the currently available stems and try again.");
      return;
    }
    starting.current = true;
    cancelled.current = false;
    let nextDownloads: number[] = [];
    if (inTauri) {
      try {
        nextDownloads = await requiredModelDownloads(plan);
      } catch (reason) {
        starting.current = false;
        setError(String(reason));
        return;
      }
    }
    setPlannedDownloads(nextDownloads);
    await setSeparationActive(true);
    viewRef.current = "processing";
    setView("processing");
    setError(null);
    const startsWithVideo = files.some((file) => file.isVideo);
    let serverUpload = uploadHandle.current;
    if (serverMode && !demoMode && (!serverUpload || ["failed", "cancelled"].includes(serverUpload.snapshot().state))) {
      serverUpload = beginBackgroundUpload();
    }
    const uploadPending = !!serverUpload && serverUpload.snapshot().state !== "complete";
    const firstDownload = nextDownloads[0];
    setProgress({
      jobId: uploadPending ? "uploading" : "starting",
      overall: uploadPending ? 1 + 4 * serverUpload!.snapshot().progress / 100 : 1,
      fileIndex: 0,
      fileCount: files.length,
      stage: uploadPending ? "Uploading files" : firstDownload ? "Downloading the separation model" : serverMode ? "Starting separation" : startsWithVideo ? "Preparing video" : `Separating ${plan[0]?.stems.map((stem) => stemLabel(stem, catalog)).join(" + ") || "audio"}`,
      detail: uploadPending
        ? files.length === 1 ? `Sending ${files[0].name} to this server` : `Sending ${files.length} files to this server`
        : firstDownload ? `${plan[firstDownload - 1]?.modelName || "Separation model"} · needed for this separation` : serverMode ? "The files are ready on this server" : startsWithVideo ? "Extracting the soundtrack for separation" : `${plan[0]?.modelName || "Separation model"} · running locally`,
      modelIndex: uploadPending || startsWithVideo ? undefined : firstDownload || 1,
      modelCount: plan.length,
      phase: uploadPending ? "upload" : firstDownload ? "download" : startsWithVideo ? "prepare" : "separate",
      phaseProgress: uploadPending ? serverUpload!.snapshot().progress : 1,
    });

    if (serverMode && !demoMode) {
      try {
        if (!serverUpload) throw new Error("One or more selected files are no longer available. Add them again and retry.");
        const activeUpload = serverUpload;
        const nextResult = await processServerJob(activeUpload, selected, multiTrack, setProgress, uploadPending ? 5 : 0, (jobId) => {
          activeServerJobId.current = jobId;
          if (uploadHandle.current === activeUpload) {
            uploadHandle.current = null;
            uploadKey.current = null;
          }
        });
        if (!cancelled.current) { setResult(nextResult); setView("results"); }
      } catch (reason) {
        if (!cancelled.current && !(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(String(reason));
          setView("select");
        }
      } finally {
        starting.current = false;
      }
      return;
    }

    if (!inTauri) {
      let value = 1;
      previewTimer.current = window.setInterval(() => {
        value = Math.min(92, value + 0.9);
        const modelIndex = Math.min(plan.length, Math.max(1, Math.ceil((value / 92) * plan.length)));
        setProgress({ jobId: "preview", overall: value, fileIndex: 0, fileCount: files.length, stage: `Separating ${plan[modelIndex - 1]?.stems.map((stem) => stemLabel(stem, catalog)).join(" + ") || "audio"}`, detail: plan[modelIndex - 1]?.modelName || "Automatic model selection", modelIndex, modelCount: plan.length, phase: "separate", phaseProgress: Math.min(100, value / 92 * plan.length * 100 - (modelIndex - 1) * 100) });
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
      const jobPromise = processJob({ paths: files.map((file) => file.path), stems: selected, plan, keepVideo: true, demoMode: false });
      nativeJobCompletion.current = jobPromise.then(() => undefined, () => undefined);
      const nextResult = await jobPromise;
      if (!cancelled.current) { setConfirmStop(false); setResult(nextResult); setView("results"); }
    } catch (reason) {
      if (!cancelled.current) { setError(String(reason)); setView("select"); }
    } finally {
      nativeJobCompletion.current = null;
      starting.current = false;
    }
  };

  const stop = async () => {
    setStopping(true);
    cancelled.current = true;
    if (previewTimer.current) window.clearInterval(previewTimer.current);
    if (previewCompletion.current) window.clearTimeout(previewCompletion.current);
    try {
      if (serverMode) {
        await uploadHandle.current?.cancel();
        await cancelServerJob(activeServerJobId.current || progress.jobId);
      }
      else {
        await cancelJob(progress.jobId === "starting" ? undefined : progress.jobId);
        await nativeJobCompletion.current;
      }
    }
    catch (reason) { setError(String(reason)); }
    finally {
      activeServerJobId.current = null;
      starting.current = false;
      await setSeparationActive(false).catch(() => undefined);
      setStopping(false);
      setConfirmStop(false);
      setExitIntent(null);
      viewRef.current = "select";
      setView("select");
    }
  };

  const exitAfterStopping = async () => {
    const intent = exitIntent;
    if (!intent) return;
    await stop();
    if (intent === "quit") await quitApp();
    else {
      allowWindowClose.current = true;
      await getCurrentWindow().close();
    }
  };

  const reset = () => {
    uploadGeneration.current += 1;
    void uploadHandle.current?.cancel();
    uploadHandle.current = null;
    activeServerJobId.current = null;
    uploadKey.current = null;
    for (const path of browserFiles.current.keys()) URL.revokeObjectURL(path);
    browserFiles.current.clear();
    setFiles([]); setResult(null); setSelected(["vocals"]); setMultiTrack(false); setView("drop");
  };
  const goBack = () => { if (view === "select") reset(); else if (view === "results") setView("select"); };
  const removeFile = (index: number) => {
    setFiles((current) => {
      const removed = current[index];
      if (removed && browserFiles.current.has(removed.path)) {
        URL.revokeObjectURL(removed.path);
        browserFiles.current.delete(removed.path);
      }
      const remaining = current.filter((_, itemIndex) => itemIndex !== index);
      if (remaining.length === 0) setView("drop");
      return remaining;
    });
  };

  const applyUpdate = async () => {
    setUpdating(true);
    setUpdateProgress(0);
    setError(null);
    try { await installUpdate(setUpdateProgress); }
    catch (reason) { setError(String(reason)); setUpdating(false); setUpdateProgress(null); }
  };

  return (
    <div
      className={`app app-${view} ${serverMode ? "server-app" : ""}`}
      onDragOver={serverMode && view !== "results" ? (event) => { event.preventDefault(); setDragging(true); } : undefined}
      onDragLeave={serverMode && view !== "results" ? (event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); } : undefined}
      onDrop={serverMode && view !== "results" ? (event) => {
        event.preventDefault();
        setDragging(false);
        const dropped = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("audio/") || file.type.startsWith("video/") || ["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus", "aiff", "aif", "wma", "mp4", "mov", "mkv", "webm", "m4v", "avi"].includes(extension(file.name)));
        const resolved = dropped.map<InputFile>((file) => {
          const path = URL.createObjectURL(file);
          browserFiles.current.set(path, file);
          return { path, name: file.name, extension: extension(file.name), sizeBytes: file.size, isVideo: file.type.startsWith("video/") || ["mp4", "mov", "mkv", "webm", "m4v", "avi"].includes(extension(file.name)) };
        });
        if (resolved.length) { setFiles((current) => [...current, ...resolved]); setView("select"); }
      } : undefined}
    >
      <Header update={update} updating={updating} updateProgress={updateProgress} onUpdate={applyUpdate} />
      {view === "drop" && <DropView onPick={pick} dragging={dragging} />}
      {view === "select" && <SelectView files={files} selected={selected} multiTrack={multiTrack} setSelected={setSelected} setMultiTrack={setMultiTrack} onRemove={removeFile} onAdd={() => pick(false)} onStart={start} onBack={goBack} catalog={catalog} dragging={dragging} />}
      {view === "processing" && <ProcessingView progress={progress} files={files} plan={plan} plannedDownloads={plannedDownloads} catalog={catalog} onStop={() => setConfirmStop(true)} />}
      {view === "results" && result && <ResultsView result={result} catalog={catalog} onReset={reset} onBack={goBack} />}
      {error && <div className="error-toast"><CircleAlert size={18} /><span>{error}</span><button onClick={() => setError(null)}><X size={16} /></button></div>}
      {view === "processing" && confirmStop && <ConfirmStop stopping={stopping} onCancel={() => setConfirmStop(false)} onConfirm={stop} />}
      {view === "processing" && exitIntent && <ConfirmExit intent={exitIntent} stopping={stopping} onCancel={() => setExitIntent(null)} onConfirm={exitAfterStopping} />}
    </div>
  );
}
