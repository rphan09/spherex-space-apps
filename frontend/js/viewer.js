/* The blink viewer: a full-screen view of every SPHEREx image of one field.
 *
 * Frames arrive over one streaming request (/api/stream) as float16 pixels
 * plus a byte per pixel of quality-flag categories.  Everything else (visit
 * stacks, differences, detector stacks, the spectrum, overlays, display
 * stretch) is computed here, so changing a setting never needs a new request.
 */
import {
  $, ACCENT, DETECTOR_COLORS, clamp, decodeFloat16, formatCoords, median, mjdToYear, percentile,
  readError, readMessages, sortedFinite, tanProject, toast,
} from "./util.js";
import { hintButton } from "./help.js";

const DEFAULTS = { lo: 2, hi: 99.7, asinh: 8 };
const MAX_ZOOM = 16;
const EPOCH_GAP_DAYS = 20;          // a gap this long starts a new visit
const APERTURE_R = 2;               // aperture radius, pixels (PSF FWHM is about 1.2 px)
const ANNULUS = [4, 7];             // background ring, pixels
const NO_DATA = [18, 22, 34];
const FLAG_RGBA = [255, 107, 91, 120];
const NEG = [127, 156, 255];        // differences: fainter in this visit (D1 colour)
const POS = [245, 181, 74];         // differences: brighter in this visit (accent)
const ZERO = [30, 32, 38];
const GAIA_COLOR = "rgba(236, 235, 231, A)";
const WISE_COLOR = "rgba(196, 155, 255, A)";
const APERTURE_COLOR = DETECTOR_COLORS[1];
const PROBLEM_BITS = 0x7f;          // flag categories except "known source"

const MODE_NOUNS = { frames: "images", epochs: "visits", difference: "visits", detectors: "detectors" };

const el = {
  viewer: $("viewer"), back: $("v-back"), title: $("v-title"), coords: $("v-coords"),
  fovSeg: $("fov-seg"), share: $("v-share"), full: $("v-full"),
  modeList: $("mode-list"), detectors: $("detectors"),
  ovCrosshair: $("ov-crosshair"), ovGaia: $("ov-gaia"), ovAllwise: $("ov-allwise"), ovFlags: $("ov-flags"),
  ovAperture: $("ov-aperture"),
  stage: $("stage"), canvas: $("canvas"), capTitle: $("cap-title"), capSub: $("cap-sub"), capChip: $("cap-chip"),
  legend: $("legend"), message: $("message"), loadbar: $("loadbar"),
  zoomIn: $("zoom-in"), zoomOut: $("zoom-out"), zoomValue: $("zoom-value"),
  prev: $("prev"), play: $("play"), next: $("next"), frameCount: $("frame-count"), fps: $("fps"), fpsValue: $("fps-value"),
  timeline: $("timeline"), tStart: $("t-start"), tEnd: $("t-end"),
  infoTitle: $("info-title"), facts: $("facts"), flagChips: $("flag-chips"),
  spectrum: $("spectrum"), specReadout: $("spec-readout"), specCsv: $("spec-csv"),
  renderSeg: $("render-seg"), lo: $("lo"), loValue: $("lo-value"), hi: $("hi"), hiValue: $("hi-value"),
  asinh: $("asinh"), asinhValue: $("asinh-value"), lock: $("lock"), resetDisplay: $("reset-display"),
  dataFacts: $("data-facts"), retryFailed: $("retry-failed"), failures: $("failures"),
  shareDialog: $("share"), shareLink: $("share-link"), shareEmbed: $("share-embed"), shareClose: $("share-close"),
};
const ctx = el.canvas.getContext("2d");
const tctx = el.timeline.getContext("2d");
const sctx = el.spectrum.getContext("2d");
const off = document.createElement("canvas");
const offCtx = off.getContext("2d", { willReadFrequently: true });
const flagOff = document.createElement("canvas");
const flagCtx = flagOff.getContext("2d");

export const V = {
  open: false,
  embed: false,
  info: null,
  query: null,          // { ra, dec, name, fov } as requested
  center: null,         // { ra, dec } as resolved by the server
  grid: 59,
  scale: 6.15,
  collections: [],
  generation: 0,
  searchAbort: null,
  streamAbort: null,
  loading: false,
  searching: false,
  frames: [],
  byId: new Map(),
  epochs: [],
  items: [],
  position: 0,
  mode: "frames",
  detector: 0,
  playing: true,
  fps: 4,
  zoom: 1, panX: 0, panY: 0,
  smooth: true,
  aperture: null,       // { x, y } in grid pixels
  catalogs: {},         // name -> { status, rows, epoch, label, error }
  stackCache: new Map(),
  lockedRange: null,
  dirty: true,
  timelineDirty: true,
  spectrumDirty: true,
  lastAdvance: 0,
  specPoints: [],
  onChange: () => {},   // set by main.js: keep the URL in step
  onClose: () => {},
};

/* ================================================================ public */

export function initViewer(info) {
  V.info = info;
  const choices = info?.fov_choices || [0.05, 0.1, 0.2, 0.3];
  el.fovSeg.replaceChildren(...choices.map((fov) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.dataset.fov = String(fov);
    button.textContent = `${fov}°`;
    button.title = fov > 0.1 ? "Larger field: follows faster movers, but each image is bigger to download" : "";
    button.addEventListener("click", () => setFov(fov));
    return button;
  }));
  buildDetectors();
  el.lo.value = DEFAULTS.lo; el.hi.value = DEFAULTS.hi; el.asinh.value = DEFAULTS.asinh;
  updateReadouts();
  new ResizeObserver(resizeCanvases).observe(el.stage);
  new ResizeObserver(resizeCanvases).observe(el.timeline);
  new ResizeObserver(resizeCanvases).observe(el.spectrum);
  requestAnimationFrame(tick);
}

/** Open the viewer on a field.  `q`: { ra, dec, name?, fov?, mode?, detector? } (ra/dec as text or numbers). */
export function openViewer(q) {
  const fov = Number(q.fov) || V.info?.default_fov || 0.1;
  V.query = { ra: String(q.ra), dec: String(q.dec), name: q.name || null, fov };
  V.mode = ["frames", "epochs", "difference", "detectors"].includes(q.mode) ? q.mode : "frames";
  V.detector = clamp(Number(q.detector) || 0, 0, 6);
  V.open = true;
  el.viewer.hidden = false;
  document.body.classList.add("viewer-open");
  el.viewer.style.animation = "none"; void el.viewer.offsetWidth; el.viewer.style.animation = "";
  el.title.textContent = V.query.name || "Selected position";
  el.coords.textContent = "";
  syncControls();
  load();
  V.onChange();
}

export function closeViewer() {
  if (!V.open) return;
  V.open = false;
  abortAll();
  V.generation += 1;
  el.viewer.hidden = true;
  document.body.classList.remove("viewer-open");
  V.onClose();
}

/** Parameters describing the current view (for the URL and the share dialog). */
export function viewParams() {
  if (!V.query) return null;
  const p = { ra: V.query.ra, dec: V.query.dec };
  if (V.query.fov !== (V.info?.default_fov ?? 0.1)) p.fov = String(V.query.fov);
  if (V.query.name) p.name = V.query.name;
  if (V.mode !== "frames") p.mode = V.mode;
  if (V.detector) p.det = String(V.detector);
  return p;
}

/* =============================================================== loading */

function abortAll() {
  if (V.searchAbort) V.searchAbort.abort();
  if (V.streamAbort) V.streamAbort.abort();
  V.searchAbort = V.streamAbort = null;
  V.loading = false;
}

async function load() {
  abortAll();
  const generation = ++V.generation;
  V.frames = []; V.byId = new Map(); V.epochs = []; V.items = []; V.position = 0;
  V.catalogs = {}; V.stackCache.clear(); V.lockedRange = null; V.specPoints = [];
  V.searching = true;
  resetView();
  showMessage("Searching the SPHEREx archive…");
  refreshAll();

  const controller = new AbortController();
  V.searchAbort = controller;
  let result;
  try {
    const params = new URLSearchParams({ ra: V.query.ra, dec: V.query.dec, fov: String(V.query.fov) });
    const response = await fetch(`api/search?${params}`, { signal: controller.signal, priority: "high" });
    if (generation !== V.generation) return;
    if (!response.ok) {
      V.searching = false;
      showMessage(await readError(response), true);
      refreshAll();
      return;
    }
    result = await response.json();
  } catch (error) {
    if (error.name === "AbortError" || generation !== V.generation) return;
    V.searching = false;
    showMessage("Could not reach the server. Check that the backend is running.", true);
    refreshAll();
    return;
  }
  if (generation !== V.generation) return;

  V.searching = false;
  V.grid = result.grid_size;
  V.scale = result.pixel_scale_arcsec;
  V.center = { ra: result.ra, dec: result.dec };
  V.collections = result.collections || [];
  V.aperture = { x: (V.grid - 1) / 2, y: (V.grid - 1) / 2 };
  off.width = off.height = flagOff.width = flagOff.height = V.grid;
  el.coords.textContent = formatCoords(result.ra, result.dec);
  V.frames = result.images.map((image) => ({
    ...image, status: "pending", data: null, mask: null, sorted: null, enclosed: null, meta: null,
    wavelength: null, error: null, epoch: -1, phot: null,
  }));
  for (const frame of V.frames) V.byId.set(frame.id, frame);
  computeEpochs();
  if (V.frames.length === 0) showMessage(result.message || "No SPHEREx images cover this position yet.");
  else showMessage(`Found ${V.frames.length} images. Loading…`);
  for (const name of ["gaia", "allwise"]) if (overlayOn(name)) loadCatalog(name);
  refreshAll();
  startStream();
}

function computeEpochs() {
  V.epochs = [];
  let current = null;
  for (const frame of V.frames) {
    if (!current || frame.mjd - current.end > EPOCH_GAP_DAYS) {
      current = { index: V.epochs.length, start: frame.mjd, end: frame.mjd, frames: [] };
      V.epochs.push(current);
    }
    current.end = frame.mjd;
    current.frames.push(frame);
    frame.epoch = current.index;
  }
}

const matches = (frame) => V.detector === 0 || frame.detector === V.detector;

/**
 * Order in which to request frames: the selected detector first, and within
 * that round-robin over (visit, detector) groups, so the first few images
 * already span every visit and the blink is useful within seconds.
 */
function loadOrder() {
  const pending = V.frames.filter((f) => f.status === "pending");
  const roundRobin = (list) => {
    const groups = new Map();
    for (const f of list) {
      const key = `${f.epoch}|${f.detector}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const queues = [...groups.values()];
    const out = [];
    for (let i = 0; out.length < list.length; i += 1) {
      for (const q of queues) if (i < q.length) out.push(q[i]);
    }
    return out;
  };
  return [...roundRobin(pending.filter(matches)), ...roundRobin(pending.filter((f) => !matches(f)))];
}

async function startStream() {
  if (V.streamAbort) V.streamAbort.abort();
  const order = loadOrder();
  if (!order.length) { V.loading = false; refreshAll(); return; }
  const controller = new AbortController();
  const generation = V.generation;
  V.streamAbort = controller;
  V.loading = true;
  refreshAll();
  try {
    const response = await fetch("api/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ra: V.query.ra, dec: V.query.dec, fov: V.query.fov, ids: order.map((f) => f.id) }),
      signal: controller.signal,
      priority: "high",
    });
    if (!response.ok) throw new Error(await readError(response));
    await readMessages(response, (header, payload) => {
      if (generation === V.generation && !controller.signal.aborted) onFrame(header, payload);
    });
  } catch (error) {
    if (controller.signal.aborted || generation !== V.generation) return;
    for (const f of V.frames) if (f.status === "pending") { f.status = "failed"; f.error = error.message || "Connection lost"; }
    toast(`Loading stopped: ${error.message || "connection lost"}`);
  } finally {
    if (V.streamAbort === controller) {
      V.streamAbort = null;
      V.loading = false;
      refreshAll();
    }
  }
}

function onFrame(header, payload) {
  if (header.done) return;
  const frame = V.byId.get(header.id);
  if (!frame) return;
  if (!header.ok) {
    frame.status = "failed";
    frame.error = header.error || "Unknown error";
  } else {
    const n = header.width * header.height;
    frame.data = decodeFloat16(payload.subarray(0, n * 2));
    frame.mask = payload.slice(n * 2, n * 3);
    frame.meta = header.meta;
    frame.wavelength = header.meta?.wavelength_um ?? null;
    frame.sorted = sortedFinite(frame.data);
    frame.enclosed = enclosedNoData(frame.data, header.width);
    frame.phot = null;
    frame.status = "ready";
  }
  scheduleRefresh();
}

function retryFailed() {
  for (const f of V.frames) if (f.status === "failed") { f.status = "pending"; f.error = null; }
  startStream();
}

/* -------------------------------------------------------------- catalogs */

const overlayOn = (name) => (name === "gaia" ? el.ovGaia.checked : el.ovAllwise.checked);

async function loadCatalog(name) {
  if (!V.query || V.catalogs[name]?.status === "loading" || V.catalogs[name]?.status === "ready") return;
  const generation = V.generation;
  V.catalogs[name] = { status: "loading" };
  try {
    const params = new URLSearchParams({ name, ra: V.query.ra, dec: V.query.dec, fov: String(V.query.fov) });
    const response = await fetch(`api/catalog?${params}`);
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    if (generation !== V.generation) return;
    V.catalogs[name] = { status: "ready", rows: data.rows, epoch: data.epoch, label: data.label };
  } catch (error) {
    if (generation !== V.generation) return;
    V.catalogs[name] = { status: "error", error: error.message };
    toast(`${name === "gaia" ? "Gaia" : "AllWISE"} overlay unavailable: ${error.message}`);
  }
  V.dirty = true;
}

/** Fill an element with separate spans (facts are separated by space, not punctuation). */
function setParts(node, parts) {
  node.replaceChildren(...parts.filter(Boolean).map((text) => {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }));
}

/* ============================================================ view items */

/** Rebuild the list of things to blink through for the current mode and detector. */
function rebuildItems() {
  const keep = V.items[V.position];
  const ready = V.frames.filter((f) => f.status === "ready");
  let items = [];
  if (V.mode === "frames") {
    items = ready.filter(matches).map((f) => ({ key: `f:${f.id}`, kind: "frame", frame: f, mjd: f.mjd }));
  } else if (V.mode === "epochs" || V.mode === "difference") {
    const pool = ready.filter(matches);
    for (const epoch of V.epochs) {
      const members = pool.filter((f) => f.epoch === epoch.index);
      if (!members.length) continue;
      const others = pool.filter((f) => f.epoch !== epoch.index);
      if (V.mode === "difference" && !others.length) continue;
      items.push({
        key: `${V.mode}:${epoch.index}`, kind: V.mode === "epochs" ? "stack" : "diff", epoch, members, others,
        mjd: members.reduce((s, f) => s + f.mjd, 0) / members.length,
      });
    }
  } else {
    for (let d = 1; d <= 6; d += 1) {
      const members = ready.filter((f) => f.detector === d);
      if (!members.length) continue;
      items.push({ key: `det:${d}`, kind: "stack", detector: d, members,
        mjd: members.reduce((s, f) => s + f.mjd, 0) / members.length });
    }
  }
  V.items = items;
  let position = keep ? items.findIndex((it) => it.key === keep.key) : 0;
  if (position < 0 && keep) {
    // Keep the closest item in time.
    let best = Infinity;
    items.forEach((it, i) => { const d = Math.abs(it.mjd - keep.mjd); if (d < best) { best = d; position = i; } });
  }
  V.position = clamp(position < 0 ? 0 : position, 0, Math.max(0, items.length - 1));
  V.lockedRange = null;
}

const currentItem = () => V.items[V.position] || null;

function meanStack(frames) {
  const n = V.grid * V.grid;
  const sum = new Float32Array(n), count = new Uint16Array(n);
  for (const f of frames) {
    const data = f.data;
    for (let i = 0; i < n; i += 1) {
      const v = data[i];
      if (v === v) { sum[i] += v; count[i] += 1; }   // v === v: not NaN
    }
  }
  for (let i = 0; i < n; i += 1) sum[i] = count[i] ? sum[i] / count[i] : NaN;
  return sum;
}

/** Pixels (and display helpers) for an item; stacks are cached and refreshed as frames arrive. */
function imageFor(item) {
  if (item.kind === "frame") {
    const f = item.frame;
    return { data: f.data, sorted: f.sorted, enclosed: f.enclosed, diverging: false };
  }
  const signature = `${item.members.length}|${item.others ? item.others.length : 0}`;
  const cached = V.stackCache.get(item.key);
  // While frames stream in, recompute a stack at most every 0.8 s.
  if (cached && (cached.signature === signature || (V.loading && performance.now() - cached.at < 800))) return cached;
  let data;
  if (item.kind === "diff") {
    const a = meanStack(item.members), b = meanStack(item.others);
    data = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 1) data[i] = a[i] - b[i];
  } else {
    data = meanStack(item.members);
  }
  const image = {
    data, signature, at: performance.now(), diverging: item.kind === "diff",
    sorted: item.kind === "diff" ? sortedFinite(data.map(Math.abs)) : sortedFinite(data),
    enclosed: item.kind === "diff" ? null : enclosedNoData(data, V.grid),
  };
  V.stackCache.set(item.key, image);
  return image;
}

/** No-data pixels enclosed by data (saturated star cores) - drawn white, not as holes. */
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

function step(delta) {
  const count = V.items.length;
  if (!count) return;
  V.position = ((V.position + delta) % count + count) % count;
  V.dirty = V.timelineDirty = V.spectrumDirty = true;
  updateTransport();
  updateInfo();
}

/* ============================================================== drawing */

function displayRange(image) {
  const lo = Number(el.lo.value), hi = Number(el.hi.value);
  if (image.diverging) {
    const limit = percentile(image.sorted, hi) || 1;
    return [-limit, limit];
  }
  if (!el.lock.checked) return [percentile(image.sorted, lo), percentile(image.sorted, hi)];
  const key = `${lo}|${hi}|${V.mode}|${V.detector}|${V.items.length}`;
  if (!V.lockedRange || V.lockedRange.key !== key) {
    const images = V.items.map(imageFor).filter((im) => !im.diverging);
    V.lockedRange = {
      key,
      lo: median(images.map((im) => percentile(im.sorted, lo))),
      hi: median(images.map((im) => percentile(im.sorted, hi))),
    };
  }
  return [V.lockedRange.lo, V.lockedRange.hi];
}

let paintBuffer = null;
function imageBuffer(context, existing) {
  return existing && existing.width === V.grid ? existing : context.createImageData(V.grid, V.grid);
}

function paint(image) {
  const [low, high] = displayRange(image);
  const strength = Number(el.asinh.value);
  const norm = strength > 0 ? Math.asinh(strength) : 1;
  const curve = (t) => (strength > 0 ? Math.asinh(strength * t) / norm : t);
  const out = paintBuffer = imageBuffer(offCtx, paintBuffer);
  const px = out.data, data = image.data, enclosed = image.enclosed;
  const span = high > low ? high - low : 1;
  for (let i = 0, o = 0; i < data.length; i += 1, o += 4) {
    const v = data[i];
    if (v === v) {
      if (image.diverging) {
        const t = curve(clamp(Math.abs(v) / high, 0, 1));
        const c = v >= 0 ? POS : NEG;
        px[o] = ZERO[0] + (c[0] - ZERO[0]) * t;
        px[o + 1] = ZERO[1] + (c[1] - ZERO[1]) * t;
        px[o + 2] = ZERO[2] + (c[2] - ZERO[2]) * t;
      } else {
        const g = Math.round(curve(clamp((v - low) / span, 0, 1)) * 255);
        px[o] = px[o + 1] = px[o + 2] = g;
      }
    } else if (enclosed && enclosed[i]) {
      px[o] = px[o + 1] = px[o + 2] = 255;
    } else {
      [px[o], px[o + 1], px[o + 2]] = NO_DATA;
    }
    px[o + 3] = 255;
  }
  offCtx.putImageData(out, 0, 0);
}

let flagBuffer = null;
function paintFlags(mask) {
  const out = flagBuffer = imageBuffer(flagCtx, flagBuffer);
  const px = out.data;
  let count = 0;
  for (let i = 0, o = 0; i < mask.length; i += 1, o += 4) {
    if (mask[i] & PROBLEM_BITS) {
      [px[o], px[o + 1], px[o + 2], px[o + 3]] = FLAG_RGBA;
      count += 1;
    } else {
      px[o + 3] = 0;   // the buffer is reused: clear pixels flagged in the previous image
    }
  }
  flagCtx.putImageData(out, 0, 0);
  return count;
}

/** Grid pixel (column, row; floats) of a sky position. */
function skyToGrid(ra, dec) {
  const [xi, eta] = tanProject(ra, dec, V.center.ra, V.center.dec);
  const c = (V.grid - 1) / 2;
  return [c - (xi * 3600) / V.scale, c - (eta * 3600) / V.scale];
}

function draw() {
  const size = el.canvas.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  const item = currentItem();
  updateCaption(item);
  if (!item) { el.legend.hidden = true; return; }

  const image = imageFor(item);
  paint(image);
  const scaled = size * V.zoom;
  const cell = scaled / V.grid;
  const toCanvas = (col, row) => [V.panX + (col + 0.5) * cell, V.panY + (row + 0.5) * cell];
  ctx.imageSmoothingEnabled = V.smooth;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, V.panX, V.panY, scaled, scaled);

  const legend = [];
  if (image.diverging) {
    legend.push(`<span><i style="background:${ACCENT}"></i>Brighter in this visit</span>`,
                `<span><i style="background:rgb(${NEG})"></i>Brighter in the other visits</span>`);
  }
  if (el.ovFlags.checked) {
    if (item.kind === "frame" && item.frame.mask) {
      const n = paintFlags(item.frame.mask);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(flagOff, V.panX, V.panY, scaled, scaled);
      legend.push(`<span><i style="background:rgba(${FLAG_RGBA.slice(0, 3)},0.8)"></i>${n} flagged pixels</span>`);
    } else {
      legend.push("<span>Flags are shown for single images</span>");
    }
  }

  const dpr = size / el.canvas.clientWidth || 1;
  const year = mjdToYear(item.mjd);
  for (const [name, color, shape] of [["gaia", GAIA_COLOR, "circle"], ["allwise", WISE_COLOR, "square"]]) {
    const cat = V.catalogs[name];
    if (!overlayOn(name) || !cat || cat.status !== "ready") continue;
    const dt = year - cat.epoch;
    let shown = 0;
    ctx.lineWidth = 1.4 * dpr;
    for (const [ra0, dec0, pmra, pmdec, mag] of cat.rows) {
      let ra = ra0, dec = dec0;
      if (pmra != null && pmdec != null) {
        dec = dec0 + (pmdec / 3.6e6) * dt;
        ra = ra0 + (pmra / 3.6e6) * dt / Math.cos((dec0 * Math.PI) / 180);
      }
      const [col, row] = skyToGrid(ra, dec);
      if (col < -1 || row < -1 || col > V.grid || row > V.grid) continue;
      const [x, y] = toCanvas(col, row);
      if (x < -20 || y < -20 || x > size + 20 || y > size + 20) continue;
      const m = mag ?? 18;
      const r = Math.max(3 * dpr, cell * clamp(1.5 - (m - 8) * 0.07, 0.45, 2.2));
      ctx.strokeStyle = color.replace("A", String(clamp(1.05 - (m - 8) * 0.05, 0.35, 0.95)));
      ctx.beginPath();
      if (shape === "circle") ctx.arc(x, y, r, 0, 2 * Math.PI);
      else ctx.rect(x - r, y - r, 2 * r, 2 * r);
      ctx.stroke();
      shown += 1;
    }
    legend.push(`<span><i style="border:2px solid ${color.replace("A", "0.9")};background:none;${shape === "circle" ? "border-radius:50%" : ""}"></i>${shown} ${cat.label}</span>`);
  }

  if (el.ovAperture.checked && V.aperture) {
    const [x, y] = toCanvas(V.aperture.x, V.aperture.y);
    ctx.strokeStyle = APERTURE_COLOR;
    ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath(); ctx.arc(x, y, APERTURE_R * cell, 0, 2 * Math.PI); ctx.stroke();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.lineWidth = 1 * dpr;
    for (const r of ANNULUS) { ctx.beginPath(); ctx.arc(x, y, r * cell, 0, 2 * Math.PI); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  if (el.ovCrosshair.checked) {
    const c = (V.grid - 1) / 2;
    const [x, y] = toCanvas(c, c);
    const r = Math.max(14 * dpr, cell * 1.6);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(x + dx * r, y + dy * r);
      ctx.lineTo(x + dx * (r + 14 * dpr), y + dy * (r + 14 * dpr));
    }
    ctx.stroke();
  }

  el.legend.innerHTML = legend.join("");
  el.legend.hidden = legend.length === 0;
}

const fmtDate = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const fmtDay = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);
const bandOf = (d) => {
  const f = V.frames.find((x) => x.detector === d && x.wavelength_min_um != null);
  return f ? `${f.wavelength_min_um.toFixed(2)}–${f.wavelength_max_um.toFixed(2)} µm` : "";
};
const visitRange = (epoch) => {
  const a = fmtDay(epoch.start), b = fmtDay(epoch.end);
  return a === b ? a : `${a} to ${b.slice(5)}`;
};

function updateCaption(item) {
  let title = "", parts = [], color = "";
  const which = V.detector ? `D${V.detector}` : "All detectors";
  if (item?.kind === "frame") {
    const f = item.frame;
    title = fmtDate(f.date_iso);
    parts = [`D${f.detector}`, f.wavelength != null ? `${f.wavelength.toFixed(3)} µm` : bandOf(f.detector)];
    color = DETECTOR_COLORS[f.detector - 1];
  } else if (item?.kind === "stack" && item.epoch) {
    title = `Visit ${item.epoch.index + 1} of ${V.epochs.length}`;
    parts = [visitRange(item.epoch), `${item.members.length} images`, which];
    color = V.detector ? DETECTOR_COLORS[V.detector - 1] : "";
  } else if (item?.kind === "stack") {
    title = `D${item.detector} stack`;
    parts = [bandOf(item.detector), `${item.members.length} images`];
    color = DETECTOR_COLORS[item.detector - 1];
  } else if (item?.kind === "diff") {
    const others = V.epochs.filter((e) => e !== item.epoch && item.others.some((f) => f.epoch === e.index));
    title = `Visit ${item.epoch.index + 1} minus visit${others.length > 1 ? "s" : ""} ${others.map((e) => e.index + 1).join(", ")}`;
    parts = [`${item.members.length} against ${item.others.length} images`, which];
    color = V.detector ? DETECTOR_COLORS[V.detector - 1] : "";
  }
  el.capTitle.textContent = title;
  setParts(el.capSub, parts);
  el.capChip.style.setProperty("--c", color || "transparent");
}

/* ------------------------------------------------------------- timeline */

function drawTimeline() {
  const w = el.timeline.width, h = el.timeline.height;
  const dpr = w / Math.max(1, el.timeline.clientWidth);
  tctx.clearRect(0, 0, w, h);
  const frames = V.frames;
  if (!frames.length) { el.tStart.textContent = el.tEnd.textContent = ""; return; }
  const t0 = frames[0].mjd, t1 = frames[frames.length - 1].mjd, pad = 10 * dpr;
  const x = (mjd) => pad + (t1 > t0 ? (mjd - t0) / (t1 - t0) : 0.5) * (w - 2 * pad);
  const base = h - 8 * dpr;
  const item = currentItem();

  // Highlight the visit(s) behind the current item.
  if (item && item.epoch) {
    tctx.fillStyle = "rgba(245, 181, 74, 0.16)";
    const a = x(item.epoch.start), b = x(item.epoch.end);
    tctx.fillRect(Math.min(a, b - 3 * dpr) - 3 * dpr, 0, Math.max(6 * dpr, b - a + 6 * dpr), base);
  }
  tctx.fillStyle = "rgba(255,255,255,0.12)";
  tctx.fillRect(pad, base, w - 2 * pad, dpr);

  for (const f of frames) {
    const inView = matches(f) && (!(item && item.kind === "stack" && item.detector) || f.detector === item.detector);
    let height = 8 * dpr, alpha = 0.22;
    if (f.status === "ready" && inView) { height = 22 * dpr; alpha = 0.9; }
    else if (f.status === "ready") { height = 12 * dpr; alpha = 0.3; }
    else if (f.status === "failed") { height = 6 * dpr; alpha = 0.7; }
    tctx.globalAlpha = alpha;
    tctx.fillStyle = f.status === "failed" ? "#ff6b5b" : (inView ? DETECTOR_COLORS[f.detector - 1] : "#ecebe7");
    tctx.fillRect(Math.round(x(f.mjd)), base - height, Math.max(1, dpr), height);
  }
  tctx.globalAlpha = 1;
  if (item && item.kind === "frame") {
    const cx = Math.round(x(item.mjd));
    tctx.fillStyle = ACCENT;
    tctx.fillRect(cx - dpr, 6 * dpr, 2 * dpr, base - 6 * dpr);
    tctx.beginPath();
    tctx.moveTo(cx - 5 * dpr, 0); tctx.lineTo(cx + 5 * dpr, 0); tctx.lineTo(cx, 6 * dpr); tctx.closePath();
    tctx.fill();
  }
  el.tStart.textContent = frames[0].date_iso.slice(0, 10);
  el.tEnd.textContent = frames[frames.length - 1].date_iso.slice(0, 10);
}

function seekTimeline(event) {
  if (!V.frames.length || !V.items.length) return;
  const rect = el.timeline.getBoundingClientRect();
  const frac = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const t0 = V.frames[0].mjd, t1 = V.frames[V.frames.length - 1].mjd;
  const mjd = t0 + frac * (t1 - t0);
  let best = 0, bestDist = Infinity;
  V.items.forEach((it, i) => {
    const span = it.epoch ? (mjd >= it.epoch.start - 1 && mjd <= it.epoch.end + 1 ? 0 : Math.abs(it.mjd - mjd)) : Math.abs(it.mjd - mjd);
    if (span < bestDist) { bestDist = span; best = i; }
  });
  V.playing = false;
  V.position = best;
  V.dirty = V.timelineDirty = V.spectrumDirty = true;
  updateTransport();
  updateInfo();
}

/* ------------------------------------------------------------- spectrum */

/** Aperture photometry of one frame at the current aperture: flux in mJy, and whether any pixel is flagged. */
function photometry(frame) {
  const key = `${V.aperture.x.toFixed(2)},${V.aperture.y.toFixed(2)}`;
  if (frame.phot && frame.phot.key === key) return frame.phot;
  const n = V.grid, { x: ax, y: ay } = V.aperture;
  const ring = [];
  let sum = 0, count = 0, expected = 0, flagged = false;
  const r2 = APERTURE_R * APERTURE_R, in2 = ANNULUS[0] ** 2, out2 = ANNULUS[1] ** 2;
  for (let row = Math.max(0, Math.floor(ay - ANNULUS[1])); row <= Math.min(n - 1, Math.ceil(ay + ANNULUS[1])); row += 1) {
    for (let col = Math.max(0, Math.floor(ax - ANNULUS[1])); col <= Math.min(n - 1, Math.ceil(ax + ANNULUS[1])); col += 1) {
      const d2 = (col - ax) ** 2 + (row - ay) ** 2;
      const v = frame.data[row * n + col];
      if (d2 <= r2) {
        expected += 1;
        if (v === v) { sum += v; count += 1; }
        if (frame.mask[row * n + col] & PROBLEM_BITS) flagged = true;
      } else if (d2 >= in2 && d2 <= out2 && v === v) {
        ring.push(v);
      }
    }
  }
  let flux = null;
  if (count >= 0.6 * expected && ring.length >= 8) {
    const background = median(ring);
    const pixelSr = (V.scale / 206264.806) ** 2;
    flux = (sum - count * background) * pixelSr * 1e9;   // MJy/sr * sr = MJy; * 1e9 = mJy
  }
  frame.phot = { key, flux, flagged };
  return frame.phot;
}

function niceTicks(lo, hi, count = 4) {
  const span = hi - lo || 1;
  const stepRaw = span / count;
  const mag = 10 ** Math.floor(Math.log10(stepRaw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= stepRaw) || mag * 10;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(+t.toPrecision(6));
  return ticks;
}

function drawSpectrum() {
  const w = el.spectrum.width, h = el.spectrum.height;
  const dpr = w / Math.max(1, el.spectrum.clientWidth);
  sctx.clearRect(0, 0, w, h);
  V.specPoints = [];
  const ready = V.frames.filter((f) => f.status === "ready" && f.wavelength != null);
  if (!ready.length || !V.aperture) {
    sctx.fillStyle = "#ecebe7";
    sctx.font = `${13 * dpr}px "Public Sans", sans-serif`;
    sctx.fillText(V.frames.length ? "The spectrum appears as images load." : "", 12 * dpr, 24 * dpr);
    return;
  }
  const points = ready.map((f) => ({ f, ...photometry(f) })).filter((p) => p.flux != null);
  const fluxes = points.map((p) => p.flux).sort((a, b) => a - b);
  let lo = percentile(fluxes, 2), hi = percentile(fluxes, 98);
  const padY = (hi - lo || Math.abs(hi) || 1) * 0.15;
  lo -= padY; hi += padY;
  const L = 46 * dpr, R = 10 * dpr, T = 10 * dpr, B = 28 * dpr;
  const X = (um) => L + ((um - 0.7) / (5.2 - 0.7)) * (w - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);

  sctx.font = `${11.5 * dpr}px "Public Sans", sans-serif`;
  sctx.fillStyle = "#ecebe7";
  sctx.strokeStyle = "rgba(255,255,255,0.08)";
  sctx.lineWidth = dpr;
  for (const t of niceTicks(lo, hi)) {
    const y = Y(t);
    sctx.beginPath(); sctx.moveTo(L, y); sctx.lineTo(w - R, y); sctx.stroke();
    sctx.textAlign = "right"; sctx.textBaseline = "middle";
    sctx.fillText(Math.abs(t) >= 100 ? t.toFixed(0) : t.toPrecision(3).replace(/\.?0+$/, ""), L - 6 * dpr, y);
  }
  sctx.textAlign = "center"; sctx.textBaseline = "top";
  for (const um of [1, 2, 3, 4]) sctx.fillText(`${um}`, X(um), h - B + 6 * dpr);
  sctx.fillText("5 µm", X(5), h - B + 6 * dpr);
  sctx.save(); sctx.translate(11 * dpr, T + (h - T - B) / 2); sctx.rotate(-Math.PI / 2);
  sctx.textAlign = "center"; sctx.textBaseline = "middle"; sctx.fillText("mJy", 0, 0); sctx.restore();

  const item = currentItem();
  const highlight = new Set(item?.kind === "frame" ? [item.frame] : []);
  for (const p of points) {
    const x = X(p.f.wavelength), y = Y(clamp(p.flux, lo, hi));
    const color = DETECTOR_COLORS[p.f.detector - 1];
    sctx.globalAlpha = matches(p.f) ? 0.9 : 0.25;
    sctx.beginPath(); sctx.arc(x, y, 3 * dpr, 0, 2 * Math.PI);
    if (p.flagged) { sctx.strokeStyle = color; sctx.lineWidth = 1.3 * dpr; sctx.stroke(); }
    else { sctx.fillStyle = color; sctx.fill(); }
    V.specPoints.push({ x, y, p });
  }
  sctx.globalAlpha = 1;
  for (const p of points) {
    if (!highlight.has(p.f)) continue;
    sctx.strokeStyle = ACCENT; sctx.lineWidth = 2 * dpr;
    sctx.beginPath(); sctx.arc(X(p.f.wavelength), Y(clamp(p.flux, lo, hi)), 7 * dpr, 0, 2 * Math.PI); sctx.stroke();
  }
}

function spectrumPointAt(event) {
  const rect = el.spectrum.getBoundingClientRect();
  const dpr = el.spectrum.width / Math.max(1, rect.width);
  const mx = (event.clientX - rect.left) * dpr, my = (event.clientY - rect.top) * dpr;
  let best = null, bestD = (10 * dpr) ** 2;
  for (const s of V.specPoints) {
    const d = (s.x - mx) ** 2 + (s.y - my) ** 2;
    if (d < bestD) { bestD = d; best = s.p; }
  }
  return best;
}

function describePoint(p) {
  return [`${p.f.wavelength.toFixed(3)} µm`, `${p.flux.toFixed(2)} mJy`, p.f.date_iso.slice(0, 10),
    `D${p.f.detector}`, p.flagged ? "Flagged" : ""];
}

function downloadSpectrum() {
  const rows = V.frames.filter((f) => f.status === "ready" && f.wavelength != null)
    .map((f) => ({ f, ...photometry(f) })).filter((p) => p.flux != null)
    .sort((a, b) => a.f.wavelength - b.f.wavelength);
  if (!rows.length) { toast("No spectrum points yet."); return; }
  const c = (V.grid - 1) / 2;
  const header = [
    `# SPHEREx Blink spectrum. Field centre RA ${V.center.ra} Dec ${V.center.dec} (deg); aperture offset`,
    `# ${((c - V.aperture.x) * V.scale).toFixed(1)}" east, ${((c - V.aperture.y) * V.scale).toFixed(1)}" north of centre; radius ${APERTURE_R} px (${(APERTURE_R * V.scale).toFixed(1)}").`,
    "# Aperture photometry on zodi-subtracted SPHEREx spectral images; background from an annulus; no aperture correction.",
    "wavelength_um,flux_mJy,flagged,detector,mjd,date_utc,image_id",
  ];
  const lines = rows.map((r) => [r.f.wavelength.toFixed(5), r.flux.toFixed(4), r.flagged ? 1 : 0, r.f.detector,
    r.f.mjd, r.f.date_iso, r.f.id].join(","));
  const blob = new Blob([[...header, ...lines].join("\n") + "\n"], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `spherex_spectrum_${V.center.ra.toFixed(4)}_${V.center.dec.toFixed(4)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

/* ============================================================ side panels */

/** One label/value row; `help` adds a help icon after the label. */
function fact(label, value, help) {
  return [label, value, help || ""];
}

/**
 * Show rows in a <dl>, rebuilding it only when they change.  Frames arrive
 * several times a second; rebuilding every time would also close an open
 * help popover and drop keyboard focus.
 */
function setFacts(list, rows) {
  const signature = JSON.stringify(rows);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const nodes = [];
  for (let i = 0; i < rows.length; i += 3) {
    const [label, value, help] = rows.slice(i, i + 3);
    const dt = document.createElement("dt");
    dt.textContent = label;
    if (help) dt.append(hintButton(help));
    const dd = document.createElement("dd");
    dd.textContent = value;
    const row = document.createElement("div");   // one group per row, so each row sizes itself
    row.append(dt, dd);
    nodes.push(row);
  }
  list.replaceChildren(...nodes);
}

function updateInfo() {
  const item = currentItem();
  const nodes = [];
  const chips = [];
  if (!item) {
    el.infoTitle.textContent = "This image";
    setFacts(el.facts, []);
    el.flagChips.replaceChildren();
    el.flagChips.dataset.signature = "";
    return;
  }
  if (item.kind === "frame") {
    const f = item.frame, m = f.meta || {}, hdr = m.header || {};
    el.infoTitle.textContent = "This image";
    nodes.push(...fact("Date", f.date_iso.slice(0, 10)));
    nodes.push(...fact("Time (UTC)", f.date_iso.slice(11, 19)));
    nodes.push(...fact("Detector", `D${f.detector}`));
    if (f.wavelength != null) nodes.push(...fact("Wavelength", `${f.wavelength.toFixed(3)} µm`));
    nodes.push(...fact("Release", f.collection, "f-release"));
    nodes.push(...fact("Observation", f.obs_id, "f-observation"));
    if (hdr.XPOSURE != null) nodes.push(...fact("Exposure", `${hdr.XPOSURE.toFixed(1)} s`, "f-exposure"));
    if (hdr.L2DQAFLG) nodes.push(...fact("Quality", hdr.L2DQAFLG, "f-quality"));
    if (hdr.PSF_FWHM != null) nodes.push(...fact("PSF", `${hdr.PSF_FWHM.toFixed(2)}″`, "f-psf"));
    const glow = [["AURORA_CONT", "Aurora"], ["SHUTTLE_GLOW_CONT", "Shuttle glow"], ["HE_AIRGLOW_CONT", "Helium"],
      ["OBS_IN_SBAND", "S-band"]].filter(([k]) => hdr[k] === true).map(([, label]) => label);
    nodes.push(...fact("Glow", glow.length ? glow.join(", ") : "None", "f-glow"));
    if (hdr["L2 N_TRANSIENT"] != null) nodes.push(...fact("Cosmic-ray pixels", hdr["L2 N_TRANSIENT"].toLocaleString(), "f-cosmic"));
    if (hdr.NSNOWSRC != null) nodes.push(...fact("Snowballs", String(hdr.NSNOWSRC), "f-snowballs"));
    if (hdr["L2 SATSTRKS"] != null) nodes.push(...fact("Satellite streaks", String(hdr["L2 SATSTRKS"]), "f-streaks"));
    const bits = V.info?.flag_bits || {};
    const byName = Object.fromEntries(Object.values(bits).map((b) => [b.name, b]));
    const flags = m.target_flags || [];
    nodes.push(...fact("Flags at target", flags.length ? String(flags.length) : "None", "f-flags"));
    for (const name of flags) {
      const chip = document.createElement("span");
      chip.className = "flag-chip";
      chip.textContent = name;
      chip.title = byName[name]?.description || name;
      chips.push(chip);
    }
  } else {
    const members = item.members;
    el.infoTitle.textContent = item.kind === "diff" ? "This difference" : "This stack";
    if (item.epoch) {
      nodes.push(...fact("Visit", `${item.epoch.index + 1} of ${V.epochs.length}`, "f-visit"));
      nodes.push(...fact("Dates", visitRange(item.epoch)));
    }
    nodes.push(...fact("Images", String(members.length)));
    if (item.kind === "diff") nodes.push(...fact("Subtracted", String(item.others.length), "f-subtracted"));
    const dets = [...new Set(members.map((f) => f.detector))].sort();
    nodes.push(...fact("Detectors", dets.map((d) => `D${d}`).join(", ")));
    const waves = members.map((f) => f.wavelength).filter((x) => x != null);
    if (waves.length) nodes.push(...fact("Wavelengths", `${Math.min(...waves).toFixed(2)}–${Math.max(...waves).toFixed(2)} µm`));
    const flagged = members.filter((f) => (f.meta?.target_flags || []).some((n) => !["SOURCE", "FULLSAMPLE"].includes(n))).length;
    nodes.push(...fact("Flagged at target", `${flagged} of ${members.length}`, "f-flagged"));
  }
  setFacts(el.facts, nodes);
  const chipSignature = chips.map((c) => c.textContent).join("|");
  if (el.flagChips.dataset.signature !== chipSignature) {
    el.flagChips.dataset.signature = chipSignature;
    el.flagChips.replaceChildren(...chips);
  }
}

const detButtons = [];

function buildDetectors() {
  for (let d = 0; d <= 6; d += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = d ? "det" : "det all";
    if (d) button.style.setProperty("--c", DETECTOR_COLORS[d - 1]);
    const strong = document.createElement("strong");
    strong.textContent = d ? `D${d}` : "All";
    const small = document.createElement("small");
    const count = document.createElement("span");
    count.className = "count num";
    button.append(strong, count, small);
    button.addEventListener("click", () => setDetector(d));
    detButtons.push({ button, small, count });
  }
  el.detectors.replaceChildren(...detButtons.map((b) => b.button));
}

function updateDetectors() {
  const total = [0, 0, 0, 0, 0, 0, 0], ready = [0, 0, 0, 0, 0, 0, 0];
  for (const f of V.frames) {
    total[0] += 1; total[f.detector] += 1;
    if (f.status === "ready") { ready[0] += 1; ready[f.detector] += 1; }
  }
  const stackDetector = V.mode === "detectors" ? currentItem()?.detector : null;
  detButtons.forEach(({ button, small, count }, d) => {
    const active = V.mode === "detectors" ? (d !== 0 && stackDetector === d) : V.detector === d;
    button.setAttribute("aria-pressed", String(active));
    button.disabled = d !== 0 && V.frames.length > 0 && total[d] === 0;
    const band = d ? bandOf(d) || "–" : "0.75–5.0 µm";
    if (small.textContent !== band) small.textContent = band;
    const text = total[d] ? `${ready[d]}/${total[d]}` : "";
    if (count.textContent !== text) count.textContent = text;
  });
}

function updateModes() {
  for (const button of el.modeList.querySelectorAll(".mode")) {
    const mode = button.dataset.mode;
    button.setAttribute("aria-checked", String(mode === V.mode));
    const needsTwo = mode === "difference" && V.epochs.length < 2 && V.frames.length > 0;
    button.disabled = needsTwo;
    button.title = needsTwo ? "Needs at least two visits" : "";
  }
}

function updateTransport() {
  const count = V.items.length;
  el.prev.disabled = el.next.disabled = el.play.disabled = count < 2;
  el.play.classList.toggle("paused", !V.playing);
  el.play.setAttribute("aria-label", V.playing ? "Pause" : "Play");
  el.frameCount.textContent = count ? `${V.position + 1} / ${count} ${MODE_NOUNS[V.mode]}` : `0 ${MODE_NOUNS[V.mode]}`;
}

function updateProgress() {
  const total = V.frames.length;
  const ready = V.frames.filter((f) => f.status === "ready").length;
  const failed = V.frames.filter((f) => f.status === "failed");
  const working = V.loading || V.searching;
  el.loadbar.style.width = total ? `${((ready + failed.length) / total) * 100}%` : "0";
  el.loadbar.classList.toggle("done", !working);
  el.retryFailed.hidden = failed.length === 0 || working;
  el.failures.hidden = failed.length === 0;
  if (failed.length) {
    el.failures.querySelector("summary").textContent = `Failed images (${failed.length})`;
    el.failures.querySelector("ul").replaceChildren(...failed.slice(0, 200).map((f) => {
      const li = document.createElement("li");
      li.textContent = `${f.date_iso.slice(0, 16).replace("T", " ")} D${f.detector}: ${f.error}`;
      return li;
    }));
  }
  const nodes = [];
  if (V.searching) nodes.push(...fact("Status", "Searching"));
  if (V.center && total) {
    nodes.push(...fact("Loaded", `${ready} of ${total}`));
    if (failed.length) nodes.push(...fact("Failed", String(failed.length)));
    nodes.push(...fact("Visits", String(V.epochs.length)));
    nodes.push(...fact("First", V.frames[0].date_iso.slice(0, 10)));
    nodes.push(...fact("Last", V.frames[total - 1].date_iso.slice(0, 10)));
    nodes.push(...fact("Field", `${V.query.fov}°, ${V.grid} px`));
    nodes.push(...fact("Releases", V.collections.join(", ")));
  }
  setFacts(el.dataFacts, nodes);
}

function updateMessage() {
  if (V.searching || V.frames.length === 0) return;
  if (V.items.length > 0) { el.message.classList.add("hidden"); return; }
  const wanted = V.frames.filter(matches);
  if (V.mode === "difference" && V.epochs.length < 2) {
    showMessage("Only one visit: no difference to show.");
  } else if (wanted.some((f) => f.status === "pending") || V.loading) {
    showMessage(`Loading images${V.detector ? ` for D${V.detector}` : ""}…`);
  } else {
    showMessage(`None of the images${V.detector ? ` for D${V.detector}` : ""} could be loaded. Use “Retry failed”.`, true);
  }
}

function showMessage(text, isError = false) {
  el.message.textContent = text;
  el.message.classList.toggle("error", isError);
  el.message.classList.remove("hidden");
}

function updateReadouts() {
  el.fpsValue.textContent = `${V.fps} per second`;
  el.loValue.textContent = `${Number(el.lo.value)} %`;
  el.hiValue.textContent = `${Number(el.hi.value)} %`;
  el.asinhValue.textContent = Number(el.asinh.value) === 0 ? "linear" : `asinh ${el.asinh.value}`;
}

function syncControls() {
  for (const button of el.fovSeg.querySelectorAll("button")) {
    button.setAttribute("aria-checked", String(Number(button.dataset.fov) === V.query?.fov));
  }
  updateModes();
  updateReadouts();
}

function refreshAll() {
  rebuildItems();
  updateModes();
  updateDetectors();
  updateTransport();
  updateProgress();
  updateMessage();
  updateInfo();
  V.dirty = V.timelineDirty = V.spectrumDirty = true;
}

let refreshPending = false;
function scheduleRefresh() {
  if (refreshPending) return;
  refreshPending = true;
  requestAnimationFrame(() => { refreshPending = false; refreshAll(); });
}

/* =========================================================== interaction */

function setMode(mode) {
  if (mode === V.mode) return;
  V.mode = mode;
  refreshAll();
  V.onChange();
}

function setDetector(d) {
  if (V.mode === "detectors") {
    // In detector-stack mode the buttons jump to that detector's stack.
    const index = V.items.findIndex((it) => it.detector === d);
    if (index >= 0) { V.position = index; V.playing = false; refreshAll(); }
    return;
  }
  if (d === V.detector) return;
  V.detector = d;
  refreshAll();
  if (V.loading) startStream();   // re-prioritise what is still loading
  V.onChange();
}

function setFov(fov) {
  if (!V.query || fov === V.query.fov) return;
  V.query.fov = fov;
  syncControls();
  load();
  V.onChange();
}

function resetView() {
  V.zoom = 1;
  V.panX = V.panY = 0;
  el.zoomValue.textContent = "1×";
  V.dirty = true;
}

function zoomBy(factor, cx = el.canvas.width / 2, cy = el.canvas.height / 2) {
  const zoom = clamp(V.zoom * factor, 1, MAX_ZOOM);
  const ratio = zoom / V.zoom;
  V.panX = cx - (cx - V.panX) * ratio;
  V.panY = cy - (cy - V.panY) * ratio;
  V.zoom = zoom;
  clampPan();
  el.zoomValue.textContent = `${V.zoom}×`;
  el.zoomOut.disabled = V.zoom <= 1;
  el.zoomIn.disabled = V.zoom >= MAX_ZOOM;
  V.dirty = true;
}

function clampPan() {
  const size = el.canvas.width;
  const min = size - size * V.zoom;
  V.panX = clamp(V.panX, min, 0);
  V.panY = clamp(V.panY, min, 0);
}

function canvasPoint(event) {
  const rect = el.canvas.getBoundingClientRect();
  const scale = el.canvas.width / rect.width;
  return [(event.clientX - rect.left) * scale, (event.clientY - rect.top) * scale];
}

function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  const fit = (canvas, w, h) => {
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; return true; }
    return false;
  };
  const size = el.stage.clientWidth;
  if (size && fit(el.canvas, size, size)) { V.panX = V.panY = 0; V.zoom = 1; el.zoomValue.textContent = "1×"; }
  if (el.timeline.clientWidth) fit(el.timeline, el.timeline.clientWidth, 52);
  if (el.spectrum.clientWidth) fit(el.spectrum, el.spectrum.clientWidth, 220);
  V.dirty = V.timelineDirty = V.spectrumDirty = true;
}

function tick(now) {
  if (V.open) {
    if (V.playing && V.items.length > 1 && now - V.lastAdvance >= 1000 / V.fps) {
      V.lastAdvance = now;
      step(1);
    }
    if (V.dirty) { V.dirty = false; draw(); }
    if (V.timelineDirty) { V.timelineDirty = false; drawTimeline(); }
    if (V.spectrumDirty) { V.spectrumDirty = false; drawSpectrum(); }
  }
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------- events */

el.back.addEventListener("click", closeViewer);
for (const button of el.modeList.querySelectorAll(".mode")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}
el.play.addEventListener("click", () => { V.playing = !V.playing; updateTransport(); });
el.prev.addEventListener("click", () => { V.playing = false; step(-1); });
el.next.addEventListener("click", () => { V.playing = false; step(1); });
el.fps.addEventListener("input", () => { V.fps = Number(el.fps.value); updateReadouts(); });
for (const input of [el.lo, el.hi, el.asinh, el.lock]) {
  input.addEventListener("input", () => { updateReadouts(); V.lockedRange = null; V.dirty = true; });
}
for (const input of [el.ovCrosshair, el.ovFlags, el.ovAperture]) input.addEventListener("change", () => { V.dirty = true; });
el.ovGaia.addEventListener("change", () => { if (el.ovGaia.checked) loadCatalog("gaia"); V.dirty = true; });
el.ovAllwise.addEventListener("change", () => { if (el.ovAllwise.checked) loadCatalog("allwise"); V.dirty = true; });
for (const button of el.renderSeg.querySelectorAll("button")) {
  button.addEventListener("click", () => {
    V.smooth = button.dataset.render === "smooth";
    for (const b of el.renderSeg.querySelectorAll("button")) b.setAttribute("aria-checked", String(b === button));
    V.dirty = true;
  });
}
el.resetDisplay.addEventListener("click", () => {
  el.lo.value = DEFAULTS.lo; el.hi.value = DEFAULTS.hi; el.asinh.value = DEFAULTS.asinh;
  el.lock.checked = false;
  updateReadouts();
  V.lockedRange = null;
  V.dirty = true;
});
el.retryFailed.addEventListener("click", retryFailed);
el.zoomIn.addEventListener("click", () => zoomBy(2));
el.zoomOut.addEventListener("click", () => zoomBy(0.5));
el.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 2 : 0.5, ...canvasPoint(event));
}, { passive: false });
el.canvas.addEventListener("dblclick", () => { resetView(); el.zoomOut.disabled = true; });

// Drag pans (when zoomed in); a click without dragging moves the spectrum aperture.
let drag = null;
el.canvas.addEventListener("pointerdown", (event) => {
  const [x, y] = canvasPoint(event);
  drag = { x, y, panX: V.panX, panY: V.panY, moved: false };
  el.canvas.setPointerCapture(event.pointerId);
});
el.canvas.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const [x, y] = canvasPoint(event);
  if (Math.hypot(x - drag.x, y - drag.y) > 4) drag.moved = true;
  if (drag.moved && V.zoom > 1) {
    el.canvas.classList.add("dragging");
    V.panX = drag.panX + (x - drag.x);
    V.panY = drag.panY + (y - drag.y);
    clampPan();
    V.dirty = true;
  }
});
el.canvas.addEventListener("pointerup", (event) => {
  if (drag && !drag.moved && V.aperture) {
    const [x, y] = canvasPoint(event);
    const cell = (el.canvas.width * V.zoom) / V.grid;
    V.aperture = {
      x: clamp((x - V.panX) / cell - 0.5, 0, V.grid - 1),
      y: clamp((y - V.panY) / cell - 0.5, 0, V.grid - 1),
    };
    el.ovAperture.checked = true;
    V.dirty = V.spectrumDirty = true;
  }
  drag = null;
  el.canvas.classList.remove("dragging");
});
el.canvas.addEventListener("pointercancel", () => { drag = null; el.canvas.classList.remove("dragging"); });

let scrubbing = false;
el.timeline.addEventListener("pointerdown", (event) => {
  scrubbing = true;
  el.timeline.setPointerCapture(event.pointerId);
  seekTimeline(event);
});
el.timeline.addEventListener("pointermove", (event) => { if (scrubbing) seekTimeline(event); });
for (const type of ["pointerup", "pointercancel"]) el.timeline.addEventListener(type, () => { scrubbing = false; });

el.spectrum.addEventListener("pointermove", (event) => {
  const p = spectrumPointAt(event);
  el.spectrum.style.cursor = p ? "pointer" : "crosshair";
  setParts(el.specReadout, p ? describePoint(p) : []);
});
el.spectrum.addEventListener("click", (event) => {
  const p = spectrumPointAt(event);
  if (!p) return;
  if (V.mode !== "frames") V.mode = "frames";
  if (!matches(p.f)) V.detector = 0;
  rebuildItems();
  const index = V.items.findIndex((it) => it.frame === p.f);
  if (index >= 0) V.position = index;
  V.playing = false;
  refreshAll();
  V.onChange();
});
el.specCsv.addEventListener("click", downloadSpectrum);

/* ---------------------------------------------------------------- share */

export function shareUrls() {
  const params = new URLSearchParams(viewParams() || {});
  const base = `${location.origin}${location.pathname}`;
  return { link: `${base}?${params}`, embed: `${base}?${params}&embed=1` };
}

el.share.addEventListener("click", () => {
  const { link, embed } = shareUrls();
  el.shareLink.value = link;
  el.shareEmbed.value = `<iframe src="${embed}" width="1100" height="720" style="border:0" title="SPHEREx Blink" allowfullscreen></iframe>`;
  el.shareDialog.showModal();
});
el.shareClose.addEventListener("click", () => el.shareDialog.close());
for (const button of el.shareDialog.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const field = $(button.dataset.copy);
    field.select();
    try { await navigator.clipboard.writeText(field.value); button.textContent = "Copied"; }
    catch (_) { document.execCommand?.("copy"); button.textContent = "Copied"; }
    setTimeout(() => { button.textContent = "Copy"; }, 1500);
  });
}

document.addEventListener("keydown", (event) => {
  if (!V.open || el.shareDialog.open) return;
  if (event.target.closest("input, select, textarea")) return;
  if (event.key === "Escape" && !V.embed) { closeViewer(); return; }
  if (event.key === " ") {
    if (event.target.closest("button")) return;
    event.preventDefault();
    V.playing = !V.playing;
    updateTransport();
  } else if (event.key === "ArrowLeft") { V.playing = false; step(-1); }
  else if (event.key === "ArrowRight") { V.playing = false; step(1); }
});
