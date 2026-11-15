"""Central configuration for the SPHEREx blink tool.

A new SPHEREx data release should need nothing more than an edit to
``COLLECTIONS`` below.
"""

from __future__ import annotations

from pathlib import Path

# --------------------------------------------------------------------------
# IRSA data access
# --------------------------------------------------------------------------

#: SIA2 collections holding wide-survey spectral image MEFs, in priority order.
#: Found with ``Irsa.list_collections(servicetype="SIA", filter="spherex")``.
#: As of November 2026 the service lists: spherex_dr1, spherex_dr1_deep,
#: spherex_dr1_cube, spherex_qr3, spherex_qr3_deep.  DR1 and QR3 together make
#: up the current wide survey (the older spherex_qr / spherex_qr2 collections
#: are no longer searchable).
COLLECTIONS: list[str] = ["spherex_dr1", "spherex_qr3"]

#: Radius of the SIA2 position search.  Kept tiny: we want images that contain
#: the target itself, not images that merely pass nearby.
SIA_RADIUS_ARCSEC: float = 1.0

#: Attempts for an SIA2 search before giving up (IRSA has transient 5xx errors).
SIA_ATTEMPTS: int = 3

#: How long a cached SIA result stays valid.  IRSA ingests new data weekly.
SIA_CACHE_TTL_SECONDS: int = 24 * 3600

#: SPHEREx DR1 all-sky HiPS cube (102 wavelength frames, PNG tiles), used as
#: the explorable sky background.  Listed at https://irsa.ipac.caltech.edu/data/hips/list
HIPS_URL: str = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"

#: Number of wavelength frames in the cube.  The backend re-serves frame N as
#: an ordinary 2-D HiPS at ``/hips/N/`` (see main.py), which lets the sky
#: viewer show and stack any frames without cube support.
HIPS_DEPTH: int = 102

#: Frames that are blank in DR1 (the dichroic channels B3C17 and B4C1).
HIPS_BLANK_FRAMES: frozenset[int] = frozenset({50, 51})

#: Cube frames combined into each colour of the default sky view (served at
#: ``/hips/rgb/``).  Blue 1.25 um and green 2.19 um trace starlight; red
#: 3.29 um sits on the PAH band, so dusty star-forming clouds glow red.
#: Several frames per colour may be listed (they are averaged), but each
#: one costs an extra IRSA request per tile; averaging two barely changed
#: the result because most of the fine "grain" is real faint stars.
HIPS_RGB_FRAMES: dict[str, tuple[int, ...]] = {
    "red": (62,),    # 3.293 um
    "green": (46,),  # 2.189 um
    "blue": (22,),   # 1.254 um
}

#: Build every colour tile up to this HEALPix order in the background after
#: start-up (orders 0-3 = 1,020 tiles, a few minutes, done once; tiles are
#: cached on disk).  Wide views are then instant; closer tiles are built on
#: demand.  Set to -1 to disable.
HIPS_WARM_ORDER: int = 3

#: Concurrent tile builds used by the background warm-up.
HIPS_WARM_CONCURRENT: int = 4

#: Display levels for the colour tiles, in the HiPS tiles' own 0-255 units
#: (IRSA maps 0-40 MJy/sr onto 0-255 with an asinh curve; the sky background
#: sits near 36).
HIPS_RGB_BLACK: float = 42.0
HIPS_RGB_WHITE: float = 235.0

#: Simultaneous tile downloads for the colour sky (separate from cutouts, so
#: browsing the sky never stalls a blink).
HIPS_MAX_CONCURRENT: int = 8

#: Connections sky tiles may use while blink cutouts are downloading.
HIPS_SHARE_WHILE_BLINKING: int = 2

# --------------------------------------------------------------------------
# Frame geometry
# --------------------------------------------------------------------------

#: Field of view of every frame, in degrees.  Fixed by design.
FOV_DEG: float = 0.1

#: Pixel scale of the common output grid (SPHEREx native scale), arcsec/pixel.
PIXEL_SCALE_ARCSEC: float = 6.15

#: Server-side cutouts are requested this much larger than ``FOV_DEG`` so the
#: north-up grid stays fully covered whatever the detector's roll angle
#: (a square rotated by 45 degrees needs sqrt(2); the rest is margin).
CUTOUT_PADDING: float = 1.5


def grid_size() -> int:
    """Side length of the output grid in pixels (odd, so the target is centred on a pixel)."""
    n = int(round(FOV_DEG * 3600.0 / PIXEL_SCALE_ARCSEC))
    return n if n % 2 == 1 else n + 1


# --------------------------------------------------------------------------
# Network behaviour
# --------------------------------------------------------------------------

#: Maximum number of simultaneous cutout downloads from IRSA.
MAX_CONCURRENT_DOWNLOADS: int = 6

#: Per-attempt timeouts, seconds.
CONNECT_TIMEOUT: float = 15.0
READ_TIMEOUT: float = 45.0

#: Attempts per cutout before the frame is reported as failed.  IRSA answers
#: "503 Server busy" (with a Retry-After header) fairly often under load.
MAX_ATTEMPTS: int = 7

#: Wait before the first retry, seconds; doubles on each further attempt.
RETRY_BASE_WAIT: float = 0.4

#: Upper bound on a single wait between attempts, seconds.
MAX_RETRY_WAIT: float = 8.0

# --------------------------------------------------------------------------
# Display
# --------------------------------------------------------------------------

#: Robust percentiles and asinh strength used for the server-rendered PNG.
STRETCH_LOW_PERCENTILE: float = 1.0
STRETCH_HIGH_PERCENTILE: float = 99.5
STRETCH_ASINH_STRENGTH: float = 10.0

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

BACKEND_DIR: Path = Path(__file__).resolve().parent
CACHE_DIR: Path = BACKEND_DIR / "cache"
FRONTEND_DIR: Path = BACKEND_DIR.parent / "frontend"
