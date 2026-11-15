"""The colour all-sky map: builds, caches and pre-builds colour HiPS tiles.

A colour tile combines the same tile from several frames of IRSA's SPHEREx
all-sky cube (see ``config.HIPS_RGB_FRAMES``).  Tiles are built on first
request and cached on disk; a background task pre-builds the wide-view
orders after start-up so that browsing the whole sky is instant.
"""

from __future__ import annotations

import asyncio
import logging
import time

from . import cache, config, data_access, processing

logger = logging.getLogger("spherex.sky")

_locks: dict[str, asyncio.Lock] = {}


def tile_name(order: int, pixel: int) -> str:
    """HiPS-relative tile name (no extension) of a HEALPix pixel."""
    return f"Norder{order}/Dir{(pixel // 10000) * 10000}/Npix{pixel}"


async def _build(tile: str) -> bytes:
    """Fetch the single-wavelength tiles behind a colour tile and combine them."""
    colours = list(config.HIPS_RGB_FRAMES)
    jobs = [data_access.fetch_hips_tile(frame, tile) for c in colours for frame in config.HIPS_RGB_FRAMES[c]]
    results = iter(await asyncio.gather(*jobs))
    channels = {
        c: [processing.decode_tile(next(results)) for _ in config.HIPS_RGB_FRAMES[c]] for c in colours
    }
    if all(t is None for tiles in channels.values() for t in tiles):
        raise data_access.NotFound(f"no SPHEREx data for sky tile {tile}")
    return await asyncio.to_thread(processing.composite_rgb, channels)


async def rgb_tile(tile: str) -> bytes:
    """Return a colour tile (e.g. ``Norder3/Dir0/Npix12`` or ``Norder3/Allsky``) as JPEG.

    Raises:
        data_access.NotFound: IRSA has no data for this tile.
        data_access.ArchiveError: IRSA could not be reached.
    """
    path = cache.hips_tile_path("rgb", f"{tile}.jpg")
    data = await asyncio.to_thread(cache.read_bytes, path)
    if data is not None:
        return data
    lock = _locks.setdefault(tile, asyncio.Lock())
    async with lock:
        data = await asyncio.to_thread(cache.read_bytes, path)
        if data is None:
            data = await _build(tile)
            await asyncio.to_thread(cache.write_bytes, path, data)
    _locks.pop(tile, None)
    return data


async def warm_up() -> None:
    """Pre-build every colour tile up to ``HIPS_WARM_ORDER`` (skips cached ones).

    Runs in the background after start-up.  It waits whenever a search or a
    blink is running, so it never slows those down.
    """
    if config.HIPS_WARM_ORDER < 0:
        return
    order = config.HIPS_WARM_ORDER
    todo = [f"Norder{order}/Allsky"] + [
        tile_name(o, p) for o in range(order + 1) for p in range(12 * 4 ** o)
    ]
    todo = [t for t in todo if not cache.hips_tile_path("rgb", f"{t}.jpg").exists()]
    if not todo:
        return
    logger.info("pre-building %d colour sky tiles (orders 0-%d) in the background", len(todo), order)
    started = time.perf_counter()
    gate = asyncio.Semaphore(config.HIPS_WARM_CONCURRENT)
    done = failed = 0

    async def one(tile: str) -> None:
        nonlocal done, failed
        async with gate:
            while data_access.priority_busy():
                await asyncio.sleep(0.5)
            try:
                await rgb_tile(tile)
                done += 1
            except data_access.NotFound:
                done += 1
            except Exception as exc:  # never let the warm-up crash the app
                failed += 1
                logger.debug("warm-up tile %s failed: %s", tile, exc)
            if (done + failed) % 100 == 0:
                logger.info("sky warm-up: %d / %d tiles", done + failed, len(todo))

    await asyncio.gather(*(one(t) for t in todo))
    logger.info("sky warm-up finished: %d tiles in %.0f s (%d failed, retried on demand)",
                done, time.perf_counter() - started, failed)
