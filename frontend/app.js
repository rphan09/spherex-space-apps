/* SPHEREx Blink.
 *
 * Two views share the page:
 *   - the sky: the SPHEREx DR1 all-sky map in Aladin Lite, with clickable
 *     targets, a fly-to camera and a probe for any clicked spot;
 *   - the blink drawer: every SPHEREx image of one 0.1-degree spot, aligned
 *     and played in time order.  Frames come from /api/frame as raw float32
 *     pixels and are stretched here, so display changes need no new request.
 */
import A from "./vendor/aladin-lite-3.8.2/aladin.js";

const LOAD_CONCURRENCY = 6;
const MAX_ZOOM = 16;
const DEFAULTS = { lo: 2, hi: 99.7, asinh: 8 };
const NO_DATA = [18, 22, 34];
const DETECTOR_COLORS = ["#7f9cff", "#5fc9d9", "#8fd96b", "#e9cf55", "#f39a4a", "#ec6455"];
const ACCENT = "#f5b54a";
const FOOTPRINT_DEG = 0.1;
const START_VIEW = { ra: 88, dec: 8, fov: 120 };
// The all-sky map has 13" pixels: closer than ~1 degree it turns into blocks.
const MIN_SKY_FOV = 1;
const CARD_FOV = 3;
const BLINK_FOV = 2;
const DRIFT_DEG_PER_MS = 0.0009;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const NARROW = window.matchMedia("(max-width: 720px)");

const $ = (id) => document.getElementById(id);
const el = {
  skyWrap: $("sky-wrap"), sky: $("sky"), markers: $("markers"), probe: $("probe"), skyLoading: $("sky-loading"),
  card: $("card"), cardKicker: $("card-kicker"), cardTitle: $("card-title"), cardText: $("card-text"),
  cardCoords: $("card-coords"), cardBlink: $("card-blink"), cardClose: $("card-close"),
  goto: $("goto"), ra: $("ra"), dec: $("dec"),
  targetsToggle: $("targets-toggle"), targetsList: $("targets-list"),
  spectrum: $("spectrum"), wave: $("wave"), waveValue: $("wave-value"), layerNote: $("layer-note"),
  cursor: $("cursor"), fov: $("fov"),
  blink: $("blink"), blinkKicker: $("blink-kicker"), blinkTitle: $("blink-title"), blinkCoords: $("blink-coords"),
  blinkClose: $("blink-close"),
  canvas: $("canvas"), message: $("message"), loadbar: $("loadbar"),
  zoomIn: $("zoom-in"), zoomOut: $("zoom-out"), zoomValue: $("zoom-value"),
  prev: $("prev"), play: $("play"), next: $("next"), frameCount: $("frame-count"), fps: $("fps"), fpsValue: $("fps-value"),
  timeline: $("timeline"), tStart: $("t-start"), tEnd: $("t-end"),
  detectors: $("detectors"), progressText: $("progress-text"), retryFailed: $("retry-failed"), failures: $("failures"),
  lo: $("lo"), loValue: $("lo-value"), hi: $("hi"), hiValue: $("hi-value"), asinh: $("asinh"), asinhValue: $("asinh-value"),
  lock: $("lock"), marker: $("marker"), resetContrast: $("reset-contrast"),
  toast: $("toast"),
};
const ctx = el.canvas.getContext("2d");
const tctx = el.timeline.getContext("2d");
const offscreen = document.createElement("canvas");
const offCtx = offscreen.getContext("2d", { willReadFrequently: true });

/* ================================================================ helpers */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function sexagesimal(value, hours) {
  const sign = value < 0 ? "−" : hours ? "" : "+";
  let v = Math.abs(hours ? value / 15 : value);
  const a = Math.floor(v); v = (v - a) * 60;
  const b = Math.floor(v); const c = (v - b) * 60;
  const s = c.toFixed(hours ? 2 : 1).padStart(hours ? 5 : 4, "0");
  return hours ? `${sign}${String(a).padStart(2, "0")}h${String(b).padStart(2, "0")}m${s}s`
               : `${sign}${String(a).padStart(2, "0")}°${String(b).padStart(2, "0")}′${s}″`;
}
const formatCoords = (ra, dec) => `${sexagesimal(ra, true)}  ${sexagesimal(dec, false)}`;

function toVec(ra, dec) {
  const r = rad(ra), d = rad(dec);
  return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)];
}
function fromVec([x, y, z]) {
  const n = Math.hypot(x, y, z);
  return [(deg(Math.atan2(y, x)) + 360) % 360, deg(Math.asin(clamp(z / n, -1, 1)))];
}
function separation(ra1, dec1, ra2, dec2) {
  const a = toVec(ra1, dec1), b = toVec(ra2, dec2);
  return deg(Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)));
}

/** Corners of a north-up square of side `size` degrees centred on (ra, dec), via the TAN projection. */
function footprint(ra, dec, size) {
  const h = Math.tan(rad(size / 2));
  const ra0 = rad(ra), dec0 = rad(dec);
  return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([xi, eta]) => {
    const den = Math.cos(dec0) - eta * Math.sin(dec0);
    const r = ra0 + Math.atan2(xi, den);
    const d = Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(xi, den));
    return [(deg(r) + 360) % 360, deg(d)];
  });
}

let toastTimer = 0;
function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 6000);
}

async function readError(response) {
  try {
    const body = await response.json();
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) return body.detail.map((d) => d.msg).join("; ");
  } catch (_) { /* not JSON */ }
  return `The server returned an error (${response.status}).`;
}

/* ================================================================== sky */

const sky = {
  aladin: null,
  ready: false,
  targets: [],
  categories: {},
  markerEls: new Map(),
  selected: null,       // { kind: "target"|"spot", ra, dec, target? }
  flight: null,
  drifting: !REDUCED_MOTION,
  footprint: null,
  layer: "rgb",
  frames: [],
  waveTimer: 0,
};

const absolute = (path) => new URL(path, window.location.href).href;

async function initSky() {
  await A.init;
  const aladin = A.aladin(el.sky, {
    survey: absolute("hips/rgb"),
    fov: START_VIEW.fov,
    target: `${START_VIEW.ra} ${START_VIEW.dec}`,
    projection: "SIN",
    cooFrame: "ICRS",
    backgroundColor: "rgb(0,0,0)",
    showReticle: false, showZoomControl: false, showFullscreenControl: false, showLayersControl: false,
    showGotoControl: false, showFrame: false, showFov: false, showCooLocation: false,
    showCooGridControl: false, showSimbadPointerControl: false, showProjectionControl: false,
    showSettingsControl: false, showShareControl: false, showStatusBar: false, showContextMenu: false,
    log: false, // no usage ping to CDS
  });
  sky.aladin = aladin;
  try { aladin.setFoVRange(MIN_SKY_FOV, 180); } catch (_) { /* older API */ }
  sky.footprint = A.graphicOverlay({ color: ACCENT, lineWidth: 1.5 });
  aladin.addOverlay(sky.footprint);

  aladin.on("click", (event) => {
    if (!event || event.isDragging || !Number.isFinite(event.ra)) return;
    stopDrift();
    selectSpot(event.ra, event.dec);
  });

  // Any direct handling of the sky stops the idle drift and any running flight.
  for (const type of ["pointerdown", "wheel", "touchstart"]) {
    el.sky.addEventListener(type, () => { stopDrift(); sky.flight = null; }, { passive: true });
  }
  el.skyWrap.addEventListener("pointermove", (event) => {
    const rect = el.sky.getBoundingClientRect();
    let world = null;
    try { world = aladin.pix2world(event.clientX - rect.left, event.clientY - rect.top); } catch (_) { /* off-sky */ }
    el.cursor.textContent = world && Number.isFinite(world[0]) ? formatCoords(world[0], world[1]) : "—";
  });

  sky.ready = true;
  setTimeout(() => el.skyLoading.classList.add("done"), 1200);
  loadSkyFrames();
}

async function loadSkyFrames() {
  try {
    const response = await fetch("api/sky");
    if (!response.ok) return;
    sky.frames = (await response.json()).frames;
    el.wave.max = String(sky.frames.length - 1);
    const start = sky.frames.findIndex((f) => f.wavelength_um >= 2.18);
    el.wave.value = String(Math.max(0, start));
    updateWaveLabel();
  } catch (_) { /* the colour layer still works */ }
}

function updateWaveLabel() {
  const frame = sky.frames[Number(el.wave.value)];
  el.waveValue.textContent = frame ? `${frame.wavelength_um.toFixed(3)} µm · D${frame.detector}` : "";
}

function setLayer(layer) {
  sky.layer = layer;
  for (const button of document.querySelectorAll(".layer-switch button")) {
    button.setAttribute("aria-checked", String(button.dataset.layer === layer));
  }
  el.spectrum.hidden = layer !== "mono";
  el.layerNote.hidden = layer !== "rgb";
  if (!sky.aladin) return;
  if (layer === "rgb") {
    sky.aladin.setBaseImageLayer(A.imageHiPS(absolute("hips/rgb"), { name: "SPHEREx colour", imgFormat: "jpeg" }));
  } else {
    showWavelength();
  }
}

function showWavelength() {
  const frame = sky.frames[Number(el.wave.value)];
  if (!frame || !sky.aladin) return;
  sky.aladin.setBaseImageLayer(A.imageHiPS(absolute(`hips/${frame.frame}`), {
    name: `SPHEREx ${frame.wavelength_um.toFixed(3)} µm`, imgFormat: "png",
  }));
}

/* ------------------------------------------------------------- targets */

async function loadTargets() {
  try {
    const response = await fetch("presets.json");
    const data = await response.json();
    sky.targets = data.targets;
    sky.categories = data.categories;
  } catch (_) {
    sky.targets = [];
  }
  buildTargetList();
  buildMarkers();
}

function buildTargetList() {
  const nodes = [];
  for (const [category, label] of Object.entries(sky.categories)) {
    const items = sky.targets.filter((t) => t.category === category);
    if (!items.length) continue;
    const heading = document.createElement("p");
    heading.className = "group-label";
    heading.textContent = label;
    nodes.push(heading);
    for (const target of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "target-item";
      button.dataset.name = target.name;
      const dot = document.createElement("span");
      dot.className = "dot";
      button.append(dot, target.name);
      if (target.test_target) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "test";
        tag.title = "One of the challenge's test targets";
        button.append(tag);
      }
      button.addEventListener("click", () => selectTarget(target, { fly: true }));
      nodes.push(button);
    }
  }
  el.targetsList.replaceChildren(...nodes);
}

function buildMarkers() {
  for (const target of sky.targets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "marker";
    button.dataset.category = target.category;
    button.setAttribute("aria-label", `${target.name}: show details`);
    const ring = document.createElement("span");
    ring.className = "ring";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = target.name;
    button.append(ring, name);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      stopDrift();
      selectTarget(target, { fly: true });
    });
    el.markers.append(button);
    sky.markerEls.set(target.name, button);
  }
}

function markActive(name) {
  for (const [key, node] of sky.markerEls) node.classList.toggle("active", key === name);
  for (const item of el.targetsList.querySelectorAll(".target-item")) {
    item.classList.toggle("active", item.dataset.name === name);
  }
}

/* ------------------------------------------------------- selection card */

function selectTarget(target, { fly }) {
  sky.selected = { kind: "target", ra: target.ra, dec: target.dec, target };
  markActive(target.name);
  el.probe.hidden = true;
  const label = sky.categories[target.category] || "";
  el.cardKicker.textContent = target.test_target ? `${label} · test target` : label;
  el.cardTitle.textContent = target.name;
  el.cardText.textContent = target.description || "";
  el.cardText.hidden = !target.description;
  el.cardCoords.textContent = formatCoords(target.ra, target.dec);
  el.cardBlink.textContent = "Blink this target";
  el.card.hidden = false;
  el.card.style.animation = "none"; void el.card.offsetWidth; el.card.style.animation = "";
  if (NARROW.matches) el.targetsToggle.setAttribute("aria-expanded", "false");
  if (fly) flyTo(target.ra, target.dec, CARD_FOV);
}

function selectSpot(ra, dec) {
  sky.selected = { kind: "spot", ra, dec };
  markActive(null);
  el.probe.hidden = false;
  el.probe.classList.remove("pulse"); void el.probe.offsetWidth; el.probe.classList.add("pulse");
  el.cardKicker.textContent = "Selected spot";
  el.cardTitle.textContent = formatCoords(ra, dec).replace("  ", " ");
  el.cardText.textContent = "Blink every SPHEREx image of the 0.1° field around this point.";
  el.cardText.hidden = false;
  el.cardCoords.textContent = `${ra.toFixed(5)}°  ${dec >= 0 ? "+" : ""}${dec.toFixed(5)}°`;
  el.cardBlink.textContent = "Blink this spot";
  el.card.hidden = false;
  el.card.style.animation = "none"; void el.card.offsetWidth; el.card.style.animation = "";
}

function closeCard() {
  el.card.hidden = true;
  el.probe.hidden = true;
  if (!blink.open) markActive(null);
  sky.selected = null;
}

/* --------------------------------------------------------- the camera */

function stopDrift() { sky.drifting = false; }

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Fly the view to (ra, dec) at field of view `fov`, rising out and back in for long hops. */
function flyTo(ra, dec, fov) {
  const aladin = sky.aladin;
  if (!aladin) return;
  stopDrift();
  const [ra0, dec0] = aladin.getRaDec();
  const fov0 = aladin.getFov()[0];
  const distance = separation(ra0, dec0, ra, dec);
  if (REDUCED_MOTION) {
    aladin.gotoRaDec(ra, dec);
    aladin.setFoV(fov);
    return;
  }
  const v0 = toVec(ra0, dec0), v1 = toVec(ra, dec);
  const omega = rad(distance);
  const peak = Math.min(170, Math.max(fov0, fov, distance * 1.25));
  const lf0 = Math.log(fov0), lf1 = Math.log(fov), lpk = Math.log(peak);
  const rise = Math.max(0, lpk - Math.max(lf0, lf1));
  const duration = 900 + 1500 * Math.min(1, distance / 90) + 350 * Math.min(1, Math.abs(lf1 - lf0) / 4);
  sky.flight = { start: performance.now(), duration, v0, v1, omega, lf0, lf1, rise };
}

function stepFlight(now) {
  const f = sky.flight;
  if (!f) return;
  const t = clamp((now - f.start) / f.duration, 0, 1);
  const e = ease(t);
  let vec;
  if (f.omega < 1e-6) vec = f.v1;
  else {
    const s = Math.sin(f.omega);
    const a = Math.sin((1 - e) * f.omega) / s, b = Math.sin(e * f.omega) / s;
    vec = [0, 1, 2].map((i) => a * f.v0[i] + b * f.v1[i]);
  }
  const [ra, dec] = fromVec(vec);
  const logFov = f.lf0 + (f.lf1 - f.lf0) * e + f.rise * Math.sin(Math.PI * e);
  sky.aladin.gotoRaDec(ra, dec);
  sky.aladin.setFoV(Math.exp(logFov));
  if (t >= 1) sky.flight = null;
}

/* ----------------------------------------- per-frame overlay placement */

function place(node, x, y) {
  node.style.setProperty("--x", `${x}px`);
  node.style.setProperty("--y", `${y}px`);
}

function worldToScreen(ra, dec) {
  let p = null;
  try { p = sky.aladin.world2pix(ra, dec); } catch (_) { return null; }
  if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
  return p;
}

let lastDrift = 0;
function skyTick(now) {
  const aladin = sky.aladin;
  if (aladin) {
    if (sky.flight) stepFlight(now);
    else if (sky.drifting && lastDrift) {
      const [ra, dec] = aladin.getRaDec();
      aladin.gotoRaDec((ra + (now - lastDrift) * DRIFT_DEG_PER_MS) % 360, dec);
    }
    lastDrift = now;

    const width = el.sky.clientWidth, height = el.sky.clientHeight;
    const fov = aladin.getFov()[0];
    el.markers.classList.toggle("compact", fov > 100);
    for (const target of sky.targets) {
      const node = sky.markerEls.get(target.name);
      const p = worldToScreen(target.ra, target.dec);
      const visible = p && p[0] > -40 && p[1] > -40 && p[0] < width + 40 && p[1] < height + 40;
      node.hidden = !visible;
      if (visible) place(node, p[0], p[1]);
    }

    const sel = sky.selected;
    const anchor = sel ? worldToScreen(sel.ra, sel.dec) : null;
    if (sel && sel.kind === "spot") {
      el.probe.hidden = !anchor;
      if (anchor) place(el.probe, anchor[0], anchor[1]);
    }
    if (!el.card.hidden && !NARROW.matches) {
      const cw = el.card.offsetWidth, ch = el.card.offsetHeight;
      let x, y;
      if (anchor) {
        x = anchor[0] + 26; y = anchor[1] - ch / 2;
        if (x + cw > width - 12) x = anchor[0] - 26 - cw;
      } else {
        x = width - cw - 16; y = height - ch - 70;
      }
      place(el.card, clamp(x, 12, Math.max(12, width - cw - 12)), clamp(y, 64, Math.max(64, height - ch - 64)));
    }

    el.fov.textContent = fov >= 1 ? `FOV ${fov.toFixed(1)}°` : `FOV ${(fov * 60).toFixed(1)}′`;
  }
  requestAnimationFrame(skyTick);
}

/* ================================================================ blink */

const blink = {
  open: false,
  generation: 0,
  abort: null,
  query: null,
  name: null,
  grid: 59,
  frames: [],
  playlist: [],
  position: 0,
  detector: 0,
  playing: true,
  fps: 4,
  activeLoads: 0,
  searching: false,
  zoom: 1, panX: 0, panY: 0,
  smooth: true,
  lockedRange: null,
  dirty: true,
  timelineDirty: true,
  lastAdvance: 0,
};

function setDrawer(open) {
  blink.open = open;
  el.blink.hidden = !open;
  const wide = window.matchMedia("(min-width: 721px)").matches;
  document.documentElement.style.setProperty("--drawer", open && wide ? "var(--drawer-width)" : "0px");
  if (!open) {
    if (blink.abort) blink.abort.abort();
    blink.generation += 1;
    blink.frames = [];
    blink.playlist = [];
    sky.footprint && sky.footprint.removeAll();
    if (!sky.selected) markActive(null);
  }
}

/** Open the drawer and blink (ra, dec). `label` names a target, or null for a typed/clicked spot. */
function startBlink(raText, decText, label, sky_ra, sky_dec) {
  setDrawer(true);
  el.blinkKicker.textContent = label ? "Blink · target" : "Blink · position";
  el.blinkTitle.textContent = label || "Selected position";
  el.blinkCoords.textContent = "";
  el.ra.value = raText;
  el.dec.value = decText;
  el.card.hidden = true;
  blink.footprintShown = false;
  if (sky.footprint) sky.footprint.removeAll();
  if (Number.isFinite(sky_ra)) showFootprint(sky_ra, sky_dec);
  runSearch(raText, decText);
}

function showFootprint(ra, dec) {
  if (!sky.footprint) return;
  sky.footprint.removeAll();
  sky.footprint.add(A.polygon(footprint(ra, dec, FOOTPRINT_DEG)));
  blink.footprintShown = true;
  // Fly once the drawer has started opening, so the view centres in the space left.
  setTimeout(() => flyTo(ra, dec, BLINK_FOV), 60);
}

async function runSearch(ra, dec) {
  if (blink.abort) blink.abort.abort();
  const generation = ++blink.generation;
  blink.abort = new AbortController();
  blink.query = { ra, dec };
  blink.frames = [];
  blink.playlist = [];
  blink.position = 0;
  blink.activeLoads = 0;
  blink.lockedRange = null;
  blink.searching = true;
  resetView();
  showMessage("Searching the SPHEREx archive…");
  updateAll();

  let result;
  try {
    // High priority: the browser sends this ahead of queued sky-map tiles.
    const response = await fetch(`api/search?${new URLSearchParams({ ra, dec })}`,
      { signal: blink.abort.signal, priority: "high" });
    if (generation !== blink.generation) return;
    if (!response.ok) {
      blink.searching = false;
      showMessage(await readError(response), true);
      updateAll();
      return;
    }
    result = await response.json();
  } catch (error) {
    if (error.name === "AbortError" || generation !== blink.generation) return;
    blink.searching = false;
    showMessage("Could not reach the server. Check that the backend is running.", true);
    updateAll();
    return;
  }
  if (generation !== blink.generation) return;

  blink.searching = false;
  blink.grid = result.grid_size;
  offscreen.width = offscreen.height = blink.grid;
  el.blinkCoords.textContent = formatCoords(result.ra, result.dec);
  if (!blink.footprintShown) showFootprint(result.ra, result.dec);
  blink.frames = result.images.map((image) => ({
    ...image, status: "pending", data: null, sorted: null, wavelength: null, error: null,
  }));
  if (blink.detector && !blink.frames.some((f) => f.detector === blink.detector)) blink.detector = 0;
  if (blink.frames.length === 0) showMessage(result.message || "No SPHEREx images cover this position yet.");
  updateAll();
  pumpLoader();
}

/* --------------------------------------------------------------- loading */

const matchesFilter = (frame) => blink.detector === 0 || frame.detector === blink.detector;

function nextPending() {
  return blink.frames.find((f) => f.status === "pending" && matchesFilter(f))
      || blink.frames.find((f) => f.status === "pending");
}

function pumpLoader() {
  while (blink.activeLoads < LOAD_CONCURRENCY) {
    const frame = nextPending();
    if (!frame) break;
    loadFrame(frame, blink.generation);
  }
}

async function loadFrame(frame, generation) {
  frame.status = "loading";
  blink.activeLoads += 1;
  try {
    const params = new URLSearchParams({ ra: blink.query.ra, dec: blink.query.dec, format: "raw" });
    const response = await fetch(`api/frame/${encodeURIComponent(frame.id)}?${params}`,
      { signal: blink.abort.signal, priority: "high" });
    if (generation !== blink.generation) return;
    if (!response.ok) throw new Error(await readError(response));
    const buffer = await response.arrayBuffer();
    if (generation !== blink.generation) return;
    const data = new Float32Array(buffer);
    if (data.length !== blink.grid * blink.grid) throw new Error("Unexpected frame size.");
    const meta = JSON.parse(response.headers.get("X-Frame-Meta") || "{}");
    frame.data = data;
    frame.enclosed = enclosedNoData(data, blink.grid);
    frame.sorted = Float32Array.from(data.filter(Number.isFinite)).sort();
    frame.wavelength = meta.wavelength_um ?? null;
    frame.status = "ready";
  } catch (error) {
    if (error.name === "AbortError" || generation !== blink.generation) return;
    frame.status = "failed";
    frame.error = error.message || "Unknown error";
  } finally {
    if (generation === blink.generation) {
      blink.activeLoads -= 1;
      scheduleUpdate();
      pumpLoader();
    }
  }
}

// Frames can arrive dozens per second; coalesce UI updates to one per animation frame.
let updatePending = false;
function scheduleUpdate() {
  if (updatePending) return;
  updatePending = true;
  requestAnimationFrame(() => { updatePending = false; updateAll(); });
}

function retryFailed() {
  for (const frame of blink.frames) {
    if (frame.status === "failed") { frame.status = "pending"; frame.error = null; }
  }
  updateAll();
  pumpLoader();
}

/* -------------------------------------------------------------- playlist */

function rebuildPlaylist() {
  const currentIndex = blink.playlist[blink.position];
  blink.playlist = [];
  blink.frames.forEach((frame, index) => {
    if (frame.status === "ready" && matchesFilter(frame)) blink.playlist.push(index);
  });
  let position = blink.playlist.findIndex((index) => index >= currentIndex);
  if (currentIndex === undefined) position = 0;
  if (position < 0) position = Math.max(0, blink.playlist.length - 1);
  blink.position = position;
  blink.lockedRange = null;
}

const currentFrame = () => blink.frames[blink.playlist[blink.position]] || null;

function step(delta) {
  const count = blink.playlist.length;
  if (count === 0) return;
  blink.position = ((blink.position + delta) % count + count) % count;
  updateTransport();
  blink.dirty = true;
  blink.timelineDirty = true;
}

/* --------------------------------------------------------------- stretch */

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1)];
}

function median(values) {
  const copy = values.slice().sort((a, b) => a - b);
  return copy[Math.floor(copy.length / 2)];
}

function displayRange(frame) {
  const lo = Number(el.lo.value), hi = Number(el.hi.value);
  if (!el.lock.checked) return [percentile(frame.sorted, lo), percentile(frame.sorted, hi)];
  const key = `${lo}|${hi}|${blink.detector}|${blink.playlist.length}`;
  if (!blink.lockedRange || blink.lockedRange.key !== key) {
    const frames = blink.playlist.map((index) => blink.frames[index]);
    blink.lockedRange = {
      key,
      lo: median(frames.map((f) => percentile(f.sorted, lo))),
      hi: median(frames.map((f) => percentile(f.sorted, hi))),
    };
  }
  return [blink.lockedRange.lo, blink.lockedRange.hi];
}

/**
 * Mark no-data pixels that are surrounded by data: the pipeline blanks the
 * saturated cores of bright stars, and those are drawn white rather than as
 * holes.  No-data regions touching the edge (outside the detector) are left
 * as no-data.
 */
function enclosedNoData(data, n) {
  const outside = new Uint8Array(data.length);
  const stack = [];
  for (let i = 0; i < n; i += 1) {
    for (const p of [i, (n - 1) * n + i, i * n, i * n + n - 1]) {
      if (!Number.isFinite(data[p]) && !outside[p]) { outside[p] = 1; stack.push(p); }
    }
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % n, y = (p - x) / n;
    for (const q of [x > 0 ? p - 1 : -1, x < n - 1 ? p + 1 : -1, y > 0 ? p - n : -1, y < n - 1 ? p + n : -1]) {
      if (q >= 0 && !outside[q] && !Number.isFinite(data[q])) { outside[q] = 1; stack.push(q); }
    }
  }
  const enclosed = new Uint8Array(data.length);
  for (let p = 0; p < data.length; p += 1) enclosed[p] = !Number.isFinite(data[p]) && !outside[p] ? 1 : 0;
  return enclosed;
}

function paintFrame(frame) {
  const [low, high] = displayRange(frame);
  const span = high > low ? high - low : 1;
  const strength = Number(el.asinh.value);
  const norm = strength > 0 ? Math.asinh(strength) : 1;
  const image = offCtx.createImageData(blink.grid, blink.grid);
  const out = image.data, data = frame.data, enclosed = frame.enclosed;
  for (let i = 0, o = 0; i < data.length; i += 1, o += 4) {
    const value = data[i];
    if (Number.isFinite(value)) {
      let t = clamp((value - low) / span, 0, 1);
      if (strength > 0) t = Math.asinh(strength * t) / norm;
      out[o] = out[o + 1] = out[o + 2] = Math.round(t * 255);
    } else if (enclosed && enclosed[i]) {
      out[o] = out[o + 1] = out[o + 2] = 255;
    } else {
      [out[o], out[o + 1], out[o + 2]] = NO_DATA;
    }
    out[o + 3] = 255;
  }
  offCtx.putImageData(image, 0, 0);
}

/* ---------------------------------------------------------------- canvas */

const formatDate = (iso) => `${iso.slice(0, 10)}  ${iso.slice(11, 16)} UTC`;

function formatWavelength(frame) {
  if (frame.wavelength != null) return `${frame.wavelength.toFixed(3)} µm`;
  if (frame.wavelength_min_um != null) return `${frame.wavelength_min_um.toFixed(2)}–${frame.wavelength_max_um.toFixed(2)} µm`;
  return "";
}

function draw() {
  const size = el.canvas.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  const frame = currentFrame();
  if (!frame) return;

  paintFrame(frame);
  const scaled = size * blink.zoom;
  ctx.imageSmoothingEnabled = blink.smooth;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(offscreen, blink.panX, blink.panY, scaled, scaled);

  if (el.marker.checked) {
    const x = blink.panX + scaled / 2, y = blink.panY + scaled / 2;
    const r = Math.max(16, (scaled / blink.grid) * 1.6);
    ctx.lineWidth = 2;
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(x + dx * r, y + dy * r);
      ctx.lineTo(x + dx * (r + 14), y + dy * (r + 14));
    }
    ctx.stroke();
  }

  // Caption: date, then detector and wavelength, in a small dark band.
  const color = DETECTOR_COLORS[frame.detector - 1] || "#fff";
  ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
  ctx.fillRect(0, 0, size, 58);
  ctx.textBaseline = "top";
  ctx.font = "500 22px 'Overpass Mono', Consolas, monospace";
  ctx.fillStyle = "#ece9e2";
  ctx.fillText(formatDate(frame.date_iso), 16, 8);
  ctx.font = "500 18px 'Overpass Mono', Consolas, monospace";
  ctx.fillStyle = color;
  ctx.fillRect(16, 39, 18, 4);
  ctx.fillStyle = "#b9b6ae";
  ctx.fillText(`D${frame.detector}  ${formatWavelength(frame)}`, 42, 32);

  // Compass: north up, east left.
  ctx.font = "600 16px Overpass, sans-serif";
  ctx.fillStyle = "rgba(236, 233, 226, 0.7)";
  ctx.textAlign = "center";
  ctx.fillText("N", size - 30, 70);
  ctx.textAlign = "right";
  ctx.fillText("E", size - 50, 92);
  ctx.textAlign = "left";
  ctx.strokeStyle = "rgba(236, 233, 226, 0.7)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(size - 30, 120); ctx.lineTo(size - 30, 90);
  ctx.moveTo(size - 30, 120); ctx.lineTo(size - 46, 120);
  ctx.stroke();
}

/* -------------------------------------------------------------- timeline */

function timelineGeometry() {
  const frames = blink.frames;
  if (!frames.length) return null;
  const t0 = frames[0].mjd, t1 = frames[frames.length - 1].mjd;
  const width = el.timeline.width, pad = 10;
  const x = (mjd) => pad + (t1 > t0 ? ((mjd - t0) / (t1 - t0)) : 0.5) * (width - 2 * pad);
  return { t0, t1, x, width, pad };
}

function drawTimeline() {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = el.timeline.clientWidth;
  if (el.timeline.width !== Math.round(cssWidth * dpr)) {
    el.timeline.width = Math.round(cssWidth * dpr);
    el.timeline.height = Math.round(44 * dpr);
  }
  const w = el.timeline.width, h = el.timeline.height;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, w, h);
  const g = timelineGeometry();
  if (!g) {
    el.tStart.textContent = el.tEnd.textContent = "";
    return;
  }
  const base = h - 10 * dpr;
  tctx.fillStyle = "rgba(255,255,255,0.12)";
  tctx.fillRect(g.pad, base, w - 2 * g.pad, 1 * dpr);

  const current = currentFrame();
  for (const frame of blink.frames) {
    const x = Math.round(g.x(frame.mjd));
    const inFilter = matchesFilter(frame);
    let height = 8 * dpr, alpha = 0.25;
    if (frame.status === "ready" && inFilter) { height = 18 * dpr; alpha = 0.9; }
    else if (frame.status === "ready") { height = 10 * dpr; alpha = 0.3; }
    else if (frame.status === "failed") { height = 6 * dpr; alpha = 0.6; }
    tctx.globalAlpha = alpha;
    tctx.fillStyle = frame.status === "failed" ? "#ff8a6b" : (inFilter ? DETECTOR_COLORS[frame.detector - 1] : "#ece9e2");
    tctx.fillRect(x, base - height, Math.max(1, dpr), height);
  }
  tctx.globalAlpha = 1;
  if (current) {
    const x = Math.round(g.x(current.mjd));
    tctx.fillStyle = ACCENT;
    tctx.fillRect(x - dpr, 2 * dpr, 2 * dpr, base - 2 * dpr);
    tctx.beginPath();
    tctx.moveTo(x - 5 * dpr, 0); tctx.lineTo(x + 5 * dpr, 0); tctx.lineTo(x, 6 * dpr); tctx.closePath();
    tctx.fill();
  }
  el.tStart.textContent = blink.frames[0].date_iso.slice(0, 10);
  el.tEnd.textContent = blink.frames[blink.frames.length - 1].date_iso.slice(0, 10);
}

function seekTimeline(event) {
  const g = timelineGeometry();
  if (!g || !blink.playlist.length) return;
  const rect = el.timeline.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * el.timeline.width;
  let best = 0, bestDist = Infinity;
  blink.playlist.forEach((index, position) => {
    const d = Math.abs(g.x(blink.frames[index].mjd) - x);
    if (d < bestDist) { bestDist = d; best = position; }
  });
  blink.playing = false;
  blink.position = best;
  updateTransport();
  blink.dirty = blink.timelineDirty = true;
}

/* ------------------------------------------------------------- zoom/pan */

function clampPan() {
  const size = el.canvas.width;
  const min = size - size * blink.zoom;
  blink.panX = clamp(blink.panX, min, 0);
  blink.panY = clamp(blink.panY, min, 0);
}

function zoomBy(factor, cx = el.canvas.width / 2, cy = el.canvas.height / 2) {
  const zoom = clamp(blink.zoom * factor, 1, MAX_ZOOM);
  const ratio = zoom / blink.zoom;
  blink.panX = cx - (cx - blink.panX) * ratio;
  blink.panY = cy - (cy - blink.panY) * ratio;
  blink.zoom = zoom;
  clampPan();
  updateView();
}

function resetView() {
  blink.zoom = 1;
  blink.panX = blink.panY = 0;
  updateView();
}

function canvasPoint(event) {
  const rect = el.canvas.getBoundingClientRect();
  const scale = el.canvas.width / rect.width;
  return [(event.clientX - rect.left) * scale, (event.clientY - rect.top) * scale];
}

/* -------------------------------------------------------------------- UI */

function showMessage(text, isError = false) {
  el.message.textContent = text;
  el.message.classList.toggle("error", isError);
  el.message.classList.remove("hidden");
}

function updateMessage() {
  if (blink.searching || blink.frames.length === 0) return;
  if (blink.playlist.length > 0) { el.message.classList.add("hidden"); return; }
  const wanted = blink.frames.filter(matchesFilter);
  const label = blink.detector ? `detector D${blink.detector}` : "this position";
  if (wanted.some((f) => f.status === "pending" || f.status === "loading")) {
    showMessage(`Loading frames for ${label}…`);
  } else {
    showMessage(`None of the images for ${label} could be loaded. Use “Retry failed” to try again.`, true);
  }
}

function updateProgress() {
  const total = blink.frames.length;
  const ready = blink.frames.filter((f) => f.status === "ready").length;
  const failed = blink.frames.filter((f) => f.status === "failed");
  const working = total > 0 && ready + failed.length < total;

  el.loadbar.style.width = total ? `${((ready + failed.length) / total) * 100}%` : "0";
  el.loadbar.classList.toggle("done", !working);
  el.progressText.textContent = total === 0 ? "" :
    `Loaded ${ready} / ${total} frames` + (failed.length ? ` · ${failed.length} failed` : "");
  el.retryFailed.hidden = failed.length === 0 || working;

  el.failures.hidden = failed.length === 0;
  if (failed.length) {
    el.failures.querySelector("summary").textContent = `${failed.length} frame${failed.length === 1 ? "" : "s"} skipped`;
    el.failures.querySelector("ul").replaceChildren(...failed.map((f) => {
      const item = document.createElement("li");
      item.textContent = `${f.date_iso.slice(0, 16).replace("T", " ")} · D${f.detector} · ${f.error}`;
      return item;
    }));
  }
}

function updateDetectors() {
  const buttons = [];
  const make = (detector, label, frames) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "det";
    if (detector) button.style.setProperty("--c", DETECTOR_COLORS[detector - 1]);
    button.disabled = detector !== 0 && blink.frames.length > 0 && frames.length === 0;
    button.setAttribute("aria-pressed", String(blink.detector === detector));
    const first = frames[0];
    button.title = detector && first && first.wavelength_min_um != null
      ? `D${detector}: ${first.wavelength_min_um.toFixed(2)}–${first.wavelength_max_um.toFixed(2)} µm`
      : "All detectors";
    const small = document.createElement("small");
    small.textContent = String(frames.filter((f) => f.status === "ready").length);
    button.append(label, small);
    button.addEventListener("click", () => {
      blink.detector = detector;
      updateAll();
      pumpLoader();
    });
    buttons.push(button);
  };
  make(0, "All", blink.frames);
  for (let d = 1; d <= 6; d += 1) make(d, `D${d}`, blink.frames.filter((f) => f.detector === d));
  el.detectors.replaceChildren(...buttons);
}

function updateTransport() {
  const count = blink.playlist.length;
  el.prev.disabled = el.next.disabled = el.play.disabled = count < 2;
  el.play.classList.toggle("paused", !blink.playing);
  el.play.setAttribute("aria-label", blink.playing ? "Pause" : "Play");
  el.frameCount.textContent = count ? `${blink.position + 1} / ${count}` : "0 / 0";
}

function updateReadouts() {
  el.fpsValue.textContent = `${blink.fps} fps`;
  el.loValue.textContent = `${Number(el.lo.value)} %`;
  el.hiValue.textContent = `${Number(el.hi.value)} %`;
  el.asinhValue.textContent = Number(el.asinh.value) === 0 ? "linear" : `asinh ${el.asinh.value}`;
}

function updateView() {
  el.zoomValue.textContent = `${blink.zoom}×`;
  el.zoomOut.disabled = blink.zoom <= 1;
  el.zoomIn.disabled = blink.zoom >= MAX_ZOOM;
  blink.dirty = true;
}

function updateAll() {
  rebuildPlaylist();
  updateDetectors();
  updateTransport();
  updateProgress();
  updateMessage();
  updateReadouts();
  blink.dirty = blink.timelineDirty = true;
}

function blinkTick(now) {
  if (blink.open) {
    if (blink.playing && blink.playlist.length > 1 && now - blink.lastAdvance >= 1000 / blink.fps) {
      blink.lastAdvance = now;
      step(1);
    }
    if (blink.dirty) { blink.dirty = false; draw(); }
    if (blink.timelineDirty) { blink.timelineDirty = false; drawTimeline(); }
  }
  requestAnimationFrame(blinkTick);
}

/* ================================================================ events */

el.goto.addEventListener("submit", (event) => {
  event.preventDefault();
  const ra = el.ra.value.trim(), dec = el.dec.value.trim();
  if (!ra || !dec) return;
  // The sky can only fly to decimal input here; the backend parses every format
  // and returns the position, which then places the footprint.
  const raDeg = Number(ra), decDeg = Number(dec);
  const decimal = Number.isFinite(raDeg) && Number.isFinite(decDeg);
  const match = sky.targets.find((t) => decimal && Math.abs(t.ra - raDeg) < 1e-5 && Math.abs(t.dec - decDeg) < 1e-5);
  if (match) markActive(match.name);
  startBlink(ra, dec, match ? match.name : null, decimal ? raDeg : NaN, decimal ? decDeg : NaN);
});

el.cardBlink.addEventListener("click", () => {
  const sel = sky.selected;
  if (!sel) return;
  const label = sel.kind === "target" ? sel.target.name : null;
  startBlink(String(sel.ra.toFixed(6)), String(sel.dec.toFixed(6)), label, sel.ra, sel.dec);
});
el.cardClose.addEventListener("click", closeCard);
el.blinkClose.addEventListener("click", () => setDrawer(false));

el.targetsToggle.addEventListener("click", () => {
  const open = el.targetsToggle.getAttribute("aria-expanded") !== "true";
  el.targetsToggle.setAttribute("aria-expanded", String(open));
});

for (const button of document.querySelectorAll(".layer-switch button")) {
  button.addEventListener("click", () => setLayer(button.dataset.layer));
}
el.wave.addEventListener("input", () => {
  updateWaveLabel();
  // Switch layers once the slider rests: each switch starts loading new tiles.
  clearTimeout(sky.waveTimer);
  sky.waveTimer = setTimeout(showWavelength, 220);
});

el.play.addEventListener("click", () => { blink.playing = !blink.playing; updateTransport(); });
el.prev.addEventListener("click", () => { blink.playing = false; step(-1); });
el.next.addEventListener("click", () => { blink.playing = false; step(1); });
el.fps.addEventListener("input", () => { blink.fps = Number(el.fps.value); updateReadouts(); });

for (const input of [el.lo, el.hi, el.asinh, el.lock, el.marker]) {
  input.addEventListener("input", () => { updateReadouts(); blink.dirty = true; });
}
for (const button of document.querySelectorAll(".seg button")) {
  button.addEventListener("click", () => {
    blink.smooth = button.dataset.render === "smooth";
    for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-checked", String(b === button));
    blink.dirty = true;
  });
}
el.resetContrast.addEventListener("click", () => {
  el.lo.value = DEFAULTS.lo; el.hi.value = DEFAULTS.hi; el.asinh.value = DEFAULTS.asinh;
  el.lock.checked = false;
  updateReadouts();
  blink.dirty = true;
});
el.retryFailed.addEventListener("click", retryFailed);

el.zoomIn.addEventListener("click", () => zoomBy(2));
el.zoomOut.addEventListener("click", () => zoomBy(0.5));
el.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 2 : 0.5, ...canvasPoint(event));
}, { passive: false });
el.canvas.addEventListener("dblclick", resetView);

let drag = null;
el.canvas.addEventListener("pointerdown", (event) => {
  if (blink.zoom <= 1) return;
  const [x, y] = canvasPoint(event);
  drag = { x, y, panX: blink.panX, panY: blink.panY };
  el.canvas.setPointerCapture(event.pointerId);
  el.canvas.classList.add("dragging");
});
el.canvas.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const [x, y] = canvasPoint(event);
  blink.panX = drag.panX + (x - drag.x);
  blink.panY = drag.panY + (y - drag.y);
  clampPan();
  blink.dirty = true;
});
for (const type of ["pointerup", "pointercancel"]) {
  el.canvas.addEventListener(type, () => { drag = null; el.canvas.classList.remove("dragging"); });
}

let scrubbing = false;
el.timeline.addEventListener("pointerdown", (event) => {
  scrubbing = true;
  el.timeline.setPointerCapture(event.pointerId);
  seekTimeline(event);
});
el.timeline.addEventListener("pointermove", (event) => { if (scrubbing) seekTimeline(event); });
for (const type of ["pointerup", "pointercancel"]) el.timeline.addEventListener(type, () => { scrubbing = false; });

window.addEventListener("resize", () => {
  blink.timelineDirty = true;
  if (blink.open) setDrawer(true);
});

document.addEventListener("keydown", (event) => {
  if (event.target.closest("input, select, textarea")) return;
  if (event.key === "Escape") {
    if (!el.card.hidden) closeCard();
    else if (blink.open) setDrawer(false);
    return;
  }
  if (!blink.open) return;
  if (event.key === " ") {
    if (event.target.closest("button")) return;
    event.preventDefault();
    blink.playing = !blink.playing;
    updateTransport();
  } else if (event.key === "ArrowLeft") {
    blink.playing = false; step(-1);
  } else if (event.key === "ArrowRight") {
    blink.playing = false; step(1);
  }
});

/* ===================================================== start screen + tour */

const intro = {
  root: $("intro"), tourBtn: $("intro-tour"), startBtn: $("intro-start"), help: $("help"),
  spot: $("tour-spot"), tip: $("tour-tip"), count: $("tour-count"), title: $("tour-title"), text: $("tour-text"),
  back: $("tour-back"), next: $("tour-next"), skip: $("tour-skip"),
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const findTarget = (name) => sky.targets.find((t) => t.name === name);

/** Steps of the guided tour.  `target` is a selector (null = the whole sky). */
const TOUR = [
  {
    target: null,
    title: "This is the sky",
    text: "SPHEREx's own map of the whole sky, built from its first year of observations. Drag to look around and scroll or pinch to zoom. The colours are infrared: blue and green are mostly starlight, red is warm dust.",
  },
  {
    target: "#targets",
    title: "Targets",
    text: "A short list of interesting places: the challenge's test targets (marked “test”), fast-moving stars, stars that change brightness, famous nebulae and galaxies, and SPHEREx's two deep fields. Click one to fly there.",
    before: () => el.targetsToggle.setAttribute("aria-expanded", "true"),
  },
  {
    target: "#card",
    title: "Every target has a card",
    text: "It says what you are looking at. “Blink this target” opens the blink viewer. You can also click any patch of sky, even an empty-looking one, to blink that exact spot.",
    before: async () => {
      const orion = findTarget("Orion Nebula");
      if (orion) selectTarget(orion, { fly: true });
      await wait(REDUCED_MOTION ? 200 : 2600);
    },
  },
  {
    target: "#goto",
    title: "Go to coordinates",
    text: "Know where you want to look? Type a right ascension and declination, in decimal degrees or in hours and degrees (08h55m10.8s, −07d14m42s), and press Blink.",
  },
  {
    target: ".layer-switch",
    title: "Colour or one wavelength",
    text: "Colour combines three of SPHEREx's 102 wavelengths. Choose “One wavelength” and drag the slider to step through them all; its six coloured sections are the six detectors.",
  },
  {
    target: "#blink .stage",
    title: "The blink viewer",
    text: "It plays every SPHEREx image of a 0.1° patch of sky, oldest to newest, lined up so the stars stay still. This is Barnard's Star: it moves about 10″ a year, almost two SPHEREx pixels between the 2025 and 2026 visits.",
    before: async () => {
      const barnard = findTarget("Barnard's Star");
      if (barnard && el.blinkTitle.textContent !== barnard.name) {
        markActive(barnard.name);
        startBlink(barnard.ra.toFixed(6), barnard.dec.toFixed(6), barnard.name, barnard.ra, barnard.dec);
      } else {
        setDrawer(true);
      }
      await wait(700);
    },
  },
  {
    target: "#blink .timeline",
    title: "Timeline",
    text: "Each tick is one image, placed by date and coloured by detector. SPHEREx sees each part of the sky in bursts about six months apart. Click or drag here to jump to an image.",
  },
  {
    target: "#detectors",
    title: "Detectors",
    text: "SPHEREx has six detectors, each covering its own range of wavelengths. Stars look different at different wavelengths, so for a fair comparison blink one detector at a time. The numbers count the images loaded so far.",
  },
  {
    target: "#blink .transport",
    title: "Playback",
    text: "Play and pause (space bar), step one image at a time (← and →), and set the speed in frames per second.",
  },
  {
    target: "#blink .display",
    title: "Display",
    text: "Contrast, smooth or square pixels, and the crosshair live here. Scroll on the image to zoom in; drag to move around.",
    before: () => { document.querySelector("#blink .display").open = true; },
  },
  {
    target: "#help",
    title: "That's the tour",
    text: "Open this introduction again any time with the ? button. Now go and find something that moves.",
  },
];

const tour = { index: -1, busy: false };

function openIntro() {
  endTour();
  intro.root.classList.remove("closed");
  intro.root.removeAttribute("aria-hidden");
  intro.tourBtn.focus({ preventScroll: true });
}

function closeIntro() {
  intro.root.classList.add("closed");
  intro.root.setAttribute("aria-hidden", "true");
}

async function showStep(index) {
  if (index < 0 || index >= TOUR.length || tour.busy) return;
  tour.busy = true;
  tour.index = index;
  const step = TOUR[index];
  intro.tip.hidden = false;
  intro.spot.hidden = false;
  intro.count.textContent = `Step ${index + 1} of ${TOUR.length}`;
  intro.title.textContent = step.title;
  intro.text.textContent = step.text;
  intro.back.disabled = index === 0;
  intro.next.textContent = index === TOUR.length - 1 ? "Start exploring" : "Next";
  try {
    if (step.before) await step.before();
  } finally {
    tour.busy = false;
  }
  intro.next.focus({ preventScroll: true });
}

function endTour() {
  tour.index = -1;
  intro.tip.hidden = true;
  intro.spot.hidden = true;
}

/** Keep the spotlight and the explanation card next to the step's element. */
function placeTour() {
  if (tour.index < 0) return;
  const step = TOUR[tour.index];
  const vw = window.innerWidth, vh = window.innerHeight;
  const node = step.target ? document.querySelector(step.target) : null;
  const rect = node && !node.closest("[hidden]") ? node.getBoundingClientRect() : null;
  const tipW = intro.tip.offsetWidth, tipH = intro.tip.offsetHeight, gap = 18;

  if (NARROW.matches) {
    // Phones: full-width card at whichever end of the screen the element is not.
    const middle = rect && rect.width ? rect.top + rect.height / 2 : vh;
    intro.tip.style.top = `${middle > vh / 2 ? 12 : vh - tipH - 12}px`;
  }
  if (!rect || rect.width === 0) {
    intro.spot.classList.add("whole");
    Object.assign(intro.spot.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: "0px", height: "0px" });
    if (!NARROW.matches) {
      intro.tip.style.left = `${(vw - tipW) / 2}px`;
      intro.tip.style.top = `${(vh - tipH) / 2}px`;
    }
    return;
  }
  intro.spot.classList.remove("whole");
  const pad = 6;
  Object.assign(intro.spot.style, {
    left: `${rect.left - pad}px`, top: `${rect.top - pad}px`,
    width: `${rect.width + 2 * pad}px`, height: `${rect.height + 2 * pad}px`,
  });

  let x, y;
  if (rect.right + gap + tipW < vw - 12) { x = rect.right + gap; y = rect.top; }
  else if (rect.left - gap - tipW > 12) { x = rect.left - gap - tipW; y = rect.top; }
  else if (rect.bottom + gap + tipH < vh - 12) { x = rect.left; y = rect.bottom + gap; }
  else { x = rect.left; y = rect.top - gap - tipH; }
  if (NARROW.matches) return;
  intro.tip.style.left = `${clamp(x, 12, vw - tipW - 12)}px`;
  intro.tip.style.top = `${clamp(y, 12, vh - tipH - 12)}px`;
}

function tourTick() {
  placeTour();
  requestAnimationFrame(tourTick);
}

intro.tourBtn.addEventListener("click", () => { closeIntro(); stopDrift(); showStep(0); });
intro.startBtn.addEventListener("click", closeIntro);
intro.help.addEventListener("click", openIntro);
intro.next.addEventListener("click", () => {
  if (tour.index >= TOUR.length - 1) endTour();
  else showStep(tour.index + 1);
});
intro.back.addEventListener("click", () => showStep(tour.index - 1));
intro.skip.addEventListener("click", endTour);

// Runs before the viewer's own key handling, so the tour and start screen get keys first.
document.addEventListener("keydown", (event) => {
  const introOpen = !intro.root.classList.contains("closed");
  if (introOpen && event.key === "Escape") {
    event.stopImmediatePropagation();
    closeIntro();
  } else if (tour.index >= 0) {
    if (event.key === "Escape") { event.stopImmediatePropagation(); endTour(); }
    else if (event.key === "ArrowRight") { event.stopImmediatePropagation(); intro.next.click(); }
    else if (event.key === "ArrowLeft") { event.stopImmediatePropagation(); showStep(tour.index - 1); }
  } else if (introOpen) {
    event.stopImmediatePropagation(); // keep space/arrows away from the viewer behind
  }
}, { capture: true });

/* ================================================================== init */

// Phones start with the target list folded so the sky is visible.
if (NARROW.matches) el.targetsToggle.setAttribute("aria-expanded", "false");

el.lo.value = DEFAULTS.lo;
el.hi.value = DEFAULTS.hi;
el.asinh.value = DEFAULTS.asinh;
offscreen.width = offscreen.height = blink.grid;
updateAll();
requestAnimationFrame(blinkTick);
requestAnimationFrame(tourTick);
intro.tourBtn.focus({ preventScroll: true });
loadTargets();
initSky()
  .then(() => requestAnimationFrame(skyTick))
  .catch((error) => {
    el.skyLoading.textContent = "The sky map needs WebGL 2. You can still blink positions typed above.";
    console.error(error);
  });

// Exposed for automated checks.
window.__spherex = { sky, blink, el, tour, TOUR };
