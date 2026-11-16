/* Entry point: wires the sky, the blink viewer, the tour and the page URL.
 *
 * URL parameters (for links and embedding):
 *   ?ra=<ra>&dec=<dec>     open the blink viewer on this field (any format the
 *                          search accepts: degrees or sexagesimal)
 *   &fov=0.05|0.1|0.2|0.3  field of view in degrees
 *   &name=<text>           title to show
 *   &mode=frames|epochs|difference|detectors
 *   &det=1..6              detector filter
 *   &embed=1               the viewer alone, for an <iframe> on another site
 */
import { $, toast } from "./util.js";
import { closeCard, initSky, loadTargets, markActive, showFootprint, sky } from "./sky.js";
import { V, closeViewer, initViewer, openViewer, shareUrls, viewParams } from "./viewer.js";
import { closeIntro, initTour, tourState } from "./tour.js";
import { initHelp } from "./help.js";

initHelp();   // before anything awaits, so the help icons work at once

const embed = new URLSearchParams(location.search).get("embed") === "1";
let historyPushed = false;   // did opening the viewer add a history entry?
let pushNext = false;        // the next URL update opens the viewer from the sky: add an entry
let silentUrl = false;       // opening from a link or Back/Forward: never add an entry

function queryFromUrl() {
  const p = new URLSearchParams(location.search);
  const ra = p.get("ra"), dec = p.get("dec");
  if (!ra || !dec) return null;
  return { ra, dec, name: p.get("name"), fov: p.get("fov"), mode: p.get("mode"), detector: p.get("det") };
}

/** Open the blink viewer for a field (from the sky, the coordinate box, the tour or the URL). */
function openBlink(q) {
  const ra = Number(q.ra), dec = Number(q.dec);
  closeCard();
  if (q.name) markActive(q.name);
  if (Number.isFinite(ra) && Number.isFinite(dec)) showFootprint(ra, dec, Number(q.fov) || sky.defaultFov);
  sky.paused = true;
  // One history entry per visit to the viewer, so the browser's Back button
  // returns to the sky; later changes of view only update the address.
  pushNext = !silentUrl && !embed && !V.open;
  openViewer(q);
  pushNext = false;
}

/** Keep the address bar in step with the viewer, so every view can be linked. */
function syncUrl() {
  if (!V.open) return;
  const params = new URLSearchParams(viewParams());
  if (embed) params.set("embed", "1");
  const url = `${location.pathname}?${params}`;
  if (pushNext && !historyPushed) {
    history.pushState({ viewer: true }, "", url);
    historyPushed = true;
  } else {
    history.replaceState(history.state, "", url);
  }
  if (embed) $("v-full").href = shareUrls().link;
}

function onViewerClosed() {
  sky.paused = false;
  if (historyPushed) {
    historyPushed = false;
    history.back();
  } else {
    history.replaceState(null, "", location.pathname);
  }
}

window.addEventListener("popstate", () => {
  const q = queryFromUrl();
  if (q && !V.open) {
    silentUrl = true;
    openBlink(q);
    silentUrl = false;
  } else if (!q && V.open) {
    historyPushed = false;
    closeViewer();
  }
});

$("goto").addEventListener("submit", (event) => {
  event.preventDefault();
  const ra = $("ra").value.trim(), dec = $("dec").value.trim();
  if (!ra || !dec) return;
  const raDeg = Number(ra), decDeg = Number(dec);
  const match = sky.targets.find((t) => Math.abs(t.ra - raDeg) < 1e-5 && Math.abs(t.dec - decDeg) < 1e-5);
  openBlink({ ra, dec, name: match ? match.name : null });
});

async function start() {
  let info = null;
  try { info = await (await fetch("api/info")).json(); } catch (_) { /* defaults */ }
  initViewer(info);
  V.embed = embed;
  V.onChange = syncUrl;
  V.onClose = onViewerClosed;
  sky.defaultFov = info?.default_fov ?? 0.1;
  sky.onBlink = ({ ra, dec, name }) => {
    $("ra").value = ra.toFixed(6);
    $("dec").value = dec.toFixed(6);
    openBlink({ ra: ra.toFixed(6), dec: dec.toFixed(6), name });
  };
  initTour({ openBlink });

  if (embed) {
    document.body.classList.add("embed");
    $("v-full").hidden = false;
  } else {
    loadTargets();
    initSky().catch((error) => {
      $("sky-loading").textContent = "The sky map needs WebGL 2. You can still blink positions typed above.";
      console.error(error);
    });
  }

  const q = queryFromUrl();
  if (q) {
    closeIntro();           // a shared link goes straight to the view
    silentUrl = true;
    openBlink(q);
    silentUrl = false;
  } else if (embed) {
    toast("Add ?ra=…&dec=… to the address to choose a field.");
  } else {
    $("intro-tour").focus({ preventScroll: true });
  }
}

start();

// Exposed for automated checks.
window.__spherex = { sky, V, tour: tourState };
