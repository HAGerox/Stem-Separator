const stemRoot = document.querySelector("#stems");
fetch("/api/models").then((response) => response.json()).then((registry) => {
  registry.stems.forEach((stem) => {
    const checked = stem === "vocals" || stem === "instrumental" ? "checked" : "";
    const label = stem === "hihat" ? "Hi-hat" : stem[0].toUpperCase() + stem.slice(1);
    stemRoot.insertAdjacentHTML("beforeend", `<label><input type="checkbox" value="${stem}" ${checked}><span>${label}</span></label>`);
  });
  document.querySelector("#registry").textContent = `${registry.remote ? "Live" : "Bundled"} model registry · ${registry.generatedAt}`;
}).catch(() => stemRoot.textContent = "Could not load the model registry.");

fetch("/api/update").then((response) => response.json()).then((update) => {
  if (!update.available) return;
  const banner = document.querySelector("#update");
  banner.classList.remove("hidden");
  banner.textContent = update.method === "container"
    ? `Version ${update.version} is available. Pull the latest ghcr.io/hagerox/stem-separator-server image and recreate this container.`
    : `Version ${update.version} is available. Run: stem-separator-server-update`;
}).catch(() => undefined);

const environment = document.querySelector("#environment");
fetch("/api/environment").then((response) => response.json()).then((data) => {
  environment.classList.toggle("ready", data.cudaReady);
  environment.textContent = data.cudaReady
    ? `CUDA ready · ${data.cudaDevice} · Torch ${data.torchVersion}${data.onnxCudaReady ? " · ONNX CUDA" : ""}`
    : `CUDA is not ready · Torch CUDA: ${data.torchCuda ? "yes" : "no"} · ONNX: ${data.onnxProviders.join(", ") || "unavailable"}`;
}).catch(() => environment.textContent = "Could not read server environment.");

const fileInput = document.querySelector("#file");
fileInput.addEventListener("change", () => {
  document.querySelector("#file-label").textContent = fileInput.files[0]?.name || "Choose an audio or video file";
});

const form = document.querySelector("#job-form");
const panel = document.querySelector("#job");
const stage = document.querySelector("#job-stage");
const detail = document.querySelector("#job-detail");
const progress = document.querySelector("#job-progress");
const bar = document.querySelector("#job-bar");
const errorBox = document.querySelector("#job-error");
const download = document.querySelector("#download");

async function poll(jobId) {
  const response = await fetch(`/api/jobs/${jobId}`);
  const job = await response.json();
  stage.textContent = job.stage;
  detail.textContent = job.detail;
  progress.textContent = `${Math.round(job.progress)}%`;
  bar.style.width = `${job.progress}%`;
  if (job.status === "complete") {
    download.href = job.downloadUrl;
    download.classList.remove("hidden");
    form.querySelector("button").disabled = false;
    return;
  }
  if (job.status === "failed") {
    errorBox.textContent = job.error;
    errorBox.classList.remove("hidden");
    form.querySelector("button").disabled = false;
    return;
  }
  setTimeout(() => poll(jobId), 1000);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const selected = [...stemRoot.querySelectorAll("input:checked")].map((input) => input.value);
  if (!fileInput.files[0] || !selected.length) return;
  form.querySelector("button").disabled = true;
  panel.classList.remove("hidden");
  download.classList.add("hidden");
  errorBox.classList.add("hidden");
  stage.textContent = "Uploading";
  detail.textContent = fileInput.files[0].name;
  progress.textContent = "0%";
  bar.style.width = "0%";
  const body = new FormData();
  body.append("file", fileInput.files[0]);
  body.append("stems", selected.join(","));
  const response = await fetch("/api/jobs", { method: "POST", body });
  const job = await response.json();
  if (!response.ok) {
    errorBox.textContent = job.detail || "Could not create the job.";
    errorBox.classList.remove("hidden");
    form.querySelector("button").disabled = false;
    return;
  }
  poll(job.id);
});
