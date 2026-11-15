"""Reprojection onto the fixed north-up grid."""

import astropy.units as u
import numpy as np
import pytest
from astropy.coordinates import SkyCoord
from astropy.wcs import WCS

from backend import config, processing

TARGET = SkyCoord(133.76, -7.24, unit="deg")


def rotated_image(angle_deg: float, source: SkyCoord, size: int = 91) -> tuple[np.ndarray, WCS]:
    """A synthetic detector cutout at a given roll angle with one Gaussian star."""
    scale = config.PIXEL_SCALE_ARCSEC / 3600.0
    theta = np.radians(angle_deg)
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [TARGET.ra.deg + 0.004, TARGET.dec.deg - 0.003]  # not centred on the target
    wcs.wcs.crpix = [size / 2.0, size / 2.0]
    wcs.wcs.cdelt = [-scale, scale]
    wcs.wcs.pc = [[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]]
    x0, y0 = wcs.world_to_pixel(source)
    yy, xx = np.mgrid[0:size, 0:size]
    image = 5.0 + 100.0 * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * 1.2**2))
    return image.astype(np.float32), wcs


def test_grid_is_fixed_north_up_east_left() -> None:
    wcs, shape = processing.target_wcs(TARGET)
    n = config.grid_size()
    assert shape == (n, n)
    assert n % 2 == 1
    assert n * config.PIXEL_SCALE_ARCSEC / 3600.0 == pytest.approx(config.FOV_DEG, abs=0.002)

    centre = n // 2
    assert wcs.pixel_to_world(centre, centre).separation(TARGET).arcsec < 1e-6
    # +y is north, +x is west (so east is on the left).
    assert wcs.pixel_to_world(centre, centre + 1).dec > TARGET.dec
    assert wcs.pixel_to_world(centre + 1, centre).ra < TARGET.ra

    again, _ = processing.target_wcs(TARGET)
    assert wcs.to_header() == again.to_header()


@pytest.mark.parametrize("angle", [0.0, 37.0, 90.0, 163.5, 251.0])
def test_source_lands_on_same_pixel_at_any_roll_angle(angle: float) -> None:
    # A star 30 arcsec north and 42 arcsec east of the target.
    star = TARGET.spherical_offsets_by(42 * u.arcsec, 30 * u.arcsec)
    image, wcs = rotated_image(angle, star)
    header = wcs.to_header()

    frame = processing.process_cutout(image, np.full_like(image, 5.0), header, TARGET)

    n = config.grid_size()
    assert frame.shape == (n, n)
    assert np.isfinite(frame).all(), "padded cutout should cover the whole grid"
    row, col = np.unravel_index(np.nanargmax(frame), frame.shape)
    centre = n // 2
    # Display orientation: north is up (smaller row), east is left (smaller column).
    assert row == centre - round(30 / config.PIXEL_SCALE_ARCSEC)
    assert col == centre - round(42 / config.PIXEL_SCALE_ARCSEC)
    # The zodi model (constant 5) was subtracted.
    assert np.nanmedian(frame) == pytest.approx(0.0, abs=1e-3)


def test_cutout_without_coverage_is_rejected() -> None:
    far = SkyCoord(TARGET.ra + 2 * u.deg, TARGET.dec)
    image, wcs = rotated_image(20.0, TARGET)
    with pytest.raises(ValueError):
        processing.process_cutout(image, np.zeros_like(image), wcs.to_header(), far)


def test_png_is_valid_and_grid_sized() -> None:
    import io

    from PIL import Image

    data = np.random.default_rng(1).normal(size=(config.grid_size(),) * 2).astype(np.float32)
    data[0, 0] = np.nan
    picture = Image.open(io.BytesIO(processing.to_png(data)))
    assert picture.size == (config.grid_size(), config.grid_size())
    assert picture.mode == "L"
