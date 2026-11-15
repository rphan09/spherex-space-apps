"""Small on-disk cache helpers.

Layout under ``config.CACHE_DIR``::

    sia/<ra>_<dec>__<collections>.json            SIA search results
    frames/<collection>/<id>__<ra>_<dec>_<fov>.npz  processed frames
    wave/D<n>_<calibration id>.npz                 wavelength lookup tables

Writes go to a temporary file first and are renamed into place, so a crashed
or concurrent request can never leave a half-written cache entry.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np

from . import config

_SAFE = re.compile(r"[^A-Za-z0-9_.+-]")


def safe_name(text: str) -> str:
    """Make ``text`` safe to use as a file name."""
    return _SAFE.sub("_", text)


def position_key(ra_deg: float, dec_deg: float) -> str:
    """Cache-key fragment for a sky position (degrees, 6 decimals = 3.6 mas)."""
    return f"{ra_deg:.6f}_{dec_deg:+.6f}"


def sia_path(ra_deg: float, dec_deg: float) -> Path:
    """Cache file for the SIA search at a position."""
    collections = safe_name("+".join(config.COLLECTIONS))
    return config.CACHE_DIR / "sia" / f"{position_key(ra_deg, dec_deg)}__{collections}.json"


def frame_path(collection: str, image_id: str, ra_deg: float, dec_deg: float) -> Path:
    """Cache file for one processed frame, keyed by (collection, id, ra, dec, fov)."""
    name = f"{safe_name(image_id)}__{position_key(ra_deg, dec_deg)}_{config.FOV_DEG:g}.npz"
    return config.CACHE_DIR / "frames" / safe_name(collection) / name


def wave_path(key: str) -> Path:
    """Cache file for a detector wavelength lookup table."""
    return config.CACHE_DIR / "wave" / f"{safe_name(key)}.npz"


def hips_tile_path(layer: str, tile: str) -> Path:
    """Cache file for a generated sky tile (``tile`` is a HiPS-relative path)."""
    return config.CACHE_DIR / "hips" / safe_name(layer) / Path(*[safe_name(p) for p in tile.split("/")])


def read_bytes(path: Path) -> bytes | None:
    """Return the cached bytes at ``path``, or ``None`` if missing."""
    try:
        return path.read_bytes()
    except OSError:
        return None


def write_bytes(path: Path, data: bytes) -> None:
    """Atomically write raw bytes."""
    _atomic_write(path, lambda handle: handle.write(data))


def _atomic_write(path: Path, write) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with open(tmp, "wb") as handle:
            write(handle)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def read_json(path: Path, max_age: float | None = None) -> Any | None:
    """Return the cached JSON at ``path``, or ``None`` if missing, stale or corrupt."""
    try:
        if max_age is not None and time.time() - path.stat().st_mtime > max_age:
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_json(path: Path, payload: Any) -> None:
    """Atomically write ``payload`` as JSON."""
    data = json.dumps(payload).encode("utf-8")
    _atomic_write(path, lambda handle: handle.write(data))


def read_npz(path: Path) -> dict[str, np.ndarray] | None:
    """Return the arrays stored at ``path``, or ``None`` if missing or corrupt."""
    try:
        with np.load(path, allow_pickle=False) as archive:
            return {name: archive[name] for name in archive.files}
    except (OSError, ValueError, EOFError):
        return None


def write_npz(path: Path, **arrays: np.ndarray) -> None:
    """Atomically write arrays as a compressed ``.npz``."""
    _atomic_write(path, lambda handle: np.savez_compressed(handle, **arrays))
