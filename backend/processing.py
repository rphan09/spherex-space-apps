"""Image processing: background subtraction, reprojection and display stretch.

Nothing in this module touches the network.
"""

from __future__ import annotations

import io

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_interp
from scipy.ndimage import maximum_filter

from . import config


def subtract_background(image: np.ndarray, zodi: np.ndarray) -> np.ndarray:
    """Subtract the modelled zodiacal light (ZODI extension) from the IMAGE extension."""
    return np.asarray(image, dtype=np.float32) - np.asarray(zodi, dtype=np.float32)


def target_wcs(coord: SkyCoord, fov: float = config.FOV_DEG) -> tuple[WCS, tuple[int, int]]:
    """Return the common output grid: north up, east left, centred on ``coord``.

    The grid is a gnomonic (TAN) projection whose reference pixel is the
    central pixel.  It depends only on ``coord``, ``fov`` and constants in
    ``config``, so every frame of a position shares exactly the same grid.

    Returns:
        ``(wcs, (ny, nx))``
    """
    n = config.grid_size(fov)
    scale = config.PIXEL_SCALE_ARCSEC / 3600.0
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.cunit = ["deg", "deg"]
    wcs.wcs.crval = [coord.ra.deg, coord.dec.deg]
    wcs.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]  # 1-based centre of the central pixel
    wcs.wcs.cdelt = [-scale, scale]  # RA decreases with x: east is to the left
    wcs.wcs.radesys = "ICRS"
    return wcs, (n, n)


def reproject_to_grid(data: np.ndarray, source_wcs: WCS, coord: SkyCoord,
                      fov: float = config.FOV_DEG, order: str = "bilinear") -> np.ndarray:
    """Resample ``data`` onto the common grid of ``target_wcs(coord, fov)``.

    Pixels with no input coverage are NaN.

    Returns:
        A float array in FITS orientation (row 0 is the southern edge).
    """
    wcs_out, shape_out = target_wcs(coord, fov)
    result, _footprint = reproject_interp(
        (data, source_wcs), wcs_out, shape_out=shape_out, order=order
    )
    return result


def process_cutout(image: np.ndarray, zodi: np.ndarray, header: fits.Header,
                   coord: SkyCoord, fov: float = config.FOV_DEG) -> np.ndarray:
    """Turn a raw cutout into an aligned, background-subtracted frame.

    Args:
        image: IMAGE extension of the cutout (MJy/sr).
        zodi: ZODI extension of the cutout (MJy/sr).
        header: IMAGE header, carrying the celestial WCS (TAN-SIP).
        coord: Requested position; the centre of the output grid.
        fov: Field of view of the output grid, degrees.

    Returns:
        A float32 ``(n, n)`` array in *display* orientation: row 0 is the
        northern edge, column 0 the eastern edge.  NaN marks missing data.

    Raises:
        ValueError: if the cutout does not cover the output grid at all.
    """
    subtracted = subtract_background(image, zodi)
    gridded = reproject_to_grid(subtracted, WCS(header), coord, fov).astype(np.float32)
    if not np.isfinite(gridded).any():
        raise ValueError("The image has no valid pixels at this position")
    return np.flipud(gridded).copy()


# --------------------------------------------------------------------------
# Quality flags (FLAGS extension)
# --------------------------------------------------------------------------

#: Spectral-image pixel flags, from Table 16 of the SPHEREx Explanatory
#: Supplement (v2.0, 2026-08-25): bit -> (name, short description, category).
#: Categories group the flags for display; "info" flags are not problems.
FLAG_BITS: dict[int, tuple[str, str, str]] = {
    0: ("TRANSIENT", "Transient such as a cosmic-ray hit during the exposure", "cosmic"),
    1: ("OVERFLOW", "Reached about half of full-well saturation", "cosmic"),
    2: ("SUR_ERROR", "Onboard processing error, or early transient/overflow", "cosmic"),
    6: ("NONFUNC", "Permanently dead pixel", "bad"),
    7: ("DICHROIC", "Low-throughput corner of bands 3-4", "bad"),
    9: ("MISSING_DATA", "Onboard data lost", "bad"),
    10: ("HOT", "Hot or noisy pixel", "bad"),
    11: ("COLD", "Pixel unresponsive to light", "bad"),
    12: ("FULLSAMPLE", "Full sample history available", "info"),
    14: ("PHANMISS", "Could not be corrected with phantom pixels", "bad"),
    15: ("NONLINEAR", "No reliable non-linearity correction", "bad"),
    17: ("PERSIST", "Persistent signal from an earlier bright exposure", "persist"),
    19: ("OUTLIER", "Statistical outlier pixel", "outlier"),
    20: ("CROSSTALK", "Electronic crosstalk", "ghost"),
    21: ("SOURCE", "Pixel on a known catalogued source", "info"),
    22: ("GHOST", "Optical ghost", "ghost"),
    23: ("GHOST_FPA", "Optical ghost from the focal plane", "ghost"),
    24: ("GHOST_EXT", "Optical ghost from outside the field", "ghost"),
    25: ("STREAK", "Satellite or other streak", "satellite"),
    26: ("BLOOM", "Charge spill-over from a bright source", "bloom"),
    27: ("SNOWBALL", "Snowball or large cosmic-ray event", "cosmic"),
    28: ("HALO", "Halo of a cosmic ray or snowball", "cosmic"),
    29: ("SATELLITE_HALO", "Halo of a satellite streak", "satellite"),
}

#: Display categories, packed one per bit into the uint8 mask sent to the browser.
FLAG_CATEGORIES: tuple[tuple[str, str], ...] = (
    ("cosmic", "Cosmic rays and snowballs"),
    ("bad", "Bad or unreliable pixels"),
    ("persist", "Persistence"),
    ("ghost", "Ghosts and crosstalk"),
    ("satellite", "Satellite streaks"),
    ("outlier", "Outliers"),
    ("bloom", "Blooming from bright sources"),
    ("source", "Known source (not a problem)"),
)


def _category_masks() -> list[int]:
    """For each display category, the FLAGS bits that belong to it."""
    masks = []
    for category, _label in FLAG_CATEGORIES:
        if category == "source":
            masks.append(1 << 21)
            continue
        masks.append(sum(1 << bit for bit, (_n, _d, cat) in FLAG_BITS.items() if cat == category))
    return masks


_CATEGORY_MASKS = _category_masks()


def reproject_flags(flags: np.ndarray, header: fits.Header, coord: SkyCoord,
                    fov: float = config.FOV_DEG) -> np.ndarray:
    """Put the FLAGS bitmap on the common grid (nearest neighbour, display orientation)."""
    gridded = reproject_to_grid(flags.astype(np.float64), WCS(header), coord, fov, order="nearest-neighbor")
    gridded = np.nan_to_num(np.flipud(gridded), nan=0.0)
    return gridded.astype(np.uint32)


def flag_category_mask(flags: np.ndarray) -> np.ndarray:
    """Compress a FLAGS grid to one byte per pixel: bit i = category i of ``FLAG_CATEGORIES``."""
    out = np.zeros(flags.shape, dtype=np.uint8)
    for index, mask in enumerate(_CATEGORY_MASKS):
        out |= ((flags & mask) != 0).astype(np.uint8) << index
    return out


def flags_at_center(flags: np.ndarray, radius: int = 1) -> list[str]:
    """Names of the flags set on any pixel within ``radius`` of the grid centre."""
    c = flags.shape[0] // 2
    combined = int(np.bitwise_or.reduce(flags[c - radius:c + radius + 1, c - radius:c + radius + 1], axis=None))
    return [name for bit, (name, _d, _c) in sorted(FLAG_BITS.items()) if combined & (1 << bit)]


def encode_float16(data: np.ndarray) -> bytes:
    """Little-endian IEEE half floats (NaN preserved).  Halves the transfer size;
    relative precision is 1 in 2048, far below the noise of a single frame."""
    clipped = np.clip(data, -65000.0, 65000.0)  # float16 tops out at 65504; NaN passes through
    return np.ascontiguousarray(clipped, dtype="<f2").tobytes()


def stretch(data: np.ndarray,
            low_percentile: float = config.STRETCH_LOW_PERCENTILE,
            high_percentile: float = config.STRETCH_HIGH_PERCENTILE,
            asinh_strength: float = config.STRETCH_ASINH_STRENGTH) -> np.ndarray:
    """Scale ``data`` to 0..1 between robust percentiles, with an asinh curve.

    ``asinh_strength`` of 0 gives a linear stretch.  NaNs map to 0.
    """
    finite = data[np.isfinite(data)]
    if finite.size == 0:
        return np.zeros(data.shape, dtype=np.float32)
    low, high = np.percentile(finite, [low_percentile, high_percentile])
    if not high > low:
        high = low + 1.0
    scaled = np.clip((np.nan_to_num(data, nan=low) - low) / (high - low), 0.0, 1.0)
    if asinh_strength > 0:
        scaled = np.arcsinh(asinh_strength * scaled) / np.arcsinh(asinh_strength)
    return scaled.astype(np.float32)


def decode_tile(data: bytes | None) -> np.ndarray | None:
    """Decode an IRSA HiPS PNG tile (palette or greyscale) to float32 values 0-255."""
    if data is None:
        return None
    with Image.open(io.BytesIO(data)) as picture:
        return np.asarray(picture.convert("L"), dtype=np.float32)


def composite_rgb(channels: dict[str, list[np.ndarray | None]],
                  black: float = config.HIPS_RGB_BLACK,
                  white: float = config.HIPS_RGB_WHITE) -> bytes:
    """Combine single-wavelength HiPS tiles into one colour JPEG tile.

    Args:
        channels: For "red", "green" and "blue", the tiles to average (missing
            tiles are ``None`` and ignored).  All present tiles share a shape.
        black, white: Display levels in the tiles' 0-255 units.

    Returns:
        JPEG bytes.  A colour with no tiles at all is left black.
    """
    shape = next(tile.shape for tiles in channels.values() for tile in tiles if tile is not None)
    planes = []
    for colour in ("red", "green", "blue"):
        present = [tile for tile in channels.get(colour, []) if tile is not None]
        if not present:
            planes.append(np.zeros(shape, dtype=np.uint8))
            continue
        mean = np.mean(present, axis=0)
        # Saturated star cores are blank (0) in the tiles; inside a bright
        # neighbourhood, fill them from their brightest neighbour.
        neighbourhood = maximum_filter(mean, size=3)
        mean = np.where((mean <= 0) & (neighbourhood > 0.7 * white), neighbourhood, mean)
        scaled = np.clip((mean - black) / (white - black), 0.0, 1.0)
        planes.append(np.round(np.sqrt(scaled) * 255.0).astype(np.uint8))
    buffer = io.BytesIO()
    Image.fromarray(np.dstack(planes), mode="RGB").save(buffer, format="JPEG", quality=88)
    return buffer.getvalue()


def to_png(data: np.ndarray) -> bytes:
    """Render a display-orientation frame as an 8-bit greyscale PNG."""
    pixels = np.round(stretch(data) * 255.0).astype(np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(pixels, mode="L").save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()
