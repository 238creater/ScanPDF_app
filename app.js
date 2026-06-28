const $ = (id) => document.getElementById(id);

const screens = {
  home: $("homeScreen"),
  capture: $("captureScreen"),
  edit: $("editScreen"),
  review: $("reviewScreen"),
};

const camera = $("camera");
const cameraFallback = $("cameraFallback");
const liveOverlay = $("liveOverlay");
const editCanvas = $("editCanvas");
const editOverlay = $("editOverlay");
const pageList = $("pageList");
const thumbList = $("thumbList");
const historyList = $("historyList");
const emptyHistory = $("emptyHistory");
const homeStatus = $("homeStatus");
const reviewStatus = $("reviewStatus");
const captureCount = $("captureCount");

const historyKey = "scanToPdf.history.v2";
const settingsKey = "scanToPdf.settings.v2";
const defaultSettings = { paper: "a4", quality: "0.88", filter: "document", brightness: "0", contrast: "8" };
const points = ["tl", "tr", "br", "bl"];
const edges = [
  ["top", "tl", "tr"],
  ["right", "tr", "br"],
  ["bottom", "bl", "br"],
  ["left", "tl", "bl"],
];

let stream = null;
let torchOn = false;
let liveTimer = null;
let liveCorners = null;
let liveTargetCorners = null;
let liveAnimation = null;
let liveMisses = 0;
let pages = [];
let editing = null;
let drag = null;
let editReturnScreen = "capture";
let currentProjectId = null;
let pendingCanvases = [];
let history = loadHistory();
let appSettings = loadSettings();
let lastPdfBlob = null;

$("newScanBtn").addEventListener("click", () => startProject(true));
$("homeFileInput").addEventListener("change", addHomeFiles);
$("fileInput").addEventListener("change", addFiles);
$("closeCaptureBtn").addEventListener("click", showReviewOrHome);
$("captureBtn").addEventListener("click", capturePhoto);
$("reviewFromCaptureBtn").addEventListener("click", showReview);
$("backToCaptureBtn").addEventListener("click", showCapture);
$("backToHomeBtn").addEventListener("click", showHome);
$("cancelEditBtn").addEventListener("click", cancelEdit);
$("autoDetectBtn").addEventListener("click", autoDetectEdit);
$("viewModeBtn").addEventListener("click", toggleEditView);
$("addAndShootBtn").addEventListener("click", () => commitEdit("capture"));
$("addAndReviewBtn").addEventListener("click", () => commitEdit("review"));
$("shareBtn").addEventListener("click", sharePdf);
$("downloadBtn").addEventListener("click", downloadPdf);
$("jpegBtn").addEventListener("click", downloadJpeg);
$("flashSelect").addEventListener("change", updateFlash);
$("captureModeSelect").addEventListener("change", updateCaptureMode);
$("paperSelect").addEventListener("change", updateProjectSettings);
$("filterSelect").addEventListener("change", updateEditPreview);
$("brightnessRange").addEventListener("input", updateEditPreview);
$("contrastRange").addEventListener("input", updateEditPreview);
window.addEventListener("resize", () => {
  drawEdit();
  drawLiveOverlay();
});

init();

function init() {
  appSettings = normalizeSettings(appSettings);
  $("captureModeSelect").value = captureModeValue(appSettings.filter);
  renderHistory();
  showOnly("home");
}

async function startProject(useCamera) {
  currentProjectId = crypto.randomUUID();
  pages = [];
  pendingCanvases = [];
  applySettingsToReview(appSettings);
  updateCount();
  if (useCamera) await showCapture();
  else showReview();
}

function showOnly(name) {
  Object.entries(screens).forEach(([key, screen]) => {
    screen.hidden = key !== name;
  });
  if (name !== "capture") cameraFallback.hidden = true;
}

async function showCapture() {
  showOnly("capture");
  await startCamera();
  updateCount();
}

function showReview() {
  stopLiveDetection();
  showOnly("review");
  renderPages();
  updateReviewStatus();
}

function updateCaptureMode() {
  appSettings = normalizeSettings({ ...appSettings, filter: $("captureModeSelect").value });
  localStorage.setItem(settingsKey, JSON.stringify(appSettings));
}

function showReviewOrHome() {
  if (pages.length) showReview();
  else showHome();
}

function showHome() {
  stopCamera();
  stopLiveDetection();
  showOnly("home");
  renderHistory();
  homeStatus.textContent = "紙を撮ってPDFにできます。";
}

async function startCamera() {
  if (stream) {
    cameraFallback.hidden = true;
    $("captureBtn").disabled = false;
    startLiveDetection();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraFallback.hidden = false;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    camera.srcObject = stream;
    await camera.play();
    cameraFallback.hidden = true;
    $("captureBtn").disabled = false;
    startLiveDetection();
    updateFlash();
  } catch (error) {
    cameraFallback.hidden = false;
  }
}

function stopCamera() {
  stopLiveDetection();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
  stream = null;
  camera.srcObject = null;
  $("captureBtn").disabled = true;
  cameraFallback.hidden = true;
}

function startLiveDetection() {
  stopLiveDetection();
  liveTimer = window.setInterval(detectLiveFrame, 180);
  animateLiveCorners();
}

function stopLiveDetection() {
  if (liveTimer) window.clearInterval(liveTimer);
  if (liveAnimation) cancelAnimationFrame(liveAnimation);
  liveTimer = null;
  liveAnimation = null;
  liveTargetCorners = null;
  liveMisses = 0;
  liveOverlay.innerHTML = "";
}

function detectLiveFrame() {
  if (!camera.videoWidth) return;
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 760 / Math.max(camera.videoWidth, camera.videoHeight));
  canvas.width = Math.round(camera.videoWidth * scale);
  canvas.height = Math.round(camera.videoHeight * scale);
  canvas.getContext("2d").drawImage(camera, 0, 0, canvas.width, canvas.height);
  const detected = detectDocumentCorners(canvas, true);
  if (detected) {
    liveTargetCorners = scaleCorners(detected, 1 / scale);
    if (!liveCorners) liveCorners = structuredClone(liveTargetCorners);
    liveMisses = 0;
  } else {
    liveMisses += 1;
    if (liveMisses > 4) {
      liveTargetCorners = null;
      liveCorners = null;
      liveOverlay.innerHTML = "";
    }
  }
}

function animateLiveCorners() {
  if (liveTargetCorners) {
    liveCorners = liveCorners ? mixCorners(liveCorners, liveTargetCorners, 0.16) : structuredClone(liveTargetCorners);
    drawLiveOverlay();
  }
  liveAnimation = requestAnimationFrame(animateLiveCorners);
}

function drawLiveOverlay() {
  liveOverlay.innerHTML = "";
  if (!liveCorners || !camera.videoWidth) return;
  liveOverlay.setAttribute("viewBox", `0 0 ${camera.videoWidth} ${camera.videoHeight}`);
  drawCornerMarks(liveOverlay, liveCorners, Math.min(camera.videoWidth, camera.videoHeight) * 0.055, "liveCorner");
}

async function updateFlash() {
  const mode = $("flashSelect").value;
  const track = stream?.getVideoTracks?.()[0];
  const capabilities = track?.getCapabilities?.();
  if (!track || !capabilities?.torch) return;
  const nextTorch = mode === "on";
  if (nextTorch === torchOn) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: nextTorch }] });
    torchOn = nextTorch;
  } catch (error) {
    torchOn = false;
  }
}

async function capturePhoto() {
  if (!camera.videoWidth) return;
  const { canvas, offsetX, offsetY, scale } = captureVisibleVideoFrame();
  const corners = liveCorners && liveTargetCorners
    ? translateCorners(liveCorners, offsetX, offsetY, scale, canvas.width, canvas.height)
    : detectDocumentCorners(canvas, false);
  stopLiveDetection();
  openEdit(canvas, corners);
}

function captureVisibleVideoFrame() {
  const rect = camera.getBoundingClientRect();
  const videoW = camera.videoWidth;
  const videoH = camera.videoHeight;
  const displayW = Math.max(1, rect.width);
  const displayH = Math.max(1, rect.height);
  const coverScale = Math.max(displayW / videoW, displayH / videoH);
  const visibleW = displayW / coverScale;
  const visibleH = displayH / coverScale;
  const sx = Math.max(0, (videoW - visibleW) / 2);
  const sy = Math.max(0, (videoH - visibleH) / 2);
  const longSide = 1800;
  const outputScale = Math.min(1, longSide / Math.max(visibleW, visibleH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(visibleW * outputScale);
  canvas.height = Math.round(visibleH * outputScale);
  canvas.getContext("2d").drawImage(camera, sx, sy, visibleW, visibleH, 0, 0, canvas.width, canvas.height);
  return { canvas, offsetX: sx, offsetY: sy, scale: outputScale };
}

function translateCorners(corners, offsetX, offsetY, scale, width, height) {
  const translated = {};
  for (const name of points) {
    translated[name] = {
      x: clamp((corners[name].x - offsetX) * scale, 0, width),
      y: clamp((corners[name].y - offsetY) * scale, 0, height),
    };
  }
  return polygonArea(translated) > width * height * 0.08 ? translated : defaultCorners(width, height);
}

async function addHomeFiles(event) {
  const canvases = await filesToCanvases(event.target.files);
  event.target.value = "";
  await startProject(false);
  pendingCanvases.push(...canvases);
  openNextPendingImage();
}

async function addFiles(event) {
  pendingCanvases.push(...(await filesToCanvases(event.target.files)));
  event.target.value = "";
  editReturnScreen = "review";
  openNextPendingImage();
}

function filesToCanvases(fileList) {
  return Promise.all([...fileList].map(fileToCanvas));
}

function fileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(image.src);
      resolve(canvas);
    };
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });
}

function openNextPendingImage() {
  const canvas = pendingCanvases.shift();
  if (!canvas) return;
  openEdit(canvas, detectDocumentCorners(canvas, false));
}

function openEdit(canvas, corners, pageId = null) {
  if (!screens.review.hidden) editReturnScreen = "review";
  else if (!screens.capture.hidden) editReturnScreen = "capture";
  showOnly("edit");
  editing = {
    pageId,
    source: canvas,
    corners: corners || defaultCorners(canvas.width, canvas.height),
    viewMode: "crop",
  };
  appSettings = normalizeSettings(appSettings);
  $("filterSelect").value = appSettings.filter;
  $("brightnessRange").value = appSettings.brightness;
  $("contrastRange").value = appSettings.contrast;
  drawEdit();
  updateEditPreview();
}

function cancelEdit() {
  editing = null;
  if (pendingCanvases.length) openNextPendingImage();
  else if (editReturnScreen === "review") showReview();
  else showCapture();
}

function showReviewOrCapture() {
  if (pages.length) showReview();
  else showCapture();
}

function autoDetectEdit() {
  if (!editing) return;
  editing.corners = detectDocumentCorners(editing.source, false) || defaultCorners(editing.source.width, editing.source.height);
  drawEdit();
  updateEditPreview();
}

function drawEdit() {
  if (!editing) return;
  const wrap = $("canvasWrap");
  const image = editing.viewMode === "crop" ? applyFilter(warpQuad(editing.source, editing.corners)) : editing.source;
  const scale = Math.min(wrap.clientWidth / image.width, wrap.clientHeight / image.height);
  const displayWidth = Math.round(image.width * scale);
  const displayHeight = Math.round(image.height * scale);
  editCanvas.width = image.width;
  editCanvas.height = image.height;
  editCanvas.style.width = `${displayWidth}px`;
  editCanvas.style.height = `${displayHeight}px`;
  editOverlay.style.width = `${displayWidth}px`;
  editOverlay.style.height = `${displayHeight}px`;
  editOverlay.style.left = `${(wrap.clientWidth - displayWidth) / 2}px`;
  editOverlay.style.top = `${(wrap.clientHeight - displayHeight) / 2}px`;
  editOverlay.setAttribute("viewBox", `0 0 ${image.width} ${image.height}`);
  editCanvas.getContext("2d").drawImage(image, 0, 0, image.width, image.height);
  $("viewModeBtn").textContent = editing.viewMode === "crop" ? "元写真" : "切取";
  drawEditOverlay();
}

function drawEditOverlay() {
  if (editing.viewMode === "crop") {
    editOverlay.innerHTML = "";
    editOverlay.style.pointerEvents = "none";
    return;
  }
  editOverlay.style.pointerEvents = "auto";
  const c = editing.corners;
  editOverlay.innerHTML = "";
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", `${c.tl.x},${c.tl.y} ${c.tr.x},${c.tr.y} ${c.br.x},${c.br.y} ${c.bl.x},${c.bl.y}`);
  editOverlay.appendChild(polygon);
  editOverlay.onpointerdown = startOverlayDrag;
  editOverlay.onpointermove = moveOverlayDrag;
  editOverlay.onpointerup = endOverlayDrag;
  editOverlay.onpointercancel = endOverlayDrag;

  for (const name of points) {
    const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    handle.setAttribute("cx", c[name].x);
    handle.setAttribute("cy", c[name].y);
    handle.setAttribute("r", 20);
    editOverlay.appendChild(handle);
  }
  for (const [, a, b] of edges) {
    const midpoint = { x: (c[a].x + c[b].x) / 2, y: (c[a].y + c[b].y) / 2 };
    const handle = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    handle.setAttribute("x", midpoint.x - 17);
    handle.setAttribute("y", midpoint.y - 17);
    handle.setAttribute("width", 34);
    handle.setAttribute("height", 34);
    handle.setAttribute("rx", 7);
    editOverlay.appendChild(handle);
  }
}

function startOverlayDrag(event) {
  if (!editing || editing.viewMode !== "original") return;
  event.preventDefault();
  editOverlay.setPointerCapture(event.pointerId);
  const point = pointerToImage(event);
  const target = nearestHandle(point);
  drag = {
    ...target,
    start: point,
    corners: structuredClone(editing.corners),
  };
}

function moveOverlayDrag(event) {
  if (!drag) return;
  const point = pointerToImage(event);
  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  editing.corners = structuredClone(drag.corners);
  if (drag.kind === "corner") {
    editing.corners[drag.name] = clampPoint(point);
  } else {
    editing.corners[drag.a] = clampPoint({ x: drag.corners[drag.a].x + dx, y: drag.corners[drag.a].y + dy });
    editing.corners[drag.b] = clampPoint({ x: drag.corners[drag.b].x + dx, y: drag.corners[drag.b].y + dy });
  }
  drawEditOverlay();
}

function endOverlayDrag() {
  if (drag) drawEdit();
  drag = null;
}

function toggleEditView() {
  if (!editing) return;
  editing.viewMode = editing.viewMode === "crop" ? "original" : "crop";
  drawEdit();
}

function nearestHandle(point) {
  let best = { kind: "corner", name: "tl", distance: Infinity };
  for (const name of points) {
    const d = distance(point, editing.corners[name]);
    if (d < best.distance) best = { kind: "corner", name, distance: d };
  }
  for (const [name, a, b] of edges) {
    const midpoint = {
      x: (editing.corners[a].x + editing.corners[b].x) / 2,
      y: (editing.corners[a].y + editing.corners[b].y) / 2,
    };
    const d = distance(point, midpoint);
    if (d < best.distance) best = { kind: "edge", name, a, b, distance: d };
  }
  return best;
}

function pointerToImage(event) {
  const rect = editOverlay.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * editing.source.width,
    y: ((event.clientY - rect.top) / rect.height) * editing.source.height,
  };
}

function clampPoint(point) {
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(editing.source.width - margin, point.x)),
    y: Math.max(margin, Math.min(editing.source.height - margin, point.y)),
  };
}

function updateEditPreview() {
  updateEditSettings();
  if (editing) editing.viewMode = "crop";
  drawEdit();
}

function updateEditSettings() {
  if (!editing) return;
  appSettings = {
    ...appSettings,
    filter: normalizeFilter($("filterSelect").value),
    brightness: $("brightnessRange").value,
    contrast: $("contrastRange").value,
  };
  $("captureModeSelect").value = captureModeValue(appSettings.filter);
  localStorage.setItem(settingsKey, JSON.stringify(appSettings));
}

function commitEdit(destination) {
  if (!editing) return;
  const cropped = warpQuad(editing.source, editing.corners);
  const processed = applyFilter(cropped);
  const page = {
    id: editing.pageId || crypto.randomUUID(),
    original: editing.source,
    corners: structuredClone(editing.corners),
    cropped,
    processed,
  };
  const index = pages.findIndex((item) => item.id === page.id);
  if (index >= 0) pages[index] = page;
  else pages.push(page);
  editing = null;
  lastPdfBlob = null;
  saveProject();
  updateCount();
  if (destination === "capture") showCapture();
  else showReview();
}

function renderPages() {
  pageList.innerHTML = "";
  thumbList.innerHTML = "";
  pages.forEach((page, index) => {
    const li = document.createElement("li");
    li.className = "pageItem";
    const img = document.createElement("img");
    img.src = page.processed.toDataURL("image/jpeg", 0.78);
    img.alt = `${index + 1}ページ目`;
    const tools = document.createElement("div");
    tools.className = "pageTools";
    tools.append(
      toolButton("↑", () => movePage(index, -1), index === 0),
      toolButton("↓", () => movePage(index, 1), index === pages.length - 1),
      toolButton("補正", () => openEdit(page.original, structuredClone(page.corners), page.id)),
      toolButton("削除", () => deletePage(index), false, "deleteBtn"),
    );
    li.append(img, tools);
    pageList.appendChild(li);

    const thumbItem = document.createElement("li");
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "thumbButton";
    thumb.addEventListener("click", () => li.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" }));
    const thumbImg = document.createElement("img");
    thumbImg.src = page.processed.toDataURL("image/jpeg", 0.52);
    thumbImg.alt = `${index + 1}ページ`;
    thumb.append(thumbImg);
    thumbItem.appendChild(thumb);
    thumbList.appendChild(thumbItem);
  });
  $("downloadBtn").disabled = pages.length === 0;
  $("jpegBtn").disabled = pages.length === 0;
  $("shareBtn").disabled = pages.length === 0 || !navigator.share;
  updateReviewStatus();
}

function toolButton(label, onClick, disabled = false, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.className = className;
  button.addEventListener("click", onClick);
  return button;
}

function movePage(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= pages.length) return;
  [pages[index], pages[next]] = [pages[next], pages[index]];
  lastPdfBlob = null;
  renderPages();
  saveProject();
}

function deletePage(index) {
  pages.splice(index, 1);
  lastPdfBlob = null;
  renderPages();
  saveProject();
  updateCount();
  if (!pages.length) updateReviewStatus();
}

function updateCount() {
  captureCount.textContent = String(pages.length);
  $("reviewFromCaptureBtn").disabled = pages.length === 0;
}

function updateReviewStatus() {
  reviewStatus.textContent = pages.length ? `${pages.length}ページを準備中です。` : "PDFに追加するページを確認できます。";
}

function updateProjectSettings() {
  appSettings = { ...appSettings, paper: $("paperSelect").value };
  localStorage.setItem(settingsKey, JSON.stringify(appSettings));
  lastPdfBlob = null;
  saveProject();
}

function applySettingsToReview(settings) {
  $("paperSelect").value = settings.paper;
}

function currentSettings() {
  return {
    paper: $("paperSelect").value,
    quality: appSettings.quality,
    filter: $("filterSelect").value,
    brightness: $("brightnessRange").value,
    contrast: $("contrastRange").value,
  };
}

function loadSettings() {
  try {
    return normalizeSettings({ ...defaultSettings, ...JSON.parse(localStorage.getItem(settingsKey)) });
  } catch (error) {
    return { ...defaultSettings };
  }
}

function normalizeSettings(settings) {
  return { ...defaultSettings, ...settings, filter: normalizeFilter(settings.filter) };
}

function normalizeFilter(filter) {
  if (filter === "scan") return "document";
  if (filter === "color") return "photo";
  return filter || "document";
}

function captureModeValue(filter) {
  return ["document", "whiteboard", "receipt", "photo"].includes(filter) ? filter : "document";
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(historyKey)) || [];
  } catch (error) {
    return [];
  }
}

function saveHistory() {
  localStorage.setItem(historyKey, JSON.stringify(history.slice(0, 12)));
}

function saveProject() {
  if (!currentProjectId) return;
  if (!pages.length) {
    history = history.filter((item) => item.id !== currentProjectId);
    saveHistory();
    return;
  }
  const existing = history.find((item) => item.id === currentProjectId);
  const project = {
    id: currentProjectId,
    title: existing?.title || `Scan ${new Date().toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
    updatedAt: Date.now(),
    settings: currentSettings(),
    pages: pages.map((page) => ({
      croppedData: page.cropped.toDataURL("image/jpeg", 0.78),
      thumbData: page.processed.toDataURL("image/jpeg", 0.42),
    })),
  };
  history = [project, ...history.filter((item) => item.id !== currentProjectId)].slice(0, 12);
  try {
    saveHistory();
  } catch (error) {
    history = history.filter((item) => item.id !== currentProjectId);
    saveHistory();
    homeStatus.textContent = "履歴の保存容量を超えたため、このスキャンは一時保存のみです。";
  }
}

function renderHistory() {
  historyList.innerHTML = "";
  emptyHistory.hidden = history.length > 0;
  history.forEach((project) => {
    const li = document.createElement("li");
    li.className = "historyItem";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "historyOpen";
    openButton.addEventListener("click", () => openProject(project.id));
    const thumb = document.createElement("img");
    thumb.src = project.pages[0]?.thumbData || "";
    thumb.alt = "";
    const meta = document.createElement("span");
    meta.innerHTML = `<strong>${escapeHtml(project.title)}</strong><small>${project.pages.length}ページ ・ ${formatDate(project.updatedAt)}</small>`;
    openButton.append(thumb, meta);
    const more = toolButton("...", () => li.classList.toggle("isOpen"), false, "historyMore");
    const actions = document.createElement("div");
    actions.className = "historyActions";
    actions.append(
      toolButton("開く", () => openProject(project.id)),
      toolButton("名前変更", () => renameProject(project.id)),
      toolButton("削除", () => deleteProject(project.id), false, "historyDelete"),
    );
    li.append(openButton, more, actions);
    historyList.appendChild(li);
  });
}

async function openProject(id) {
  const project = history.find((item) => item.id === id);
  if (!project) return;
  currentProjectId = id;
  applySettingsToReview({ ...defaultSettings, ...project.settings });
  applySettingsToEdit({ ...defaultSettings, ...project.settings });
  pages = [];
  for (const storedPage of project.pages) {
    const cropped = await dataUrlToCanvas(storedPage.croppedData);
    pages.push({
      id: crypto.randomUUID(),
      original: cropped,
      corners: defaultCorners(cropped.width, cropped.height),
      cropped,
      processed: applyFilter(cropped),
    });
  }
  showReview();
  saveProject();
}

function deleteProject(id) {
  history = history.filter((item) => item.id !== id);
  saveHistory();
  renderHistory();
}

function renameProject(id) {
  const project = history.find((item) => item.id === id);
  if (!project) return;
  const title = prompt("履歴名", project.title);
  if (!title?.trim()) return;
  project.title = title.trim();
  project.updatedAt = Date.now();
  saveHistory();
  renderHistory();
}

function clearHistory() {
  history = [];
  saveHistory();
  renderHistory();
}

function dataUrlToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function applySettingsToEdit(settings) {
  const normalized = normalizeSettings(settings);
  $("filterSelect").value = normalized.filter;
  $("brightnessRange").value = settings.brightness;
  $("contrastRange").value = settings.contrast;
}

function detectDocumentCorners(canvas, allowNull) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  const step = Math.max(4, Math.round(Math.max(w, h) / 240));
  const cols = Math.floor(w / step);
  const rows = Math.floor(h / step);
  const brightness = [];
  let total = 0;

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = gx * step;
      const y = gy * step;
      const i = (y * w + x) * 4;
      const value = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      brightness.push(value);
      total += value;
    }
  }

  const mean = total / Math.max(1, brightness.length);
  brightness.sort((a, b) => a - b);
  const high = brightness[Math.floor(brightness.length * 0.78)] || mean;
  const threshold = Math.max(126, Math.min(218, (mean + high) / 2 + 12));
  const cells = new Uint8Array(cols * rows);

  for (let gy = 1; gy < rows - 1; gy++) {
    for (let gx = 1; gx < cols - 1; gx++) {
      const x = gx * step;
      const y = gy * step;
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const gray = r * 0.299 + g * 0.587 + b * 0.114;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const gradX = grayAt(data, w, x + step, y) - grayAt(data, w, x - step, y);
      const gradY = grayAt(data, w, x, y + step) - grayAt(data, w, x, y - step);
      const edge = Math.hypot(gradX, gradY);
      if (gray > threshold && sat < 78 && edge < 95) cells[gy * cols + gx] = 1;
    }
  }

  const component = largestDocumentComponent(cells, cols, rows, step, w, h);
  if (!component || component.points.length < 48) return allowNull ? null : defaultCorners(w, h);
  const hits = component.points;
  const c = {
    tl: extreme(hits, (p) => p.x + p.y, false),
    tr: extreme(hits, (p) => p.x - p.y, true),
    br: extreme(hits, (p) => p.x + p.y, true),
    bl: extreme(hits, (p) => p.y - p.x, true),
  };
  const area = polygonArea(c);
  if (area < w * h * 0.1 || !isReasonableQuad(c, w, h)) return allowNull ? null : defaultCorners(w, h);
  return insetQuad(c, w, h, 0.006);
}

function largestDocumentComponent(cells, cols, rows, step, w, h) {
  const seen = new Uint8Array(cells.length);
  let best = null;
  const queue = [];
  const minArea = w * h * 0.055;
  const maxArea = w * h * 0.82;

  for (let index = 0; index < cells.length; index++) {
    if (!cells[index] || seen[index]) continue;
    queue.length = 0;
    queue.push(index);
    seen[index] = 1;
    const pointsList = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = 0;
    let maxY = 0;
    let touches = 0;

    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor];
      const cx = current % cols;
      const cy = Math.floor(current / cols);
      const x = cx * step;
      const y = cy * step;
      pointsList.push({ x, y });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (cx <= 1 || cy <= 1 || cx >= cols - 2 || cy >= rows - 2) touches++;

      for (const next of [current - 1, current + 1, current - cols, current + cols]) {
        if (next < 0 || next >= cells.length || seen[next] || !cells[next]) continue;
        const nx = next % cols;
        const wrapped = Math.abs(nx - cx) > 1;
        if (wrapped) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }

    const boxWidth = maxX - minX;
    const boxHeight = maxY - minY;
    const boxArea = boxWidth * boxHeight;
    const borderRatio = touches / Math.max(1, pointsList.length);
    const fillRatio = (pointsList.length * step * step) / Math.max(1, boxArea);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerDistance = Math.hypot((centerX - w / 2) / w, (centerY - h / 2) / h);
    const aspect = boxWidth / Math.max(1, boxHeight);
    const looksLikeDocument =
      boxArea >= minArea &&
      boxArea <= maxArea &&
      borderRatio < 0.1 &&
      fillRatio > 0.22 &&
      aspect > 0.28 &&
      aspect < 3.8 &&
      centerDistance < 0.38;
    const score = pointsList.length * (1 - borderRatio) * (1 - centerDistance);
    if (looksLikeDocument && (!best || score > best.score)) {
      best = { points: pointsList, score };
    }
  }
  return best;
}

function grayAt(data, width, x, y) {
  const i = (y * width + x) * 4;
  return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
}

function extreme(pointsList, score, max) {
  return pointsList.reduce((best, point) => {
    return (max ? score(point) > score(best) : score(point) < score(best)) ? point : best;
  }, pointsList[0]);
}

function isReasonableQuad(c, w, h) {
  const top = distance(c.tl, c.tr);
  const bottom = distance(c.bl, c.br);
  const left = distance(c.tl, c.bl);
  const right = distance(c.tr, c.br);
  const minSide = Math.min(top, bottom, left, right);
  const maxSide = Math.max(top, bottom, left, right);
  return minSide > Math.min(w, h) * 0.18 && maxSide / minSide < 6;
}

function insetQuad(c, w, h, amount) {
  const center = {
    x: (c.tl.x + c.tr.x + c.br.x + c.bl.x) / 4,
    y: (c.tl.y + c.tr.y + c.br.y + c.bl.y) / 4,
  };
  const result = {};
  for (const name of points) {
    result[name] = {
      x: clamp(c[name].x + (center.x - c[name].x) * amount, 0, w),
      y: clamp(c[name].y + (center.y - c[name].y) * amount, 0, h),
    };
  }
  return result;
}

function scaleCorners(c, scale) {
  const result = {};
  for (const name of points) result[name] = { x: c[name].x * scale, y: c[name].y * scale };
  return result;
}

function mixCorners(current, next, amount) {
  const result = {};
  for (const name of points) {
    result[name] = {
      x: current[name].x + (next[name].x - current[name].x) * amount,
      y: current[name].y + (next[name].y - current[name].y) * amount,
    };
  }
  return result;
}

function drawCornerMarks(svg, c, length, className) {
  const segments = [
    `M ${c.tl.x + length} ${c.tl.y} L ${c.tl.x} ${c.tl.y} L ${c.tl.x} ${c.tl.y + length}`,
    `M ${c.tr.x - length} ${c.tr.y} L ${c.tr.x} ${c.tr.y} L ${c.tr.x} ${c.tr.y + length}`,
    `M ${c.br.x - length} ${c.br.y} L ${c.br.x} ${c.br.y} L ${c.br.x} ${c.br.y - length}`,
    `M ${c.bl.x + length} ${c.bl.y} L ${c.bl.x} ${c.bl.y} L ${c.bl.x} ${c.bl.y - length}`,
  ];
  for (const segment of segments) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", segment);
    path.setAttribute("class", className);
    svg.appendChild(path);
  }
}

function defaultCorners(w, h) {
  return {
    tl: { x: w * 0.1, y: h * 0.09 },
    tr: { x: w * 0.9, y: h * 0.09 },
    br: { x: w * 0.9, y: h * 0.91 },
    bl: { x: w * 0.1, y: h * 0.91 },
  };
}

function polygonArea(c) {
  const p = [c.tl, c.tr, c.br, c.bl];
  return Math.abs(p.reduce((sum, point, i) => {
    const next = p[(i + 1) % p.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function warpQuad(source, c) {
  const top = distance(c.tl, c.tr);
  const bottom = distance(c.bl, c.br);
  const left = distance(c.tl, c.bl);
  const right = distance(c.tr, c.br);
  const output = document.createElement("canvas");
  output.width = Math.min(1900, Math.max(520, Math.round((top + bottom) / 2)));
  output.height = Math.min(2600, Math.max(700, Math.round((left + right) / 2)));
  const src = source.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, source.width, source.height);
  const dstCtx = output.getContext("2d");
  const dst = dstCtx.createImageData(output.width, output.height);

  for (let y = 0; y < output.height; y++) {
    const v = y / (output.height - 1);
    for (let x = 0; x < output.width; x++) {
      const u = x / (output.width - 1);
      const topPoint = lerpPoint(c.tl, c.tr, u);
      const bottomPoint = lerpPoint(c.bl, c.br, u);
      const point = lerpPoint(topPoint, bottomPoint, v);
      sample(src, source.width, source.height, point.x, point.y, dst.data, (y * output.width + x) * 4);
    }
  }
  dstCtx.putImageData(dst, 0, 0);
  return output;
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function sample(src, w, h, x, y, out, offset) {
  const sx = clamp(Math.round(x), 0, w - 1);
  const sy = clamp(Math.round(y), 0, h - 1);
  const i = (sy * w + sx) * 4;
  out[offset] = src.data[i];
  out[offset + 1] = src.data[i + 1];
  out[offset + 2] = src.data[i + 2];
  out[offset + 3] = 255;
}

function applyFilter(canvas) {
  const mode = normalizeFilter($("filterSelect").value);
  const brightness = Number($("brightnessRange").value);
  const contrast = Number($("contrastRange").value);
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const factor = 1 + contrast / 130;

  for (let i = 0; i < image.data.length; i += 4) {
    let r = (image.data[i] - 128) * factor + 128 + brightness;
    let g = (image.data[i + 1] - 128) * factor + 128 + brightness;
    let b = (image.data[i + 2] - 128) * factor + 128 + brightness;
    const gray = r * 0.299 + g * 0.587 + b * 0.114;
    if (mode === "photo") {
      image.data[i] = clamp(r, 0, 255);
      image.data[i + 1] = clamp(g, 0, 255);
      image.data[i + 2] = clamp(b, 0, 255);
      continue;
    }
    if (mode === "document") {
      const lift = gray > 205 ? 10 : gray > 180 ? 5 : 0;
      r = clamp(r + lift, 0, 255);
      g = clamp(g + lift, 0, 255);
      b = clamp(b + lift, 0, 255);
    }
    if (mode === "receipt") {
      const receiptGray = gray > 205 ? gray + (255 - gray) * 0.18 : gray * 0.98 + 4;
      r = g = b = clamp(receiptGray, 0, 255);
    }
    if (mode === "whiteboard") {
      const boardGray = gray > 188 ? gray + (255 - gray) * 0.36 : gray * 0.92 + 6;
      r = g = b = clamp(boardGray, 0, 255);
    }
    if (mode === "gray") r = g = b = gray;
    if (mode === "ink") {
      const ink = gray > 210 ? 255 : clamp(gray * 1.08 - 8, 0, 255);
      r = g = b = ink;
    }
    if (mode === "bw") r = g = b = gray > 184 ? 255 : 34;
    image.data[i] = clamp(r, 0, 255);
    image.data[i + 1] = clamp(g, 0, 255);
    image.data[i + 2] = clamp(b, 0, 255);
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

async function getPdfBlob() {
  if (!lastPdfBlob) lastPdfBlob = await buildPdf(pages.map((page) => page.processed));
  return lastPdfBlob;
}

async function downloadPdf() {
  const blob = await getPdfBlob();
  downloadBlob(blob, `scan-${dateName()}.pdf`);
}

async function sharePdf() {
  const blob = await getPdfBlob();
  const file = new File([blob], `scan-${dateName()}.pdf`, { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: "Scan PDF" });
  else downloadBlob(blob, file.name);
}

async function downloadJpeg() {
  if (!pages.length) return;
  const blob = await canvasToBlob(pages[pages.length - 1].processed, "image/jpeg", Number(appSettings.quality));
  downloadBlob(blob, `scan-${dateName()}.jpg`);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

async function buildPdf(canvases) {
  const quality = Number(appSettings.quality);
  const objects = [];
  const kids = [];
  let nextId = 1;
  const catalogId = nextId++;
  const pagesId = nextId++;

  for (const canvas of canvases) {
    const imageBlob = await canvasToBlob(canvas, "image/jpeg", quality);
    const bytes = new Uint8Array(await imageBlob.arrayBuffer());
    const imageId = nextId++;
    const contentId = nextId++;
    const pageId = nextId++;
    const size = pageSize(canvas);
    const fit = contain(canvas.width, canvas.height, size.width, size.height);
    const content = `q\n${fit.width.toFixed(2)} 0 0 ${fit.height.toFixed(2)} ${fit.x.toFixed(2)} ${fit.y.toFixed(2)} cm\n/Im${imageId} Do\nQ`;
    objects[imageId] = pdfStream(
      `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>`,
      bytes,
    );
    objects[contentId] = pdfStream(`<< /Length ${content.length} >>`, ascii(content));
    objects[pageId] = ascii(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${size.width} ${size.height}] /Resources << /XObject << /Im${imageId} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    kids.push(`${pageId} 0 R`);
  }

  objects[catalogId] = ascii(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objects[pagesId] = ascii(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`);
  return new Blob([assemblePdf(objects, catalogId)], { type: "application/pdf" });
}

function pageSize(canvas) {
  if ($("paperSelect").value === "letter") return { width: 612, height: 792 };
  if ($("paperSelect").value === "image") return { width: canvas.width * 0.72, height: canvas.height * 0.72 };
  return { width: 595.28, height: 841.89 };
}

function contain(srcW, srcH, boxW, boxH) {
  const margin = $("paperSelect").value === "image" ? 0 : 24;
  const scale = Math.min((boxW - margin * 2) / srcW, (boxH - margin * 2) / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return { width, height, x: (boxW - width) / 2, y: (boxH - height) / 2 };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function ascii(text) {
  return new TextEncoder().encode(text);
}

function pdfStream(header, body) {
  return concatBytes(ascii(`${header}\nstream\n`), body, ascii("\nendstream"));
}

function assemblePdf(objects, catalogId) {
  const chunks = [ascii("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
  const offsets = [0];
  let length = chunks[0].length;
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = length;
    const object = concatBytes(ascii(`${id} 0 obj\n`), objects[id], ascii("\nendobj\n"));
    chunks.push(object);
    length += object.length;
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(ascii(xref));
  return concatBytes(...chunks);
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function dateName() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
