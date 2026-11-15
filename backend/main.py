"""FastAPI application: API routes and static frontend.

Run from the repository root::

    uvicorn backend.main:app --reload
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Literal

import numpy as np
from astropy.coordinates import SkyCoord
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

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


@app.get("/api/search")
async def search(
    ra: str = Query(..., description="Right ascension: decimal degrees or sexagesimal hours"),
    dec: str = Query(..., description="Declination: decimal degrees or sexagesimal degrees"),
) -> dict:
    """List every SPHEREx spectral image overlapping a position, sorted by time."""
    coord = _coordinates(ra, dec)
    records = await _search(coord)
    return {
        "ra": coord.ra.deg,
        "dec": coord.dec.deg,
        "fov_deg": config.FOV_DEG,
        "grid_size": config.grid_size(),
        "pixel_scale_arcsec": config.PIXEL_SCALE_ARCSEC,
        "collections": config.COLLECTIONS,
        "count": len(records),
        "message": None if records else NO_COVERAGE_MESSAGE,
        "images": [asdict(record) for record in records],
    }


async def _load_frame(record: data_access.ImageRecord, coord: SkyCoord) -> tuple[np.ndarray, dict, bool]:
    """Return ``(data, metadata, from_cache)`` for one frame, processing it if needed."""
    path = cache.frame_path(record.collection, record.id, coord.ra.deg, coord.dec.deg)
    stored = await asyncio.to_thread(cache.read_npz, path)
    if stored is not None and "data" in stored and "meta" in stored:
        return stored["data"], json.loads(str(stored["meta"])), True

    started = time.perf_counter()
    cutout = await data_access.fetch_cutout(record, coord)
    fetched = time.perf_counter()
    data = await asyncio.to_thread(
        processing.process_cutout, cutout.image, cutout.zodi, cutout.header, coord
    )
    meta = {
        "id": record.id,
        "collection": record.collection,
        "detector": record.detector,
        "mjd": record.mjd,
        "date_iso": record.date_iso,
        "wavelength_um": None if cutout.wavelength_um is None else round(cutout.wavelength_um, 5),
        "bandwidth_um": None if cutout.bandwidth_um is None else round(cutout.bandwidth_um, 5),
        "unit": "MJy/sr",
    }
    await asyncio.to_thread(cache.write_npz, path, data=data, meta=np.array(json.dumps(meta)))
    logger.info("frame %s: fetched in %.2f s, processed in %.2f s",
                record.id, fetched - started, time.perf_counter() - fetched)
    return data, meta, False


@app.get("/api/frame/{image_id}")
async def frame(
    image_id: str,
    ra: str = Query(...),
    dec: str = Query(...),
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
    records = await _search(coord)
    record = next((item for item in records if item.id == image_id), None)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Image '{image_id}' does not cover this position.")

    try:
        data, meta, from_cache = await _load_frame(record, coord)
    except (data_access.ArchiveError, ValueError) as exc:
        # A failed frame is reported to the client and skipped there.
        logger.warning("frame %s failed: %s", image_id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("frame %s failed unexpectedly", image_id)
        raise HTTPException(status_code=500, detail=f"Could not process this image ({exc}).") from exc

    headers = {
        "X-Frame-Meta": json.dumps(meta),
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
    """Static frontend files.  Browsers revalidate them on each load (a cheap
    304 when unchanged), so an updated frontend shows up at once."""

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# The frontend is plain static files, served from the same origin as the API.
app.mount("/", FrontendFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
