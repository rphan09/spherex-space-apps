/* Start screen and guided tour. */
import { $, NARROW, REDUCED_MOTION, clamp, wait } from "./util.js";
import { findTarget, selectTarget, stopDrift } from "./sky.js";
import { V, closeViewer } from "./viewer.js";

const el = {
  root: $("intro"), tourBtn: $("intro-tour"), startBtn: $("intro-start"),
  spot: $("tour-spot"), tip: $("tour-tip"), count: $("tour-count"), title: $("tour-title"), text: $("tour-text"),
  back: $("tour-back"), next: $("tour-next"), skip: $("tour-skip"),
};

let openBlink = () => {};
const onSky = () => { if (V.open) closeViewer(); };
const openBarnard = async () => {
  const barnard = findTarget("Barnard's Star");
  if (!barnard) return;
  if (!V.open || V.query?.name !== barnard.name) {
    openBlink({ ra: barnard.ra.toFixed(6), dec: barnard.dec.toFixed(6), name: barnard.name });
    await wait(900);
  }
};

/** Tour steps.  `target` is a selector (null = the whole screen). */
const TOUR = [
  {
    target: null, before: onSky,
    title: "This is the sky",
    text: "SPHEREx's own map of the whole sky, built from its first year of observations. Drag to look around and scroll or pinch to zoom. The colours are infrared: blue and green are mostly starlight, red is warm dust.",
  },
  {
    target: "#targets", before: () => { onSky(); $("targets-toggle").setAttribute("aria-expanded", "true"); },
    title: "Targets",
    text: "Interesting places to start: the challenge's test targets (marked “test”), fast-moving stars, stars that change brightness, famous nebulae and galaxies, and SPHEREx's two deep fields. Click one to fly there.",
  },
  {
    target: "#card",
    title: "Click a target or any spot",
    text: "A short card says what you are looking at. “Open blink viewer” opens every SPHEREx image of that field in its own full-screen view. Clicking any patch of sky, even an empty-looking one, works the same way.",
    before: async () => {
      onSky();
      const orion = findTarget("Orion Nebula");
      if (orion) selectTarget(orion, { fly: true });
      await wait(REDUCED_MOTION ? 200 : 2600);
    },
  },
  {
    target: "#goto", before: onSky,
    title: "Go to coordinates",
    text: "Know where you want to look? Type a right ascension and declination, in decimal degrees or in hours and degrees (08h55m10.8s, −07d14m42s), and press Blink.",
  },
  {
    target: ".layer-switch", before: onSky,
    title: "Colour or one wavelength",
    text: "Colour combines three of SPHEREx's 102 wavelengths. Choose “One wavelength” and drag the slider to step through all of them; its six coloured sections are the six detectors.",
  },
  {
    target: "#stage", before: openBarnard,
    title: "The blink viewer",
    text: "Every SPHEREx image of the field, oldest to newest, lined up so the stars stay still. This is Barnard's Star: it moves about 10″ a year, almost two SPHEREx pixels between the 2025 and 2026 visits. Images appear as soon as they arrive.",
  },
  {
    target: "#sec-mode", before: openBarnard,
    title: "Four ways to look",
    text: "Every image; visit stacks, which add up each visit for less noise; differences, where each visit minus the others makes anything that moved light up in amber and blue; and detector stacks, the deepest view in each wavelength range.",
  },
  {
    target: "#sec-detectors", before: openBarnard,
    title: "Detectors",
    text: "SPHEREx has six detectors, each covering its own range of wavelengths. Stars look different at different wavelengths, so for a fair comparison blink one detector at a time. Choosing one also loads its images first.",
  },
  {
    target: "#timeline-wrap", before: openBarnard,
    title: "Timeline",
    text: "Each tick is one image, placed by date and coloured by detector. SPHEREx sees each part of the sky in visits about six months apart. Click or drag here to jump.",
  },
  {
    target: "#sec-overlays", before: openBarnard,
    title: "Overlays",
    text: "Mark Gaia stars, moved to each image's date with their measured motion, and AllWISE sources from 2010. “Quality flags” shades pixels SPHEREx marked as affected by cosmic rays, ghosts, persistence and more.",
  },
  {
    target: "#sec-spectrum", before: openBarnard,
    title: "Spectrum on the fly",
    text: "Each image sees this spot at one wavelength, so together they make a spectrum, built as images arrive. Click the image to measure a different star, click a point to see its image, or download it as CSV.",
  },
  {
    target: "#sec-info", before: openBarnard,
    title: "About this image",
    text: "Date, detector, exact wavelength, data release, quality check, glow contamination and the quality flags at the target. Problems are marked in red.",
  },
  {
    target: "#fov-seg", before: openBarnard,
    title: "Field of view",
    text: "Choose 0.05° to 0.3°. A larger field follows faster-moving objects, but every image is bigger to download.",
  },
  {
    target: "#v-share", before: openBarnard,
    title: "Share or embed",
    text: "The coordinates, field of view, view and detector live in the page address, so any link opens straight into this view. You can also copy code to embed the viewer in another website.",
  },
  {
    target: "#v-back", before: openBarnard,
    title: "That's the tour",
    text: "Go back to the sky to pick something else. Open the introduction again any time with the ? button. Now go and find something that moves.",
  },
];

const tour = { index: -1, busy: false };
export const tourActive = () => tour.index >= 0;

export function openIntro() {
  endTour();
  el.root.classList.remove("closed");
  el.root.removeAttribute("aria-hidden");
  el.tourBtn.focus({ preventScroll: true });
}

export function closeIntro() {
  el.root.classList.add("closed");
  el.root.setAttribute("aria-hidden", "true");
}

async function showStep(index) {
  if (index < 0 || index >= TOUR.length || tour.busy) return;
  tour.busy = true;
  tour.index = index;
  const step = TOUR[index];
  el.tip.hidden = false;
  el.spot.hidden = false;
  el.count.textContent = `Step ${index + 1} of ${TOUR.length}`;
  el.title.textContent = step.title;
  el.text.textContent = step.text;
  el.back.disabled = index === 0;
  el.next.textContent = index === TOUR.length - 1 ? "Finish" : "Next";
  try {
    if (step.before) await step.before();
    const node = step.target && document.querySelector(step.target);
    if (node) node.scrollIntoView({ block: "nearest", behavior: REDUCED_MOTION ? "auto" : "smooth" });
  } finally {
    tour.busy = false;
  }
  el.next.focus({ preventScroll: true });
}

function endTour() {
  tour.index = -1;
  el.tip.hidden = true;
  el.spot.hidden = true;
}

/** Keep the spotlight and the explanation card beside the step's element. */
function placeTour() {
  if (tour.index < 0) return;
  const step = TOUR[tour.index];
  const vw = window.innerWidth, vh = window.innerHeight;
  const node = step.target ? document.querySelector(step.target) : null;
  const rect = node && !node.closest("[hidden]") ? node.getBoundingClientRect() : null;
  const tipW = el.tip.offsetWidth, tipH = el.tip.offsetHeight, gap = 18;

  if (NARROW.matches) {
    const middle = rect && rect.width ? rect.top + rect.height / 2 : vh;
    el.tip.style.top = `${middle > vh / 2 ? 12 : vh - tipH - 12}px`;
  }
  if (!rect || rect.width === 0) {
    el.spot.classList.add("whole");
    Object.assign(el.spot.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: "0px", height: "0px" });
    if (!NARROW.matches) {
      el.tip.style.left = `${(vw - tipW) / 2}px`;
      el.tip.style.top = `${(vh - tipH) / 2}px`;
    }
    return;
  }
  el.spot.classList.remove("whole");
  const pad = 6;
  Object.assign(el.spot.style, {
    left: `${rect.left - pad}px`, top: `${rect.top - pad}px`,
    width: `${rect.width + 2 * pad}px`, height: `${rect.height + 2 * pad}px`,
  });
  if (NARROW.matches) return;
  let x, y;
  if (rect.right + gap + tipW < vw - 12) { x = rect.right + gap; y = rect.top; }
  else if (rect.left - gap - tipW > 12) { x = rect.left - gap - tipW; y = rect.top; }
  else if (rect.bottom + gap + tipH < vh - 12) { x = rect.left; y = rect.bottom + gap; }
  else { x = rect.left; y = rect.top - gap - tipH; }
  el.tip.style.left = `${clamp(x, 12, vw - tipW - 12)}px`;
  el.tip.style.top = `${clamp(y, 12, vh - tipH - 12)}px`;
}

function tick() {
  placeTour();
  requestAnimationFrame(tick);
}

export function initTour(options) {
  openBlink = options.openBlink;
  el.tourBtn.addEventListener("click", () => { closeIntro(); stopDrift(); showStep(0); });
  el.startBtn.addEventListener("click", closeIntro);
  for (const id of ["help", "v-help"]) $(id).addEventListener("click", openIntro);
  el.next.addEventListener("click", () => {
    if (tour.index >= TOUR.length - 1) endTour();
    else showStep(tour.index + 1);
  });
  el.back.addEventListener("click", () => showStep(tour.index - 1));
  el.skip.addEventListener("click", endTour);

  // Runs before everything else, so the start screen and the tour get keys first.
  document.addEventListener("keydown", (event) => {
    const introOpen = !el.root.classList.contains("closed");
    if (introOpen && event.key === "Escape") {
      event.stopImmediatePropagation();
      closeIntro();
    } else if (tour.index >= 0) {
      if (event.key === "Escape") { event.stopImmediatePropagation(); endTour(); }
      else if (event.key === "ArrowRight") { event.stopImmediatePropagation(); el.next.click(); }
      else if (event.key === "ArrowLeft") { event.stopImmediatePropagation(); showStep(tour.index - 1); }
    } else if (introOpen) {
      event.stopImmediatePropagation();
    }
  }, { capture: true });
  requestAnimationFrame(tick);
}

// Exposed for automated checks.
export const tourState = { tour, TOUR };
