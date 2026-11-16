"""FastAPI application: API routes and static frontend.

Run from the repository root::

    uvicorn backend.main:app --reload
"""

from __future__ import annotations

import asyncio
import json
import logging
import struct
import time
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Literal

import numpy as np
from astropy.coordinates import SkyCoord
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import cache, config, data_access, processing, sky

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per IRSA request is too noisy
logger = logging.getLogger("spherex.api")

NO_COVERAGE_MESSAGE = "No SPHEREx images cover this position yet."


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Start the sky-map warm-up; close the shared HTTP client when the server stops."""
    warm = asyncio.create_task(sky.warm_up())
    yield
    warm.cancel()
    await data_access.close_client()


app = FastAPI(title="SPHEREx Blink", version="1.0.0", lifespan=lifespan)


class TextGZipMiddleware(GZipMiddleware):
    """Compress text responses (the 2.4 MB sky-viewer script shrinks about 4x),
    but never the binary frame endpoints: float16 pixels barely compress, and
    gzip buffering would hold back frames that should reach the browser at once."""

    BINARY_PREFIXES = ("/api/stream", "/api/frame/")

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http" and scope["path"].startswith(self.BINARY_PREFIXES):
            await self.app(scope, receive, send)
            return
        await super().__call__(scope, receive, send)


app.add_middleware(TextGZipMiddleware, minimum_size=1024, compresslevel=6)


def _coordinates(ra: str, dec: str) -> SkyCoord:
    """Parse query-string coordinates, turning errors into HTTP 400."""
    try:
        return data_access.parse_coordinates(ra, dec)
    except data_access.CoordinateError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _search(coord: SkyCoord) -> list[data_access.ImageRecord]:
    """Run the (cached) SIA search off the event loop; archive errors become HTTP 502."""
    try:
        return await asyncio.to_thread(data_access.search_images, coord)
    except data_access.ArchiveError as exc:
        logger.error("search failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _fov(fov: float | None) -> float:
    """Validate a requested field of view (degrees) against ``config.FOV_CHOICES``."""
    if fov is None:
        return config.FOV_DEG
    for choice in config.FOV_CHOICES:
        if abs(fov - choice) < 1e-6:
            return choice
    allowed = ", ".join(f"{c:g}" for c in config.FOV_CHOICES)
    raise HTTPException(status_code=400, detail=f"Field of view must be one of {allowed} degrees.")


@app.get("/api/info")
async def info() -> dict:
    """What this server offers: data collections, fields of view, flags, catalogues."""
    collections = await asyncio.to_thread(data_access.active_collections)
    return {
        "collections": collections,
        "fov_choices": list(config.FOV_CHOICES),
        "default_fov": config.FOV_DEG,
        "pixel_scale_arcsec": config.PIXEL_SCALE_ARCSEC,
        "flag_bits": {str(bit): {"name": n, "description": d, "category": c}
                      for bit, (n, d, c) in processing.FLAG_BITS.items()},
        "flag_categories": [{"id": cid, "label": label} for cid, label in processing.FLAG_CATEGORIES],
        "header_metadata": [{"key": k, "label": label, "kind": kind}
                            for k, label, kind in data_access.HEADER_METADATA],
        "catalogs": {name: {"label": spec["label"], "epoch": spec["epoch"], "mag_label": spec["mag_label"]}
                     for name, spec in config.CATALOGS.items()},
    }


@app.get("/api/search")
async def search(
    ra: str = Query(..., description="Right ascension: decimal degrees or sexagesimal hours"),
    dec: str = Query(..., description="Declination: decimal degrees or sexagesimal degrees"),
    fov: float | None = Query(None, description="Field of view in degrees (see /api/info)"),
) -> dict:
    """List every SPHEREx spectral image overlapping a position, sorted by time."""
    coord = _coordinates(ra, dec)
    fov_deg = _fov(fov)
    records = await _search(coord)
    return {
        "ra": coord.ra.deg,
        "dec": coord.dec.deg,
        "fov_deg": fov_deg,
        "grid_size": config.grid_size(fov_deg),
        "pixel_scale_arcsec": config.PIXEL_SCALE_ARCSEC,
        "collections": await asyncio.to_thread(data_access.active_collections),
        "count": len(records),
        "message": None if records else NO_COVERAGE_MESSAGE,
        "images": [asdict(record) for record in records],
    }


async def _load_frame(record: data_access.ImageRecord, coord: SkyCoord,
                      fov: float = config.FOV_DEG) -> tuple[np.ndarray, np.ndarray, dict, bool]:
    """Return ``(data, flags, metadata, from_cache)`` for one frame, processing it if needed.

    ``flags`` is the FLAGS bitmap on the same grid (uint32, zeros if absent).
    """
    path = cache.frame_path(record.collection, record.id, coord.ra.deg, coord.dec.deg, fov)
    stored = await asyncio.to_thread(cache.read_npz, path)
    if stored is not None and {"data", "flags", "meta"} <= stored.keys():
        return stored["data"], stored["flags"], json.loads(str(stored["meta"])), True

    started = time.perf_counter()
    cutout = await data_access.fetch_cutout(record, coord, fov)
    fetched = time.perf_counter()
    data = await asyncio.to_thread(
        processing.process_cutout, cutout.image, cutout.zodi, cutout.header, coord, fov
    )
    if cutout.flags is not None:
        flags = await asyncio.to_thread(processing.reproject_flags, cutout.flags, cutout.header, coord, fov)
    else:
        flags = np.zeros(data.shape, dtype=np.uint32)
    meta = {
        "id": record.id,
        "collection": record.collection,
        "detector": record.detector,
        "mjd": record.mjd,
        "date_iso": record.date_iso,
        "wavelength_um": None if cutout.wavelength_um is None else round(cutout.wavelength_um, 5),
        "bandwidth_um": None if cutout.bandwidth_um is None else round(cutout.bandwidth_um, 5),
        "unit": "MJy/sr",
        "header": data_access.header_metadata(cutout.header),
        "target_flags": processing.flags_at_center(flags),
    }
    await asyncio.to_thread(cache.write_npz, path, data=data, flags=flags, meta=np.array(json.dumps(meta)))
    logger.info("frame %s: fetched in %.2f s, processed in %.2f s",
                record.id, fetched - started, time.perf_counter() - fetched)
    return data, flags, meta, False


class StreamRequest(BaseModel):
    """Body of ``POST /api/stream``."""

    ra: str
    dec: str
    fov: float | None = None
    ids: list[str] = Field(default_factory=list, description="Image ids to send, in the order wanted")


def _stream_message(header: dict, payload: bytes = b"") -> bytes:
    """One message of the frame stream: two little-endian uint32 lengths, JSON header, payload."""
    head = json.dumps(header, separators=(",", ":")).encode()
    return struct.pack("<II", len(head), len(payload)) + head + payload


@app.post("/api/stream")
async def stream(body: StreamRequest) -> StreamingResponse:
    """Send many frames over one connection, each as soon as it is ready.

    Browsers open at most 6 connections to one server, so loading frames one
    request at a time caps the download rate; this endpoint fetches up to
    ``MAX_CONCURRENT_DOWNLOADS`` cutouts at once instead.  Frames are started
    in the order of ``ids`` and sent in the order they finish.

    Each message is ``uint32 header_length, uint32 payload_length, header
    JSON, payload``.  A frame's payload is its pixels as float16
    (``width * height * 2`` bytes, row 0 north) followed by one byte per pixel
    of flag categories (bit i = ``flag_categories[i]`` in /api/info).  A
    failed frame has ``ok: false``, an ``error`` and no payload.  The stream
    ends with ``{"done": true}``.
    """
    coord = _coordinates(body.ra, body.dec)
    fov = _fov(body.fov)
    records = {r.id: r for r in await _search(coord)}
    wanted = [records[i] for i in dict.fromkeys(body.ids) if i in records] if body.ids else list(records.values())

    async def generate():
        queue: asyncio.Queue = asyncio.Queue()

        async def work(record: data_access.ImageRecord) -> None:
            try:
                data, flags, meta, _ = await _load_frame(record, coord, fov)
                payload = processing.encode_float16(data) + processing.flag_category_mask(flags).tobytes()
                await queue.put(({"id": record.id, "ok": True, "width": int(data.shape[1]),
                                  "height": int(data.shape[0]), "meta": meta}, payload))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                message = str(exc) if isinstance(exc, (data_access.ArchiveError, ValueError)) \
                    else f"Could not process this image ({type(exc).__name__})."
                await queue.put(({"id": record.id, "ok": False, "error": message}, b""))

        # Tasks are created in the requested order; downloads queue for the
        # shared cutout semaphore in that same order.
        tasks = [asyncio.create_task(work(r)) for r in wanted]
        started = time.perf_counter()
        try:
            for _ in tasks:
                header, payload = await queue.get()
                yield _stream_message(header, payload)
            yield _stream_message({"done": True})
            logger.info("stream: %d frames in %.1f s", len(tasks), time.perf_counter() - started)
        finally:
            for task in tasks:  # the client went away, or we finished
                task.cancel()

    return StreamingResponse(generate(), media_type="application/octet-stream",
                             headers={"Cache-Control": "no-store", "X-Frame-Count": str(len(wanted))})


@app.get("/api/catalog")
async def catalog(
    name: Literal["gaia", "allwise"],
    ra: str = Query(...),
    dec: str = Query(...),
    fov: float | None = Query(None),
) -> dict:
    """Sources from an overlay catalogue (Gaia DR3 or AllWISE) covering the field."""
    coord = _coordinates(ra, dec)
    fov_deg = _fov(fov)
    radius = fov_deg * 0.75  # covers the corners of the square field, with margin for fast movers
    try:
        rows = await data_access.fetch_catalog(name, coord, radius)
    except data_access.ArchiveError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    spec = config.CATALOGS[name]
    return {"name": name, "label": spec["label"], "epoch": spec["epoch"], "mag_label": spec["mag_label"],
            "columns": ["ra", "dec", "pmra", "pmdec", "mag"], "rows": rows}


@app.get("/api/frame/{image_id}")
async def frame(
    image_id: str,
    ra: str = Query(...),
    dec: str = Query(...),
    fov: float | None = Query(None),
    format: Literal["png", "raw"] = Query(
        "png", description="'png' for a stretched image, 'raw' for little-endian float32 pixels"
    ),
) -> Response:
    """Return one aligned, zodi-subtracted frame.

    The frame is a north-up, east-left ``grid_size`` x ``grid_size`` image
    centred on the requested position.  ``format=raw`` returns the float32
    pixel values (row 0 = north, NaN = no data) so a client can re-stretch
    without another request.  Metadata is returned in ``X-Frame-*`` headers.
    """
    coord = _coordinates(ra, dec)
    fov_deg = _fov(fov)
    records = await _search(coord)
    record = next((item for item in records if item.id == image_id), None)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Image '{image_id}' does not cover this position.")

    try:
        data, _flags, meta, from_cache = await _load_frame(record, coord, fov_deg)
    except (data_access.ArchiveError, ValueError) as exc:
        # A failed frame is reported to the client and skipped there.
        logger.warning("frame %s failed: %s", image_id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("frame %s failed unexpectedly", image_id)
        raise HTTPException(status_code=500, detail=f"Could not process this image ({exc}).") from exc

    headers = {
        "X-Frame-Meta": json.dumps({k: v for k, v in meta.items() if k != "header"}),
        "X-Frame-Width": str(data.shape[1]),
        "X-Frame-Height": str(data.shape[0]),
        "X-Frame-Cache": "hit" if from_cache else "miss",
        "Cache-Control": "public, max-age=86400",
    }
    if format == "raw":
        body = np.ascontiguousarray(data, dtype="<f4").tobytes()
        return Response(content=body, media_type="application/octet-stream", headers=headers)
    return Response(content=processing.to_png(data), media_type="image/png", headers=headers)


def _check_frame(frame: int) -> None:
    if not 0 <= frame < config.HIPS_DEPTH or frame in config.HIPS_BLANK_FRAMES:
        raise HTTPException(status_code=404, detail="No such SPHEREx all-sky frame.")


@app.get("/api/sky")
async def sky_frames() -> dict:
    """Wavelength frames of the SPHEREx all-sky map, for the sky viewer."""
    try:
        cube = await data_access.hips_cube_properties()
    except data_access.ArchiveError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    waves = data_access.hips_wavelengths(cube)
    return {
        "frames": [
            {"frame": index, "wavelength_um": wave, "detector": index // 17 + 1}
            for index, wave in enumerate(waves) if index not in config.HIPS_BLANK_FRAMES
        ],
        "pixel_scale_arcsec": round(float(cube.get("hips_pixel_scale", 0)) * 3600, 2),
        "credit": "NASA/JPL-Caltech/SPHEREx, IRSA",
    }


@app.get("/hips/rgb/properties")
async def hips_rgb_properties() -> Response:
    """Properties of the colour composite sky (the default sky background)."""
    try:
        text = await data_access.hips_rgb_properties()
    except data_access.ArchiveError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return Response(content=text, media_type="text/plain",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/hips/rgb/{path:path}")
async def hips_rgb_tile(path: str) -> Response:
    """A colour sky tile, built from three SPHEREx wavelengths and cached on disk."""
    match = data_access.HIPS_RGB_TILE_RE.match(path)
    if match is None:
        if path == "Moc.fits":
            return RedirectResponse(f"{config.HIPS_URL}/Moc.fits", status_code=302)
        raise HTTPException(status_code=404, detail="Unknown sky tile.")
    try:
        data = await sky.rgb_tile(match.group(1))
    except data_access.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except data_access.ArchiveError as exc:
        logger.warning("sky tile %s failed: %s", match.group(1), exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return Response(content=data, media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=604800"})


@app.get("/hips/{frame}/properties")
async def hips_properties(frame: int) -> Response:
    """One frame of the SPHEREx all-sky cube, described as an ordinary 2-D HiPS."""
    _check_frame(frame)
    try:
        text = await data_access.hips_frame_properties(frame)
    except data_access.ArchiveError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return Response(content=text, media_type="text/plain",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/hips/{frame}/{path:path}")
async def hips_tile(frame: int, path: str) -> RedirectResponse:
    """Redirect a tile request to IRSA's copy of that frame; tiles are never proxied."""
    _check_frame(frame)
    target = data_access.hips_tile_url(frame, path)
    if target is None:
        raise HTTPException(status_code=404, detail="Unknown sky tile.")
    return RedirectResponse(target, status_code=302, headers={"Cache-Control": "public, max-age=86400"})


class FrontendFiles(StaticFiles):
    """Static frontend files.  Our own files are revalidated on each load (a
    cheap 304 when unchanged), so an updated frontend shows up at once.
    Vendored libraries sit in versioned folders and never change, so browsers
    may keep them for a year without asking again."""

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        if path.replace("\\", "/").startswith("vendor/") and response.status_code in (200, 304):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


# The frontend is plain static files, served from the same origin as the API.
app.mount("/", FrontendFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
