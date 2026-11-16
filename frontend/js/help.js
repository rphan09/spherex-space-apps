/* Help icons.  Any element with data-help="<key>" becomes a small "?" button
 * that opens a short explanation of the feature next to it.  One shared
 * popover serves every icon; it opens on click or tap (and on hover with a
 * mouse), closes on Escape, a click elsewhere, or a second click.
 */
import { $, clamp } from "./util.js";

/** Each entry: title, an optional lead paragraph, and optional [term, explanation] rows. */
export const HELP = {
  /* ----------------------------------------------------------------- sky */
  coords: {
    title: "Coordinates",
    text: "Right ascension (RA) and declination (Dec) are the sky's longitude and latitude. Type both, then press Blink to open every SPHEREx image of that spot.",
    rows: [
      ["Decimal degrees", "RA 133.761, Dec −7.242"],
      ["Hours and degrees", "RA 08h55m10.8s, Dec −07d14m42s"],
    ],
  },
  targets: {
    title: "Targets",
    text: "Ready-made places to start. Click one to fly there and read what it is.",
    rows: [
      ["test", "One of the challenge's five test targets."],
      ["Fast movers", "Nearby stars and brown dwarfs that shift visibly between visits."],
      ["Variable stars", "Stars whose brightness changes from visit to visit."],
      ["Deep fields", "Spots near the ecliptic poles that SPHEREx sees on almost every orbit, so they have the most images."],
    ],
  },
  layer: {
    title: "Sky layer",
    text: "What the background map shows. It only changes the sky you fly around, not the blink viewer.",
    rows: [
      ["Colour", "Three infrared wavelengths mapped to blue (1.25 µm), green (2.19 µm) and red (3.29 µm). Starlight looks blue-white; warm dust glows red."],
      ["One wavelength", "Any single one of SPHEREx's channels. Drag the slider: its six coloured sections are the six detectors, short to long wavelength."],
    ],
  },

  /* -------------------------------------------------------------- viewer */
  fov: {
    title: "Field of view",
    text: "How much sky each image covers, in degrees (0.1° is about a fifth of the full Moon's width).",
    rows: [
      ["Smaller", "Faster to load and easier to see detail."],
      ["Larger", "Keeps fast-moving objects in the frame for longer, but every image is bigger to download."],
    ],
  },
  share: {
    title: "Share or embed",
    text: "The position, field of view, view and detector are all saved in the page address. Copy the link to send someone straight to this view, or copy the embed code to put the viewer in another website.",
  },
  mode: {
    title: "Ways to look",
    text: "Four ways to play the same images. All of them line up north-up so the stars stay still.",
    rows: [
      ["Every image", "Each exposure on its own, oldest to newest. Noisiest, but shows every moment."],
      ["Visit stacks", "SPHEREx sees each patch of sky in visits about six months apart. This adds up each visit's images to cut the noise."],
      ["Differences", "Each visit minus all the others. Amber is brighter in this visit, blue is brighter in the others: a moving star shows as an amber and blue pair, a variable star as one colour."],
      ["Detector stacks", "Everything each detector saw, added together. The deepest, cleanest picture in each wavelength range."],
    ],
  },
  detectors: {
    title: "Detectors",
    text: "SPHEREx splits light across six detectors, D1 to D6, each covering its own range of infrared wavelengths. A star can look very different from one detector to the next, so blinking one detector at a time gives a fairer comparison.",
    rows: [
      ["Range", "The wavelengths that detector covers, in micrometres (µm)."],
      ["Count", "Images loaded so far, out of all images found."],
      ["Choosing one", "Filters the view to that detector and loads its images first."],
    ],
  },
  overlays: {
    title: "Overlays",
    text: "Marks drawn on top of the image. They never change the data.",
    rows: [
      ["Crosshair", "The position you asked for, at the centre of the field."],
      ["Gaia DR3", "Stars from ESA's Gaia catalogue, moved to each image's date using their measured motion. A star that moves with its circle is a real nearby mover."],
      ["AllWISE", "Sources seen by NASA's WISE telescope around 2010. Anything far from its square has moved since then."],
      ["Quality flags", "Shades pixels SPHEREx marked as unreliable: cosmic rays, bad pixels, ghosts, satellite streaks and more. Shown for single images."],
      ["Aperture", "Where the spectrum is measured. The solid circle collects the light; the dashed ring measures the background to subtract."],
    ],
  },
  playback: {
    title: "Playback and the image",
    rows: [
      ["Play / pause", "Space bar, or the middle button."],
      ["Step", "The buttons either side of play, or the left and right arrow keys."],
      ["Speed", "Images per second."],
      ["Zoom", "Scroll on the image or use + and −. Drag to pan; double-click to reset."],
      ["Click the image", "Moves the spectrum aperture to that spot, so you can measure any star."],
    ],
  },
  timeline: {
    title: "Timeline",
    text: "Every image found, placed by date. Click or drag to jump.",
    rows: [
      ["Tall coloured ticks", "Loaded images in the current view, coloured by detector."],
      ["Short grey ticks", "Images still loading, or outside the current detector filter."],
      ["Red ticks", "Images that failed to load."],
      ["Shaded band", "The visit the current stack or difference comes from."],
    ],
  },
  info: {
    title: "This image",
    text: "Facts about the image on screen, from its file header. Use the ? next to a row for what it means. Problems here can explain odd spots or streaks in the picture.",
  },
  spectrum: {
    title: "Spectrum",
    text: "Each SPHEREx image sees one narrow wavelength, so together they show how bright the object is across the infrared. Different molecules (water, carbon dioxide, methane) leave dips at their own wavelengths.",
    rows: [
      ["mJy", "Millijanskys, the unit of brightness astronomers use for flux density."],
      ["Dot colour", "The detector that took the measurement."],
      ["Hollow dot", "A quality flag touches the aperture in that image; treat it with care."],
      ["Click a dot", "Shows the image it came from."],
      ["Download CSV", "Saves every point as a spreadsheet file."],
    ],
  },
  display: {
    title: "Display",
    text: "How pixel values become shades of grey. None of this changes the data or the spectrum.",
    rows: [
      ["Smooth / Pixels", "Blend between pixels, or show each 6″ SPHEREx pixel as a square."],
      ["Black point", "Pixels fainter than this percentage of the image are drawn black. Raise it to hide background noise."],
      ["White point", "Pixels brighter than this percentage are drawn white. Lower it to bring out faint things."],
      ["Stretch", "Linear treats all brightness levels alike; asinh lifts faint detail without blowing out bright stars."],
      ["Same range", "Uses one brightness scale for every image, so real brightness changes are not hidden by auto-scaling."],
    ],
  },
  data: {
    title: "Data",
    text: "Download progress and where the images come from.",
    rows: [
      ["Loaded", "Images ready to show, out of all images found."],
      ["Visits", "Separate passes over this spot, about six months apart."],
      ["Releases", "The SPHEREx data releases searched. New releases are picked up automatically."],
      ["Retry failed", "The archive is sometimes busy; this asks again for any image that did not load."],
    ],
  },

  /* ------------------------------------------- rows of "This image" */
  "f-release": { title: "Release", text: "The SPHEREx data release this image comes from. Later releases reprocess the same images with improved calibration." },
  "f-observation": { title: "Observation", text: "SPHEREx's own name for this exposure: the week it was taken, the observation sequence and the detector." },
  "f-exposure": { title: "Exposure", text: "How long the detector collected light for this image, in seconds. Longer exposures see fainter objects." },
  "f-quality": { title: "Quality", text: "The SPHEREx pipeline's overall check of this image (L2 data-quality assessment). Anything other than Pass means the image may have problems." },
  "f-psf": { title: "PSF", text: "Point spread function: how wide a single star looks in this image, in arcseconds (″). Smaller is sharper." },
  "f-glow": { title: "Glow", text: "Light from near the spacecraft that can add a faint haze: aurora, shuttle glow (gas around the spacecraft), helium airglow, or interference while the radio was transmitting (S-band)." },
  "f-cosmic": { title: "Cosmic-ray pixels", text: "Pixels hit by energetic particles during the exposure. The pipeline removes them, but heavy hits leave small gaps." },
  "f-snowballs": { title: "Snowballs", text: "Large, round particle hits that light up a blob of pixels. Easy to mistake for a new object that appears in just one image." },
  "f-streaks": { title: "Satellite streaks", text: "Lines left by satellites crossing the field. A streak through your target can make it look brighter for one image." },
  "f-flags": { title: "Flags at target", text: "Quality flags set on the pixel at the centre of the field. SOURCE only means a known star sits there; anything else is a warning." },
  "f-visit": { title: "Visit", text: "Which pass over this spot the stack comes from. SPHEREx returns to each part of the sky about every six months." },
  "f-subtracted": { title: "Subtracted", text: "How many images from the other visits were averaged and taken away from this visit." },
  "f-flagged": { title: "Flagged at target", text: "How many images in the stack have a warning flag on the centre pixel. A few is normal." },
};

const pop = document.createElement("div");
pop.id = "hint-pop";
pop.className = "hint-pop";
pop.setAttribute("role", "tooltip");
pop.hidden = true;
document.body.append(pop);

let anchor = null;          // the hint button the popover belongs to
let pinned = false;         // opened by click/tap (stays until dismissed) rather than hover
let hoverTimer = 0;
const HOVER = window.matchMedia("(hover: hover) and (pointer: fine)");

function fill(entry) {
  const nodes = [];
  const title = document.createElement("strong");
  title.className = "hint-title";
  title.textContent = entry.title;
  nodes.push(title);
  if (entry.text) {
    const p = document.createElement("p");
    p.textContent = entry.text;
    nodes.push(p);
  }
  if (entry.rows?.length) {
    const dl = document.createElement("dl");
    for (const [term, text] of entry.rows) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = text;
      dl.append(dt, dd);
    }
    nodes.push(dl);
  }
  pop.replaceChildren(...nodes);
}

function place() {
  if (!anchor) return;
  if (!anchor.isConnected || anchor.closest("[hidden]") || !anchor.offsetParent) { close(); return; }
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight, gap = 8, edge = 10;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  let y = r.bottom + gap;
  if (y + h > vh - edge && r.top - gap - h > edge) y = r.top - gap - h;   // flip above when there is no room below
  pop.style.left = `${clamp(x, edge, Math.max(edge, vw - w - edge))}px`;
  pop.style.top = `${clamp(y, edge, Math.max(edge, vh - h - edge))}px`;
}

function loop() {
  if (!anchor) return;
  place();
  requestAnimationFrame(loop);
}

function open(button, byClick) {
  const entry = HELP[button.dataset.help];
  if (!entry) return;
  if (anchor && anchor !== button) anchor.setAttribute("aria-expanded", "false");
  const wasOpen = Boolean(anchor);
  anchor = button;
  pinned = byClick;
  fill(entry);
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-describedby", pop.id);
  pop.hidden = false;
  pop.classList.remove("in"); void pop.offsetWidth; pop.classList.add("in");
  place();
  if (!wasOpen) requestAnimationFrame(loop);
}

export function close() {
  clearTimeout(hoverTimer);
  if (anchor) {
    anchor.setAttribute("aria-expanded", "false");
    anchor.removeAttribute("aria-describedby");
  }
  anchor = null;
  pinned = false;
  pop.hidden = true;
}

/** Turn an element into a help icon for `key` (or make a new one). */
export function decorate(button, key = button.dataset.help) {
  button.dataset.help = key;
  button.type = "button";
  button.classList.add("hint");
  button.setAttribute("aria-label", `What is ${HELP[key]?.title || "this"}?`);
  button.setAttribute("aria-expanded", "false");
  button.textContent = "?";
  return button;
}

export function hintButton(key) {
  return decorate(document.createElement("button"), key);
}

export function initHelp() {
  for (const node of document.querySelectorAll("[data-help]")) decorate(node);

  // Delegated, so hint buttons created later (the rows of "This image") work too.
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".hint");
    if (button) {
      event.preventDefault();          // inside a <label>: never toggle its control
      event.stopPropagation();
      if (anchor === button && pinned) close();
      else open(button, true);
      return;
    }
    if (anchor && !pop.contains(event.target)) close();
  }, true);

  document.addEventListener("pointerover", (event) => {
    if (!HOVER.matches || pinned) return;
    const button = event.target.closest?.(".hint");
    if (!button) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => open(button, false), 180);
  });
  document.addEventListener("pointerout", (event) => {
    if (!HOVER.matches || pinned) return;
    const button = event.target.closest?.(".hint");
    if (!button) return;
    clearTimeout(hoverTimer);
    if (anchor === button && !button.contains(event.relatedTarget)) hoverTimer = setTimeout(close, 120);
  });

  // Window capture runs before the tour's and the viewer's key handlers, so
  // Escape closes the popover first instead of the viewer.
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && anchor) {
      event.stopImmediatePropagation();
      event.preventDefault();
      const back = anchor;
      close();
      back.focus({ preventScroll: true });
    }
  }, true);
  window.addEventListener("resize", () => { if (anchor) place(); });
}
