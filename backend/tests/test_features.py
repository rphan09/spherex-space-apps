"""Data-release discovery, quality flags, float16 transfer and the frame stream."""

import json
import struct

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import config, data_access, main, processing


def test_new_releases_are_picked_up_and_ordered() -> None:
    found = ["spherex_qr3", "spherex_dr1_deep", "spherex_dr1", "spherex_dr1_cube",
             "spherex_qr3_deep", "spherex_dr2", "spherex_qr4", "not_spherex"]
    assert data_access.pick_collections(found) == ["spherex_dr2", "spherex_dr1", "spherex_qr4", "spherex_qr3"]


def test_flag_table_matches_explanatory_supplement() -> None:
    names = {bit: name for bit, (name, _d, _c) in processing.FLAG_BITS.items()}
    assert names[0] == "TRANSIENT" and names[6] == "NONFUNC" and names[17] == "PERSIST"
    assert names[21] == "SOURCE" and names[29] == "SATELLITE_HALO"
    categories = {cid for cid, _ in processing.FLAG_CATEGORIES}
    assert len(processing.FLAG_CATEGORIES) <= 8  # packed into one byte
    assert {c for _n, _d, c in processing.FLAG_BITS.values()} - {"info"} <= categories


def test_flag_category_mask_and_center_flags() -> None:
    flags = np.zeros((9, 9), dtype=np.uint32)
    flags[4, 4] = (1 << 0) | (1 << 21)   # TRANSIENT + SOURCE at the centre
    flags[0, 0] = 1 << 17                # PERSIST in a corner
    flags[5, 4] = 1 << 12                # FULLSAMPLE: informational only
    mask = processing.flag_category_mask(flags)
    order = [cid for cid, _ in processing.FLAG_CATEGORIES]
    assert mask[4, 4] == (1 << order.index("cosmic")) | (1 << order.index("source"))
    assert mask[0, 0] == 1 << order.index("persist")
    assert mask[5, 4] == 0
    assert processing.flags_at_center(flags) == ["TRANSIENT", "FULLSAMPLE", "SOURCE"]


def test_float16_keeps_nan_and_clips_overflow() -> None:
    data = np.array([[1.5, np.nan], [1e6, -0.25]], dtype=np.float32)
    back = np.frombuffer(processing.encode_float16(data), dtype="<f2").reshape(2, 2)
    assert back[0, 0] == 1.5 and np.isnan(back[0, 1]) and back[1, 1] == -0.25
    assert np.isfinite(back[1, 0]) and back[1, 0] > 6e4


def _record(i: int, detector: int) -> data_access.ImageRecord:
    return data_access.ImageRecord(
        id=f"obs{i}D{detector}", collection="spherex_dr1", obs_id=f"obs{i}", detector=detector,
        mjd=61000.0 + i, date_iso="2026-01-01T00:00:00Z", wavelength_min_um=1.0, wavelength_max_um=1.5,
        exposure_s=100.0, access_url="https://example.invalid/x.fits")


def _parse_stream(blob: bytes) -> list[tuple[dict, bytes]]:
    out, pos = [], 0
    while pos < len(blob):
        head_len, payload_len = struct.unpack_from("<II", blob, pos)
        pos += 8
        header = json.loads(blob[pos:pos + head_len])
        pos += head_len
        out.append((header, blob[pos:pos + payload_len]))
        pos += payload_len
    return out


def test_stream_sends_every_frame_then_done(monkeypatch: pytest.MonkeyPatch) -> None:
    records = [_record(1, 1), _record(2, 3), _record(3, 6)]
    n = config.grid_size()

    async def fake_search(_coord):
        return records

    async def fake_load(record, _coord, _fov):
        if record.detector == 6:
            raise data_access.ArchiveError("IRSA cutout failed")
        data = np.full((n, n), float(record.detector), dtype=np.float32)
        flags = np.zeros((n, n), dtype=np.uint32)
        flags[0, 0] = 1  # TRANSIENT
        return data, flags, {"id": record.id, "detector": record.detector}, False

    monkeypatch.setattr(main, "_search", fake_search)
    monkeypatch.setattr(main, "_load_frame", fake_load)
    client = TestClient(main.app)
    response = client.post("/api/stream", json={"ra": "10", "dec": "20",
                                                "ids": ["obs2D3", "obs1D1", "obs3D6", "unknown"]})
    assert response.status_code == 200
    messages = _parse_stream(response.content)
    assert messages[-1][0] == {"done": True}
    frames = {h["id"]: (h, p) for h, p in messages[:-1]}
    assert set(frames) == {"obs1D1", "obs2D3", "obs3D6"}  # unknown id ignored
    header, payload = frames["obs2D3"]
    assert header["ok"] and header["width"] == n
    pixels = np.frombuffer(payload[: n * n * 2], dtype="<f2")
    mask = np.frombuffer(payload[n * n * 2:], dtype=np.uint8)
    assert pixels[0] == 3.0 and len(mask) == n * n and mask[0] == 1
    assert frames["obs3D6"][0]["ok"] is False and "IRSA" in frames["obs3D6"][0]["error"]


def test_bad_field_of_view_is_rejected() -> None:
    client = TestClient(main.app)
    response = client.get("/api/search", params={"ra": "10", "dec": "20", "fov": 0.7})
    assert response.status_code == 400 and "Field of view" in response.json()["detail"]
