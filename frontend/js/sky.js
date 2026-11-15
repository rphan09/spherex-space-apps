/* The sky: SPHEREx's all-sky map in Aladin Lite, target markers, the
   clicked-spot probe and prompt card, and the fly-to camera. */
import A from "../vendor/aladin-lite-3.8.2/aladin.js";
import {
  $, ACCENT, NARROW, REDUCED_MOTION, clamp, footprint, formatCoords, fromVec, rad, separation, toVec,
} from "./util.js";

const START_VIEW = { ra: 88, dec: 8, fov: 120 };
const MIN_SKY_FOV = 1;      // the map has 13" pixels: closer than ~1 degree it turns into blocks
const CARD_FOV = 3;
const DRIFT_DEG_PER_MS = 0.0009;

const el = {
  sky: $("sky"), skyWrap: $("sky-wrap"), markers: $("markers"), probe: $("probe"), loading: $("sky-loading"),
  card: $("card"), cardKicker: $("card-kicker"), cardTitle: $("card-title"), cardText: $("card-text"),
  cardCoords: $("card-coords"), cardBlink: $("card-blink"), cardClose: $("card-close"),
  targetsToggle: $("targets-toggle"), targetsList: $("targets-list"),
  spectrum: $("spectrum-slider"), wave: $("wave"), waveValue: $("wave-value"), layerNote: $("layer-note"),
  cursor: $("cursor"), fov: $("fov"),
};

export const sky = {
  aladin: null,
  ready: false,
  targets: [],
  categories: {},
  markerEls: new Map(),
  selected: null,       // { kind: "target" | "spot", ra, dec, target? }
  flight: null,
  drifting: !REDUCED_MOTION,
  footprint: null,
  frames: [],
  waveTimer: 0,
  paused: false,        // true while the full-screen viewer covers the sky
  onBlink: () => {},    // set by main.js: open the viewer for { ra, dec, name }
  defaultFov: 0.1,
};

const absolute = (path) => new URL(path, window.location.href).href;

export async function initSky() {
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
  setTimeout(() => el.loading.classList.add("done"), 1200);
  loadSkyFrames();
  requestAnimationFrame(skyTick);
}

/* --------------------------------------------------------------- layers */

async function loadSkyFrames() {
  try {
    const response = await fetch("api/sky");
    if (!response.ok) return;
    sky.frames = (await response.json()).frames;
    el.wave.max = String(sky.frames.length - 1);
    el.wave.value = String(Math.max(0, sky.frames.findIndex((f) => f.wavelength_um >= 2.18)));
    updateWaveLabel();
  } catch (_) { /* the colour layer still works */ }
}

function updateWaveLabel() {
  const frame = sky.frames[Number(el.wave.value)];
  el.waveValue.textContent = frame ? `${frame.wavelength_um.toFixed(3)} µm · D${frame.detector}` : "";
}

function setLayer(layer) {
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

/* -------------------------------------------------------------- targets */

export async function loadTargets() {
  try {
    const data = await (await fetch("presets.json")).json();
    sky.targets = data.targets;
    sky.categories = data.categories;
  } catch (_) {
    sky.targets = [];
  }
  buildTargetList();
  buildMarkers();
}

export const findTarget = (name) => sky.targets.find((t) => t.name === name);

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

export function markActive(name) {
  for (const [key, node] of sky.markerEls) node.classList.toggle("active", key === name);
  for (const item of el.targetsList.querySelectorAll(".target-item")) {
    item.classList.toggle("active", item.dataset.name === name);
  }
}

/* ------------------------------------------------------- prompt card */

/** Warm the server's search cache while the user reads the card. */
function prefetch(ra, dec) {
  const params = new URLSearchParams({ ra: ra.toFixed(6), dec: dec.toFixed(6), fov: String(sky.defaultFov) });
  fetch(`api/search?${params}`, { priority: "low" }).catch(() => {});
}

function showCard() {
  el.card.hidden = false;
  el.card.style.animation = "none"; void el.card.offsetWidth; el.card.style.animation = "";
}

export function selectTarget(target, { fly }) {
  sky.selected = { kind: "target", ra: target.ra, dec: target.dec, target };
  markActive(target.name);
  el.probe.hidden = true;
  const label = sky.categories[target.category] || "";
  el.cardKicker.textContent = target.test_target ? `${label} · challenge test target` : label;
  el.cardTitle.textContent = target.name;
  el.cardText.textContent = target.description || "";
  el.cardText.hidden = !target.description;
  el.cardCoords.textContent = formatCoords(target.ra, target.dec);
  el.cardBlink.textContent = "Open blink viewer";
  showCard();
  if (NARROW.matches) el.targetsToggle.setAttribute("aria-expanded", "false");
  prefetch(target.ra, target.dec);
  if (fly) flyTo(target.ra, target.dec, CARD_FOV);
}

export function selectSpot(ra, dec) {
  sky.selected = { kind: "spot", ra, dec };
  markActive(null);
  el.probe.hidden = false;
  el.probe.classList.remove("pulse"); void el.probe.offsetWidth; el.probe.classList.add("pulse");
  el.cardKicker.textContent = "Selected spot";
  el.cardTitle.textContent = formatCoords(ra, dec);
  el.cardText.textContent = "See every SPHEREx image of the field around this point, in date order.";
  el.cardText.hidden = false;
  el.cardCoords.textContent = `${ra.toFixed(5)}°  ${dec >= 0 ? "+" : ""}${dec.toFixed(5)}°`;
  el.cardBlink.textContent = "Open blink viewer";
  showCard();
  prefetch(ra, dec);
}

export function closeCard() {
  el.card.hidden = true;
  el.probe.hidden = true;
  markActive(null);
  sky.selected = null;
}

export const cardOpen = () => !el.card.hidden;

el.cardBlink.addEventListener("click", () => {
  const sel = sky.selected;
  if (!sel) return;
  sky.onBlink({ ra: sel.ra, dec: sel.dec, name: sel.kind === "target" ? sel.target.name : null });
});
el.cardClose.addEventListener("click", closeCard);
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

/** Outline of the last blinked field on the sky. */
export function showFootprint(ra, dec, size) {
  if (!sky.footprint) return;
  sky.footprint.removeAll();
  sky.footprint.add(A.polygon(footprint(ra, dec, size)));
}

/* ------------------------------------------------------------ camera */

export function stopDrift() { sky.drifting = false; }

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Fly the view to (ra, dec) at field of view `fov`, rising out and back in for long hops. */
export function flyTo(ra, dec, fov) {
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
  const lf0 = Math.log(fov0), lf1 = Math.log(fov);
  const peak = Math.min(170, Math.max(fov0, fov, distance * 1.25));
  sky.flight = {
    start: performance.now(),
    duration: 900 + 1500 * Math.min(1, distance / 90) + 350 * Math.min(1, Math.abs(lf1 - lf0) / 4),
    v0: toVec(ra0, dec0), v1: toVec(ra, dec), omega: rad(distance),
    lf0, lf1, rise: Math.max(0, Math.log(peak) - Math.max(lf0, lf1)),
  };
}

function stepFlight(now) {
  const f = sky.flight;
  const t = clamp((now - f.start) / f.duration, 0, 1);
  const e = ease(t);
  let vec = f.v1;
  if (f.omega > 1e-6) {
    const s = Math.sin(f.omega);
    const a = Math.sin((1 - e) * f.omega) / s, b = Math.sin(e * f.omega) / s;
    vec = [0, 1, 2].map((i) => a * f.v0[i] + b * f.v1[i]);
  }
  const [ra, dec] = fromVec(vec);
  sky.aladin.gotoRaDec(ra, dec);
  sky.aladin.setFoV(Math.exp(f.lf0 + (f.lf1 - f.lf0) * e + f.rise * Math.sin(Math.PI * e)));
  if (t >= 1) sky.flight = null;
}

/* ------------------------------------------- per-frame overlay placement */

function place(node, x, y) {
  node.style.setProperty("--x", `${x}px`);
  node.style.setProperty("--y", `${y}px`);
}

function worldToScreen(ra, dec) {
  let p = null;
  try { p = sky.aladin.world2pix(ra, dec); } catch (_) { return null; }
  return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : null;
}

let lastTick = 0;
function skyTick(now) {
  const aladin = sky.aladin;
  if (aladin && !sky.paused) {
    if (sky.flight) stepFlight(now);
    else if (sky.drifting && lastTick) {
      const [ra, dec] = aladin.getRaDec();
      aladin.gotoRaDec((ra + (now - lastTick) * DRIFT_DEG_PER_MS) % 360, dec);
    }

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
      let x = width - cw - 16, y = height - ch - 70;
      if (anchor) {
        x = anchor[0] + 26; y = anchor[1] - ch / 2;
        if (x + cw > width - 12) x = anchor[0] - 26 - cw;
      }
      place(el.card, clamp(x, 12, Math.max(12, width - cw - 12)), clamp(y, 64, Math.max(64, height - ch - 64)));
    }
    el.fov.textContent = fov >= 1 ? `Field ${fov.toFixed(1)}°` : `Field ${(fov * 60).toFixed(1)}′`;
  }
  lastTick = now;
  requestAnimationFrame(skyTick);
}
