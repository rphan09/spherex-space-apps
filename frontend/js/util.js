/* Shared helpers: DOM, maths, coordinates, formatting, binary decoding. */

export const $ = (id) => document.getElementById(id);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const ACCENT = "#f5b54a";
/** Detector colours D1-D6, short to long wavelength (same as the CSS --d1...--d6). */
export const DETECTOR_COLORS = ["#7f9cff", "#5fc9d9", "#8fd96b", "#e9cf55", "#f39a4a", "#ec6455"];
export const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export const NARROW = window.matchMedia("(max-width: 720px)");

/** Sexagesimal text for an angle in degrees: hours for RA, degrees for Dec. */
export function sexagesimal(value, hours) {
  const sign = value < 0 ? "−" : hours ? "" : "+";
  let v = Math.abs(hours ? value / 15 : value);
  const a = Math.floor(v); v = (v - a) * 60;
  const b = Math.floor(v); const c = (v - b) * 60;
  const s = c.toFixed(hours ? 2 : 1).padStart(hours ? 5 : 4, "0");
  return hours ? `${String(a).padStart(2, "0")}h${String(b).padStart(2, "0")}m${s}s`
               : `${sign}${String(a).padStart(2, "0")}°${String(b).padStart(2, "0")}′${s}″`;
}
export const formatCoords = (ra, dec) => `${sexagesimal(ra, true)}  ${sexagesimal(dec, false)}`;

export function toVec(ra, dec) {
  const r = rad(ra), d = rad(dec);
  return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)];
}
export function fromVec([x, y, z]) {
  const n = Math.hypot(x, y, z);
  return [(deg(Math.atan2(y, x)) + 360) % 360, deg(Math.asin(clamp(z / n, -1, 1)))];
}
export function separation(ra1, dec1, ra2, dec2) {
  const a = toVec(ra1, dec1), b = toVec(ra2, dec2);
  return deg(Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)));
}

/** Gnomonic (TAN) projection about (ra0, dec0): returns [xi, eta] in degrees, east and north positive. */
export function tanProject(ra, dec, ra0, dec0) {
  const d = rad(dec), d0 = rad(dec0), dra = rad(ra - ra0);
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(dra);
  const xi = (Math.cos(d) * Math.sin(dra)) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(dra)) / cosc;
  return [deg(xi), deg(eta)];
}

/** Corners of a north-up square of side `size` degrees centred on (ra, dec). */
export function footprint(ra, dec, size) {
  const h = Math.tan(rad(size / 2));
  const ra0 = rad(ra), dec0 = rad(dec);
  return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([xi, eta]) => {
    const den = Math.cos(dec0) - eta * Math.sin(dec0);
    const r = ra0 + Math.atan2(xi, den);
    const d = Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(xi, den));
    return [(deg(r) + 360) % 360, deg(d)];
  });
}

/** Decimal year of a Modified Julian Date. */
export const mjdToYear = (mjd) => 2000 + (mjd - 51544.5) / 365.25;

let toastTimer = 0;
export function toast(text) {
  const node = $("toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 6000);
}

export async function readError(response) {
  try {
    const body = await response.json();
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) return body.detail.map((d) => d.msg).join("; ");
  } catch (_) { /* not JSON */ }
  return `The server returned an error (${response.status}).`;
}

/** Lookup table: IEEE half-float bit pattern -> number. */
const F16 = (() => {
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h += 1) {
    const sign = h & 0x8000 ? -1 : 1, exp = (h >> 10) & 0x1f, frac = h & 0x3ff;
    if (exp === 0) table[h] = sign * 2 ** -14 * (frac / 1024);
    else if (exp === 31) table[h] = frac ? NaN : sign * Infinity;
    else table[h] = sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return table;
})();

/** Decode little-endian float16 bytes into a Float32Array. */
export function decodeFloat16(bytes) {
  const halves = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const out = new Float32Array(halves.length);
  for (let i = 0; i < halves.length; i += 1) out[i] = F16[halves[i]];
  return out;
}

/**
 * Read a stream of messages: uint32 header length, uint32 payload length
 * (little endian), JSON header, payload.  Calls onMessage(header, payload)
 * for each one as soon as it is complete.
 */
export async function readMessages(response, onMessage) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const merged = new Uint8Array(buffer.length + value.length);
    merged.set(buffer); merged.set(value, buffer.length);
    buffer = merged;
    let offset = 0;
    while (buffer.length - offset >= 8) {
      const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
      const headLen = view.getUint32(0, true), payloadLen = view.getUint32(4, true);
      if (buffer.length - offset < 8 + headLen + payloadLen) break;
      const header = JSON.parse(decoder.decode(buffer.subarray(offset + 8, offset + 8 + headLen)));
      const payload = buffer.slice(offset + 8 + headLen, offset + 8 + headLen + payloadLen);
      offset += 8 + headLen + payloadLen;
      onMessage(header, payload);
    }
    if (offset) buffer = buffer.slice(offset);
  }
}

/** Value at percentile p (0-100) of an ascending-sorted array. */
export function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return 0;
  return sorted[clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1)];
}

export function median(values) {
  const copy = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  return copy.length ? copy[Math.floor(copy.length / 2)] : NaN;
}

/** Ascending-sorted copy of the finite values (for robust display ranges). */
export function sortedFinite(data) {
  let n = 0;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) if (Number.isFinite(data[i])) out[n++] = data[i];
  return out.subarray(0, n).sort();
}
