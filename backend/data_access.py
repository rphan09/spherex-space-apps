"""Data access: coordinate parsing, IRSA SIA2 searches and cutout downloads.

Everything that talks to IRSA lives here.  Based on the IRSA SPHEREx tutorials
and archive documentation:

* Spectral images are discovered with the SIA2 service
  (``Irsa.query_sia(pos=(coord, radius), collection=...)``).
* A cutout is requested by appending ``?center=<ra>,<dec>deg&size=<deg>deg``
  to an image's ``access_url``.  Full 2040x2040 images are never downloaded.
* A cutout MEF holds IMAGE, FLAGS, VARIANCE, ZODI, EPSF and WCS-WAVE HDUs.
  The EPSF table is not cut down and makes up ~97% of the 4 MB response, so
  downloads are streamed and stopped at the first binary table.  The
  WCS-WAVE wavelength lookup table that follows it is a per-detector
  calibration product; it is fetched once per calibration and cached.
"""

from __future__ import annotations

import asyncio
import io
import logging
import random
import re
import threading
import time
from dataclasses import asdict, dataclass

import astropy.units as u
import httpx
import numpy as np
from astropy.coordinates import Angle, SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from scipy.interpolate import RegularGridInterpolator

from . import cache, config

logger = logging.getLogger("spherex.data")

FITS_BLOCK = 2880
_BINTABLE_CARD = b"XTENSION= 'BINTABLE'"
_RETRY_STATUS = {429, 500, 502, 503, 504}
_CALIB_RE = re.compile(r"\[CALIB\]\s+spectral_wcs\s+(\S+)")
_DETECTOR_RE = re.compile(r"D(\d)\s*$")


class CoordinateError(ValueError):
    """The user-supplied coordinates could not be understood."""


class ArchiveError(RuntimeError):
    """IRSA could not be queried, or a cutout could not be retrieved."""


# --------------------------------------------------------------------------
# Coordinates
# --------------------------------------------------------------------------

def _is_number(text: str) -> bool:
    try:
        float(text)
    except ValueError:
        return False
    return True


def parse_coordinates(ra: str, dec: str) -> SkyCoord:
    """Parse user-supplied RA and Dec into an ICRS ``SkyCoord``.

    Accepted forms:

    * decimal degrees for both: ``"133.795129"``, ``"-7.245147"``
    * sexagesimal: ``"08h55m10.831s"`` / ``"-07d14m42.53s"`` or
      ``"08:55:10.831"`` / ``"-07:14:42.53"`` (RA in hours, Dec in degrees)

    The result is rounded to 6 decimal places of a degree so that the same
    position always maps to the same cache key and output grid.

    Raises:
        CoordinateError: with a message suitable for showing to the user.
    """
    ra_text, dec_text = (ra or "").strip(), (dec or "").strip()
    if not ra_text or not dec_text:
        raise CoordinateError("Both RA and Dec are required.")

    try:
        ra_unit = u.deg if _is_number(ra_text) else u.hourangle
        ra_angle = Angle(ra_text, unit=ra_unit)
    except Exception:
        raise CoordinateError(
            f"Could not read RA '{ra_text}'. Use decimal degrees (133.7951) "
            "or hours (08h55m10.8s or 08:55:10.8)."
        ) from None
    try:
        dec_angle = Angle(dec_text, unit=u.deg)
    except Exception:
        raise CoordinateError(
            f"Could not read Dec '{dec_text}'. Use decimal degrees (-7.2451) "
            "or degrees, arcminutes, arcseconds (-07d14m42.5s or -07:14:42.5)."
        ) from None

    ra_deg, dec_deg = float(ra_angle.deg), float(dec_angle.deg)
    if not np.isfinite(ra_deg) or not np.isfinite(dec_deg):
        raise CoordinateError("RA and Dec must be finite numbers.")
    if not 0.0 <= ra_deg <= 360.0:
        raise CoordinateError(f"RA {ra_text} is out of range (0 to 360 degrees, or 0h to 24h).")
    if not -90.0 <= dec_deg <= 90.0:
        raise CoordinateError(f"Dec {dec_text} is out of range (-90 to +90 degrees).")

    return SkyCoord(ra=round(ra_deg % 360.0, 6) * u.deg, dec=round(dec_deg, 6) * u.deg, frame="icrs")


# --------------------------------------------------------------------------
# SIA2 search
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class ImageRecord:
    """One SPHEREx spectral image that overlaps the requested position."""

    id: str
    collection: str
    obs_id: str
    detector: int
    mjd: float
    date_iso: str
    #: Wavelength range of the whole detector, from SIA metadata (microns).
    #: The exact wavelength at the target is returned with each frame.
    wavelength_min_um: float | None
    wavelength_max_um: float | None
    exposure_s: float | None
    access_url: str


def _optional_float(value) -> float | None:
    """Convert a table cell to ``float``; masked or non-finite cells become ``None``."""
    if value is None or np.ma.is_masked(value):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def _record_from_row(row) -> ImageRecord | None:
    """Build an ``ImageRecord`` from one SIA result row (``None`` if unusable)."""
    band = str(row["energy_bandpassname"])
    match = _DETECTOR_RE.search(band)
    t_min, t_max = _optional_float(row["t_min"]), _optional_float(row["t_max"])
    url = str(row["access_url"])
    if match is None or t_min is None or not url.startswith("http"):
        return None
    detector = int(match.group(1))
    mjd = t_min if t_max is None else 0.5 * (t_min + t_max)
    obs_id = str(row["obs_id"])
    em_min, em_max = _optional_float(row["em_min"]), _optional_float(row["em_max"])
    return ImageRecord(
        id=f"{obs_id}D{detector}",
        collection=str(row["obs_collection"]),
        obs_id=obs_id,
        detector=detector,
        mjd=round(mjd, 6),
        date_iso=Time(mjd, format="mjd", scale="utc").strftime("%Y-%m-%dT%H:%M:%SZ"),
        wavelength_min_um=None if em_min is None else round(em_min * 1e6, 4),
        wavelength_max_um=None if em_max is None else round(em_max * 1e6, 4),
        exposure_s=_optional_float(row["t_exptime"]),
        access_url=url,
    )


def query_sia(coord: SkyCoord) -> list[ImageRecord]:
    """Run the SIA2 query (blocking, uncached) and return time-sorted records."""
    from astroquery.ipac.irsa import Irsa  # imported lazily: slow import

    started = time.perf_counter()
    table = None
    error: Exception | None = None
    for attempt in range(1, config.SIA_ATTEMPTS + 1):
        try:
            table = Irsa.query_sia(
                pos=(coord, config.SIA_RADIUS_ARCSEC * u.arcsec),
                collection=config.COLLECTIONS,
            )
            break
        except Exception as exc:  # IRSA occasionally returns transient 5xx errors
            logger.warning("SIA query attempt %d/%d failed: %s", attempt, config.SIA_ATTEMPTS, exc)
            if attempt < config.SIA_ATTEMPTS:
                time.sleep(1.5 * attempt)
                continue
            error = exc
    if table is None:
        exc = error
        raise ArchiveError(
            "The IRSA archive could not be reached for the image search "
            f"({type(exc).__name__}). Please try again in a moment."
        ) from exc

    priority = {name: index for index, name in enumerate(config.COLLECTIONS)}
    by_id: dict[str, ImageRecord] = {}
    for row in table:
        if "dataproduct_subtype" in table.colnames and str(row["dataproduct_subtype"]) != "science":
            continue
        record = _record_from_row(row)
        if record is None:
            continue
        existing = by_id.get(record.id)
        # The same exposure can appear in two releases; keep the preferred one.
        if existing is None or priority.get(record.collection, 99) < priority.get(existing.collection, 99):
            by_id[record.id] = record

    records = sorted(by_id.values(), key=lambda r: (r.mjd, r.detector))
    logger.info(
        "SIA search at RA=%.6f Dec=%+.6f: %d images found in %.2f s (collections: %s)",
        coord.ra.deg, coord.dec.deg, len(records), time.perf_counter() - started,
        ", ".join(config.COLLECTIONS),
    )
    return records


_search_memo: dict[str, tuple[float, list[ImageRecord]]] = {}


def search_images(coord: SkyCoord) -> list[ImageRecord]:
    """Return every spectral image overlapping ``coord``, sorted by time.

    Results are cached in memory and on disk for ``SIA_CACHE_TTL_SECONDS``.
    Blocking; call through ``asyncio.to_thread`` from async code.
    """
    path = cache.sia_path(coord.ra.deg, coord.dec.deg)
    key = str(path)
    memo = _search_memo.get(key)
    if memo is not None and time.time() - memo[0] < config.SIA_CACHE_TTL_SECONDS:
        return memo[1]

    cached = cache.read_json(path, max_age=config.SIA_CACHE_TTL_SECONDS)
    if cached is not None:
        try:
            records = [ImageRecord(**item) for item in cached]
        except TypeError:
            records = None  # cache written by an older version of the code
        if records is not None:
            _search_memo[key] = (path.stat().st_mtime, records)
            logger.info("SIA cache hit: %d images at RA=%.6f Dec=%+.6f",
                        len(records), coord.ra.deg, coord.dec.deg)
            return records

    # Runs in a worker thread; the counter is a plain int, so this is safe
    # enough for a priority hint.
    with priority_work():
        records = query_sia(coord)
    cache.write_json(path, [asdict(record) for record in records])
    _search_memo[key] = (time.time(), records)
    return records


# --------------------------------------------------------------------------
# All-sky HiPS (sky background)
# --------------------------------------------------------------------------

#: Paths a 2-D HiPS client may request: tiles, the all-sky preview, the MOC.
_HIPS_TILE_RE = re.compile(r"^(Norder\d{1,2}/(?:Dir\d+/Npix\d+|Allsky))\.png$")

#: Properties of the cube that describe its third axis; dropped per frame.
_CUBE_KEYS = {"hips_cube_depth", "hips_cube_firstframe", "data_cube_crval3_arr", "data_cube_bunit3",
              "hips_service_url", "custom_tile_format", "custom_tile_format_order"}

_hips_cube_properties: dict[str, str] | None = None


def _parse_properties(text: str) -> dict[str, str]:
    """Parse a HiPS ``properties`` file into a dict (comments dropped)."""
    result = {}
    for line in text.splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip()
    return result


async def hips_cube_properties() -> dict[str, str]:
    """The SPHEREx all-sky cube's ``properties``, fetched once per process."""
    global _hips_cube_properties
    if _hips_cube_properties is None:
        try:
            response = await get_client().get(f"{config.HIPS_URL}/properties")
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ArchiveError(f"Could not load the SPHEREx all-sky map description: {exc}") from exc
        _hips_cube_properties = _parse_properties(response.text)
    return _hips_cube_properties


def hips_wavelengths(cube: dict[str, str]) -> list[float]:
    """Central wavelength (microns) of each cube frame."""
    return [float(value) for value in cube.get("data_cube_crval3_arr", "").split()]


async def hips_rgb_properties() -> str:
    """A ``properties`` file for the colour composite served at ``/hips/rgb/``."""
    cube = await hips_cube_properties()
    drop = _CUBE_KEYS | {"hips_pixel_cut", "hips_pixel_function", "hips_data_range"}
    props = {key: value for key, value in cube.items() if key not in drop}
    waves = hips_wavelengths(cube)
    bands = " / ".join(
        f"{sum(waves[f] for f in frames) / len(frames):.1f}"
        for frames in (config.HIPS_RGB_FRAMES[c] for c in ("blue", "green", "red"))
    ) if waves else "1.2 / 2.2 / 3.3"
    props["creator_did"] = f"{cube.get('creator_did', 'ivo://IPAC/P/SPHEREx/DR1/cube')}/rgb"
    props["obs_title"] = f"SPHEREx DR1 all-sky colour composite (B/G/R = {bands} um)"
    props["dataproduct_type"] = "image"
    props["hips_tile_format"] = "jpeg"
    return "".join(f"{key:20s} = {value}\n" for key, value in props.items())


#: Colour tile paths, as requested by a HiPS client for a ``jpeg`` HiPS.
HIPS_RGB_TILE_RE = re.compile(r"^(Norder\d{1,2}/(?:Dir\d+/Npix\d+|Allsky))\.jpg$")


async def hips_frame_properties(frame: int) -> str:
    """A ``properties`` file describing one cube frame as an ordinary 2-D HiPS.

    The frame gets its own ``creator_did``, so a viewer can stack several
    frames as separate layers, and a wavelength range limited to that frame.
    """
    cube = await hips_cube_properties()
    props = {key: value for key, value in cube.items() if key not in _CUBE_KEYS}
    waves = hips_wavelengths(cube)
    props["creator_did"] = f"{cube.get('creator_did', 'ivo://IPAC/P/SPHEREx/DR1/cube')}/frame{frame}"
    props["dataproduct_type"] = "image"
    props["hips_tile_format"] = "png"
    if frame < len(waves):
        props["obs_title"] = f"SPHEREx DR1 all-sky, {waves[frame]:.3f} um"
        props["em_min"] = props["em_max"] = f"{waves[frame] * 1e-6:.4e}"
    return "".join(f"{key:20s} = {value}\n" for key, value in props.items())


def hips_tile_url(frame: int, path: str) -> str | None:
    """IRSA URL of the tile ``path`` (2-D HiPS naming) in cube ``frame``, or ``None``."""
    if path == "Moc.fits":
        return f"{config.HIPS_URL}/Moc.fits"
    match = _HIPS_TILE_RE.match(path)
    if match is None:
        return None
    suffix = "" if frame == 0 else f"_{frame}"
    return f"{config.HIPS_URL}/{match.group(1)}{suffix}.png"


_hips_semaphore = asyncio.Semaphore(config.HIPS_MAX_CONCURRENT)
_priority_lock = threading.Lock()
_priority_active = 0  # SIA searches (worker threads) and cutout downloads in progress
_hips_active = 0


class priority_work:
    """Context manager marking IRSA work that sky tiles must not slow down.

    Safe to use from worker threads (the SIA search runs in one).
    """

    def __enter__(self) -> "priority_work":
        global _priority_active
        with _priority_lock:
            _priority_active += 1
        return self

    def __exit__(self, *_exc) -> None:
        global _priority_active
        with _priority_lock:
            _priority_active -= 1


def priority_busy() -> bool:
    """True while a search or a cutout download is running."""
    return _priority_active > 0


async def fetch_hips_tile(frame: int, tile: str) -> bytes | None:
    """Download one PNG tile of a cube frame (``tile`` like ``Norder5/Dir0/Npix12``).

    Searches and blink cutouts have priority: while any is running, sky
    tiles may use only ``HIPS_SHARE_WHILE_BLINKING`` connections, because
    IRSA throttles all of our requests together once there are too many.

    Returns ``None`` when IRSA has no such tile.
    """
    global _hips_active
    url = hips_tile_url(frame, f"{tile}.png")
    if url is None:
        raise ValueError(f"not a HiPS tile path: {tile}")
    while priority_busy() and _hips_active >= config.HIPS_SHARE_WHILE_BLINKING:
        await asyncio.sleep(0.05)
    _hips_active += 1
    try:
        return await download(url, semaphore=_hips_semaphore)
    except NotFound:
        return None
    finally:
        _hips_active -= 1


# --------------------------------------------------------------------------
# Cutout download
# --------------------------------------------------------------------------

@dataclass
class Cutout:
    """The parts of one downloaded cutout that the app uses."""

    image: np.ndarray
    zodi: np.ndarray
    header: fits.Header
    wavelength_um: float | None
    bandwidth_um: float | None


@dataclass
class WaveTable:
    """Per-detector wavelength lookup table (the WCS-WAVE extension).

    ``values[j, i]`` holds (central wavelength, bandwidth) in microns at the
    control point ``(x[i], y[j])``, in pixel coordinates of the full detector.
    """

    x: np.ndarray
    y: np.ndarray
    values: np.ndarray

    def lookup(self, full_x: float, full_y: float) -> tuple[float, float]:
        """Bilinearly interpolate (wavelength, bandwidth) at a full-detector pixel."""
        result = []
        for index in (0, 1):
            interpolator = RegularGridInterpolator(
                (self.y, self.x), self.values[:, :, index],
                method="linear", bounds_error=False, fill_value=None,
            )
            result.append(float(interpolator([[full_y, full_x]])[0]))
        return result[0], result[1]


_client: httpx.AsyncClient | None = None
_semaphore = asyncio.Semaphore(config.MAX_CONCURRENT_DOWNLOADS)
_wave_tables: dict[str, WaveTable] = {}
_wave_locks: dict[str, asyncio.Lock] = {}


def get_client() -> httpx.AsyncClient:
    """Return the shared HTTP client, creating it on first use."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(config.READ_TIMEOUT, connect=config.CONNECT_TIMEOUT),
            follow_redirects=True,
            limits=httpx.Limits(
                max_connections=(config.MAX_CONCURRENT_DOWNLOADS + config.HIPS_MAX_CONCURRENT) * 2
            ),
            headers={"User-Agent": "spherex-blink/1.0"},
        )
    return _client


async def close_client() -> None:
    """Close the shared HTTP client (called at application shutdown)."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def cutout_url(access_url: str, coord: SkyCoord) -> str:
    """Build the IRSA cutout URL for ``access_url`` centred on ``coord``."""
    size = config.FOV_DEG * config.CUTOUT_PADDING
    return f"{access_url}?center={coord.ra.deg:.6f},{coord.dec.deg:.6f}deg&size={size:.4f}deg"


def _find_bintable(buffer: bytearray, start: int) -> tuple[int, int]:
    """Look for the first BINTABLE header at a FITS block boundary.

    Returns ``(offset, next_start)``; ``offset`` is -1 if none was found yet.
    """
    offset = start
    while offset + len(_BINTABLE_CARD) <= len(buffer):
        if buffer.startswith(_BINTABLE_CARD, offset):
            return offset, offset
        offset += FITS_BLOCK
    return -1, offset


class NotFound(ArchiveError):
    """IRSA answered 404 for the requested URL."""


async def _download_once(url: str, image_hdus_only: bool) -> bytes:
    """One download attempt.  Raises ``httpx`` errors or ``_Retry``."""
    async with get_client().stream("GET", url) as response:
        if response.status_code in _RETRY_STATUS:
            raise _Retry(f"HTTP {response.status_code}", response.headers.get("retry-after"))
        if response.status_code == 404:
            raise NotFound(f"IRSA has no file at {url}")
        if response.status_code != 200:
            raise ArchiveError(f"IRSA returned HTTP {response.status_code} for the cutout")
        buffer = bytearray()
        scan_from = 0
        async for chunk in response.aiter_bytes():
            buffer.extend(chunk)
            if image_hdus_only:
                found, scan_from = _find_bintable(buffer, scan_from)
                if found >= 0:
                    return bytes(buffer[:found])  # leaving the block closes the stream
        return bytes(buffer)


class _Retry(Exception):
    """Internal: the attempt failed in a way worth retrying."""

    def __init__(self, reason: str, retry_after: str | None = None) -> None:
        super().__init__(reason)
        self.retry_after = retry_after


async def download(url: str, image_hdus_only: bool = False,
                   semaphore: asyncio.Semaphore | None = None) -> bytes:
    """Download ``url`` with bounded concurrency, timeouts and retries.

    Args:
        url: Cutout URL.
        image_hdus_only: Stop at the first binary-table HDU (skips the large
            EPSF table and everything after it).
        semaphore: Concurrency pool to use (default: the cutout pool).

    Raises:
        NotFound: IRSA has no such file (not retried).
        ArchiveError: once every attempt has failed.
    """
    pool = semaphore or _semaphore
    reason = "unknown error"
    for attempt in range(1, config.MAX_ATTEMPTS + 1):
        retry_after: str | None = None
        try:
            async with pool:
                return await _download_once(url, image_hdus_only)
        except _Retry as exc:
            reason, retry_after = str(exc), exc.retry_after
        except httpx.TimeoutException:
            reason = "timed out"
        except httpx.TransportError as exc:
            reason = f"network error ({type(exc).__name__})"
        if attempt == config.MAX_ATTEMPTS:
            break
        # Exponential backoff, never longer than the server's Retry-After hint.
        # Measured behaviour: IRSA rejects roughly a third of cutout requests
        # with "503 Server busy" whatever our request rate (1 to 6 in parallel
        # made no difference), and an immediate retry usually succeeds.
        wait = config.RETRY_BASE_WAIT * 2 ** (attempt - 1)
        try:
            wait = min(wait, float(retry_after)) if retry_after else wait
        except ValueError:
            pass
        wait = min(wait, config.MAX_RETRY_WAIT) + random.uniform(0.0, 0.3)
        logger.debug("cutout attempt %d/%d failed (%s); retrying in %.1f s",
                     attempt, config.MAX_ATTEMPTS, reason, wait)
        await asyncio.sleep(wait)  # the semaphore is released while waiting
    raise ArchiveError(f"IRSA cutout failed after {config.MAX_ATTEMPTS} attempts: {reason}")


def _wave_key(header: fits.Header) -> str | None:
    """Identify the wavelength calibration used for an image, from its header."""
    matches = _CALIB_RE.findall("\n".join(str(line) for line in header.get("HISTORY", [])))
    detector = header.get("DETECTOR")
    if not matches or detector is None:
        return None
    return f"D{int(detector)}_{matches[-1]}"


def _read_wave_table(raw: bytes) -> WaveTable:
    """Extract the WCS-WAVE lookup table from a complete cutout file."""
    with fits.open(io.BytesIO(raw), memmap=False) as hdulist:
        row = hdulist["WCS-WAVE"].data[0]
        return WaveTable(
            x=np.asarray(row["X"], dtype=np.float64),
            y=np.asarray(row["Y"], dtype=np.float64),
            values=np.asarray(row["VALUES"], dtype=np.float64),
        )


async def _get_wave_table(header: fits.Header, url: str) -> WaveTable:
    """Return the wavelength table for this image, downloading it if not cached."""
    key = _wave_key(header)
    if key is None:  # no calibration id in the header: read this file's own table
        return _read_wave_table(await download(url))
    if key in _wave_tables:
        return _wave_tables[key]
    async with _wave_locks.setdefault(key, asyncio.Lock()):
        if key in _wave_tables:
            return _wave_tables[key]
        path = cache.wave_path(key)
        stored = cache.read_npz(path)
        if stored is not None and {"x", "y", "values"} <= stored.keys():
            table = WaveTable(stored["x"], stored["y"], stored["values"])
        else:
            table = _read_wave_table(await download(url))
            cache.write_npz(path, x=table.x, y=table.y, values=table.values)
            logger.info("cached wavelength table %s", key)
        _wave_tables[key] = table
        return table


def wavelength_at(table: WaveTable, header: fits.Header, coord: SkyCoord) -> tuple[float, float]:
    """Wavelength and bandwidth (microns) seen by the pixel under ``coord``.

    The lookup table is indexed by full-detector pixel coordinates; the
    cutout header's alternate "W" WCS (CRPIXnW / CRVALnW) gives the offset of
    the cutout within the detector.
    """
    x, y = WCS(header).world_to_pixel(coord)  # 0-based cutout pixels
    full_x = (float(x) + 1.0) - float(header["CRPIX1W"]) + float(header["CRVAL1W"])
    full_y = (float(y) + 1.0) - float(header["CRPIX2W"]) + float(header["CRVAL2W"])
    return table.lookup(full_x, full_y)


def _parse_cutout(raw: bytes) -> tuple[np.ndarray, np.ndarray, fits.Header]:
    """Read the IMAGE and ZODI arrays and the IMAGE header from cutout bytes."""
    try:
        with fits.open(io.BytesIO(raw), memmap=False) as hdulist:
            image = np.array(hdulist["IMAGE"].data, dtype=np.float32)
            zodi = np.array(hdulist["ZODI"].data, dtype=np.float32)
            header = hdulist["IMAGE"].header.copy()
    except Exception as exc:
        raise ArchiveError(f"The cutout is not a readable SPHEREx image ({exc})") from exc
    if image.ndim != 2 or image.shape != zodi.shape:
        raise ArchiveError("The cutout has an unexpected shape")
    return image, zodi, header


async def fetch_cutout(record: ImageRecord, coord: SkyCoord) -> Cutout:
    """Download and read the cutout of ``record`` around ``coord``.

    Raises:
        ArchiveError: if the cutout cannot be downloaded or read.  A failure
            to obtain the wavelength only leaves ``wavelength_um`` as ``None``.
    """
    url = cutout_url(record.access_url, coord)
    with priority_work():
        raw = await download(url, image_hdus_only=True)
    image, zodi, header = await asyncio.to_thread(_parse_cutout, raw)

    wavelength = bandwidth = None
    try:
        table = await _get_wave_table(header, url)
        wavelength, bandwidth = wavelength_at(table, header, coord)
    except Exception as exc:  # wavelength is a nicety, never fatal
        logger.warning("no wavelength for %s: %s", record.id, exc)
    return Cutout(image=image, zodi=zodi, header=header,
                  wavelength_um=wavelength, bandwidth_um=bandwidth)
