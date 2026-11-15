"""Coordinate parsing."""

import pytest

from backend.data_access import CoordinateError, parse_coordinates

WISE0855_RA = 133.795129
WISE0855_DEC = -7.245147


@pytest.mark.parametrize(
    "ra, dec",
    [
        ("133.795129", "-7.245147"),
        ("08h55m10.831s", "-07d14m42.53s"),
        ("08:55:10.831", "-07:14:42.53"),
        ("  08 55 10.831 ", " -07 14 42.53 "),
    ],
)
def test_accepted_formats_agree(ra: str, dec: str) -> None:
    coord = parse_coordinates(ra, dec)
    assert coord.ra.deg == pytest.approx(WISE0855_RA, abs=2e-6)
    assert coord.dec.deg == pytest.approx(WISE0855_DEC, abs=2e-6)


def test_plain_number_ra_is_degrees_not_hours() -> None:
    assert parse_coordinates("10", "0").ra.deg == pytest.approx(10.0)
    assert parse_coordinates("10h", "0").ra.deg == pytest.approx(150.0)


def test_result_is_rounded_for_stable_cache_keys() -> None:
    coord = parse_coordinates("10.12345678", "20.87654321")
    assert coord.ra.deg == pytest.approx(10.123457, abs=1e-9)
    assert coord.dec.deg == pytest.approx(20.876543, abs=1e-9)


@pytest.mark.parametrize(
    "ra, dec",
    [
        ("", "10"),
        ("10", ""),
        ("abc", "10"),
        ("10", "north"),
        ("361", "0"),
        ("25h", "0"),
        ("10", "91"),
        ("10", "-90.5"),
        ("nan", "0"),
    ],
)
def test_invalid_input_raises_clear_error(ra: str, dec: str) -> None:
    with pytest.raises(CoordinateError) as excinfo:
        parse_coordinates(ra, dec)
    assert str(excinfo.value)
