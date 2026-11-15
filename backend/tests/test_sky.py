"""All-sky map helpers: tile naming per cube frame and the colour compositor."""

import io

import numpy as np
from PIL import Image

from backend import config, processing
from backend.data_access import HIPS_RGB_TILE_RE, hips_tile_url


def test_frame_zero_has_no_suffix_and_others_do() -> None:
    assert hips_tile_url(0, "Norder3/Dir0/Npix12.png") == f"{config.HIPS_URL}/Norder3/Dir0/Npix12.png"
    assert hips_tile_url(46, "Norder5/Dir10000/Npix10123.png") == \
        f"{config.HIPS_URL}/Norder5/Dir10000/Npix10123_46.png"
    assert hips_tile_url(7, "Norder3/Allsky.png") == f"{config.HIPS_URL}/Norder3/Allsky_7.png"


def test_only_tile_paths_are_redirected() -> None:
    for bad in ("properties", "../secret", "Norder3/Dir0/Npix1.png?x=1", "Norder3/Dir0/Npix1_4.png", "index.html"):
        assert hips_tile_url(3, bad) is None
    assert HIPS_RGB_TILE_RE.match("Norder4/Dir0/Npix77.jpg")
    assert not HIPS_RGB_TILE_RE.match("Norder4/Dir0/Npix77.png")


def test_rgb_frames_avoid_blank_dichroic_channels() -> None:
    used = {frame for frames in config.HIPS_RGB_FRAMES.values() for frame in frames}
    assert not used & config.HIPS_BLANK_FRAMES
    assert all(0 <= frame < config.HIPS_DEPTH for frame in used)


def test_composite_colours_and_missing_tiles() -> None:
    shape = (16, 16)
    bright = np.full(shape, 230.0, dtype=np.float32)
    dark = np.zeros(shape, dtype=np.float32)
    jpeg = processing.composite_rgb({"red": [bright, None], "green": [dark], "blue": [None]})
    pixels = np.asarray(Image.open(io.BytesIO(jpeg)).convert("RGB")).astype(int)
    assert pixels.shape == (16, 16, 3)
    assert pixels[..., 0].mean() > 200      # red from the one present tile
    assert pixels[..., 1].mean() < 10       # green below the black point
    assert pixels[..., 2].mean() < 10       # blue had no tiles at all


def test_saturated_core_is_filled() -> None:
    tile = np.zeros((9, 9), dtype=np.float32)
    tile[3:6, 3:6] = 250.0
    tile[4, 4] = 0.0  # blank core inside a bright star
    jpeg = processing.composite_rgb({"red": [tile], "green": [tile], "blue": [tile]})
    pixels = np.asarray(Image.open(io.BytesIO(jpeg)).convert("L")).astype(int)
    assert pixels[4, 4] > 200
