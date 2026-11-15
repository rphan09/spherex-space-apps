"""Live IRSA query. Needs network access; skip with ``pytest -m "not network"``."""

import pytest

from backend import config
from backend.data_access import parse_coordinates, query_sia


@pytest.mark.network
def test_sia_query_wise0855() -> None:
    coord = parse_coordinates("08h55m10.831s", "-07d14m42.53s")
    records = query_sia(coord)

    assert len(records) > 0, "expected SPHEREx coverage of WISE 0855"
    assert [r.mjd for r in records] == sorted(r.mjd for r in records)
    assert len({r.id for r in records}) == len(records)
    for record in records:
        assert record.collection in config.COLLECTIONS
        assert 1 <= record.detector <= 6
        assert record.id.endswith(f"D{record.detector}")
        assert record.mjd > 60000  # after launch (2025)
        assert record.access_url.startswith("https://irsa.ipac.caltech.edu/")
        assert record.access_url.endswith(".fits")
