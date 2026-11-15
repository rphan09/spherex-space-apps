"""Build ``frontend/presets.json``: the targets shown on the sky and in the target list.

Run once, offline from the app:  ``python -m backend.scripts.build_presets``

Positions are resolved with SIMBAD (ICRS, epoch J2000) together with proper
motion, parallax and radial velocity, then propagated to ``TARGET_EPOCH`` with
astropy's ``apply_space_motion``.  The app never queries SIMBAD at runtime.

Two kinds of entry are not resolved by name:

* WISE 0855-0714, whose position is fixed by the challenge text (see
  ``WISE0855`` for the epoch it is assumed to refer to);
* the SPHEREx deep fields at the north and south ecliptic poles, computed
  from the ecliptic frame.
"""

from __future__ import annotations

import json
from pathlib import Path

import astropy.units as u
from astropy.coordinates import BarycentricMeanEcliptic, Distance, SkyCoord
from astropy.time import Time
from astroquery.simbad import Simbad

TARGET_EPOCH = Time(2025.5, format="jyear")
#: SIMBAD host. The Harvard mirror is used because the CDS server was
#: unreachable when the presets were built; set to None for astroquery's default.
SIMBAD_SERVER: str | None = "simbad.harvard.edu"
OUTPUT = Path(__file__).resolve().parents[2] / "frontend" / "presets.json"

#: Category ids, in display order, with their labels.
CATEGORIES = {
    "movers": "Fast movers",
    "variables": "Variable stars",
    "sights": "Nebulae & galaxies",
    "deep": "SPHEREx deep fields",
}

#: (display name, SIMBAD identifier, category, one-line description, challenge test target?)
SIMBAD_TARGETS: list[tuple[str, str, str, str, bool]] = [
    ("Barnard's Star", "Barnard's Star", "movers",
     "Red dwarf 6 light-years away. It has the largest proper motion of any star: 10.4″ a year.", True),
    ("Epsilon Indi B", "eps Ind B", "movers",
     "A pair of brown dwarfs 12 light-years away, crossing the sky at 4.7″ a year.", True),
    ("Proxima Centauri", "Proxima Centauri", "movers",
     "The nearest star to the Sun, 4.2 light-years away. Moves 3.9″ a year.", False),
    ("RW Aurigae", "RW Aur", "variables",
     "Young T Tauri star that dims and recovers as dust from its disk passes in front of it.", True),
    ("R Draconis", "R Dra", "variables",
     "Pulsating red giant (a Mira variable) whose brightness swings over about 245 days.", True),
    ("Mira", "omi Cet", "variables",
     "The prototype long-period variable. It pulsates over about 332 days.", False),
    ("Orion Nebula", "M 42", "sights",
     "The nearest large star-forming region, about 1,300 light-years away.", False),
    ("Galactic Centre", "Sgr A*", "sights",
     "Sagittarius A*, the Milky Way's central black hole, behind dust that infrared light gets through.", False),
    ("Andromeda Galaxy", "M 31", "sights",
     "Core of the nearest large spiral galaxy, 2.5 million light-years away.", False),
    ("Tarantula Nebula", "30 Dor", "sights",
     "The most active star-forming region in the Large Magellanic Cloud.", False),
    ("Crab Nebula", "M 1", "sights",
     "Debris of a supernova that was seen from Earth in 1054.", False),
    ("Eta Carinae", "eta Car", "sights",
     "A massive, unstable binary star inside the nebula it threw off in the 1840s.", False),
    ("Rho Ophiuchi", "rho Oph", "sights",
     "One of the closest star-forming clouds to the Sun.", False),
]

#: WISE 0855-0714: position given by the challenge.  It equals the object's
#: WISE designation (J085510.83-071442.5), i.e. the WISE All-Sky position from
#: the single May 2010 visit, so it is treated as epoch 2010.35.  Checks made
#: when this was written: the AllWISE position (mean epoch 2010.59) lies 1.3
#: arcsec to the west, as expected for 8.1 arcsec/yr of westward motion; and
#: SPHEREx D6 frames show a 4.4-4.8 micron excess at the propagated position.
WISE0855 = {
    "name": "WISE 0855-0714",
    "coord": "08h55m10.831s -07d14m42.53s",
    "epoch": 2010.35,
    "pmra": -8123.7,  # mas/yr (mu_alpha * cos(dec)), Kirkpatrick et al. 2021
    "pmdec": 673.2,  # mas/yr
    "plx": 439.0,  # mas
    "category": "movers",
    "description": "The coldest brown dwarf known, 7.4 light-years away. Moves 8.1″ a year.",
}

DEEP_FIELDS = [
    ("North Ecliptic Pole", +90.0,
     "SPHEREx deep field. The spacecraft passes over the ecliptic poles on every orbit, so this patch "
     "is observed far more often than anywhere else."),
    ("South Ecliptic Pole", -90.0,
     "SPHEREx's southern deep field, observed on every orbit like its northern twin."),
]


def _value(row, name: str, default: float = 0.0) -> float:
    """Return a float column value, or ``default`` when SIMBAD has none."""
    value = row[name]
    if value is None or getattr(value, "mask", False) is True or str(value) in ("--", "nan"):
        return default
    return float(value)


def propagate(coord: SkyCoord) -> SkyCoord:
    """Propagate a coordinate with space motion to ``TARGET_EPOCH``."""
    return coord.apply_space_motion(new_obstime=TARGET_EPOCH)


def resolve_simbad(identifier: str) -> tuple[SkyCoord, dict]:
    """Resolve ``identifier`` with SIMBAD; return its J2000 coordinate and raw astrometry."""
    simbad = Simbad()
    if SIMBAD_SERVER:
        simbad.server = SIMBAD_SERVER
    simbad.add_votable_fields("pmra", "pmdec", "plx_value", "rvz_radvel", "coo_bibcode")
    table = simbad.query_object(identifier)
    if table is None or len(table) == 0:
        raise RuntimeError(f"SIMBAD could not resolve {identifier!r}")
    row = table[0]
    astrometry = {
        "pmra_masyr": _value(row, "pmra"),
        "pmdec_masyr": _value(row, "pmdec"),
        "parallax_mas": _value(row, "plx_value"),
        "rv_kms": _value(row, "rvz_radvel"),
        "simbad_coo_bibcode": str(row["coo_bibcode"]),
    }
    kwargs = {}
    if astrometry["parallax_mas"] > 0:
        kwargs["distance"] = Distance(parallax=astrometry["parallax_mas"] * u.mas)
        kwargs["radial_velocity"] = astrometry["rv_kms"] * u.km / u.s
    coord = SkyCoord(
        ra=float(row["ra"]) * u.deg,
        dec=float(row["dec"]) * u.deg,
        pm_ra_cosdec=astrometry["pmra_masyr"] * u.mas / u.yr,
        pm_dec=astrometry["pmdec_masyr"] * u.mas / u.yr,
        obstime=Time("J2000"),
        frame="icrs",
        **kwargs,
    )
    return coord, astrometry


def entry(name: str, coord: SkyCoord, category: str, description: str, source: str,
          test_target: bool = False, astrometry: dict | None = None) -> dict:
    """Build one preset entry from an already-propagated coordinate."""
    return {
        "name": name,
        "ra": round(float(coord.ra.deg), 6),
        "dec": round(float(coord.dec.deg), 6),
        "category": category,
        "description": description,
        "test_target": test_target,
        "epoch": "J2025.5",
        "source": source,
        **(astrometry or {}),
    }


def wise0855() -> dict:
    """The WISE 0855 entry, propagated from its assumed epoch."""
    base = SkyCoord(
        WISE0855["coord"],
        pm_ra_cosdec=WISE0855["pmra"] * u.mas / u.yr,
        pm_dec=WISE0855["pmdec"] * u.mas / u.yr,
        distance=Distance(parallax=WISE0855["plx"] * u.mas),
        radial_velocity=0 * u.km / u.s,
        obstime=Time(WISE0855["epoch"], format="jyear"),
        frame="icrs",
    )
    moved = propagate(base)
    shift = base.separation(SkyCoord(moved.ra, moved.dec)).arcsec
    print(f"WISE 0855 -> J2025.5 {moved.ra.deg:.6f} {moved.dec.deg:+.6f} (moved {shift:.2f} arcsec)")
    return entry(
        WISE0855["name"], moved, WISE0855["category"], WISE0855["description"],
        f"Challenge position (epoch {WISE0855['epoch']}), propagated", test_target=True,
        astrometry={"pmra_masyr": WISE0855["pmra"], "pmdec_masyr": WISE0855["pmdec"],
                    "parallax_mas": WISE0855["plx"], "rv_kms": 0.0},
    )


def main() -> None:
    presets = []
    for name, identifier, category, description, test_target in SIMBAD_TARGETS:
        coord, astrometry = resolve_simbad(identifier)
        moved = propagate(coord)
        shift = coord.separation(SkyCoord(moved.ra, moved.dec)).arcsec
        print(f"{name:18s} J2000 {coord.ra.deg:.6f} {coord.dec.deg:+.6f} -> "
              f"J2025.5 {moved.ra.deg:.6f} {moved.dec.deg:+.6f}  (moved {shift:.2f} arcsec)")
        presets.append(entry(name, moved, category, description,
                             f"SIMBAD ({identifier}), propagated from J2000", test_target, astrometry))
        if name == "Epsilon Indi B":
            presets.append(wise0855())

    for name, latitude, description in DEEP_FIELDS:
        pole = SkyCoord(lon=0 * u.deg, lat=latitude * u.deg, frame=BarycentricMeanEcliptic()).icrs
        print(f"{name:18s} {pole.ra.deg:.6f} {pole.dec.deg:+.6f}")
        presets.append(entry(name, pole, "deep", description, "Ecliptic pole (J2000 mean ecliptic)"))

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({"categories": CATEGORIES, "targets": presets}, indent=2) + "\n",
                      encoding="utf-8")
    print(f"wrote {len(presets)} targets to {OUTPUT}")


if __name__ == "__main__":
    main()
