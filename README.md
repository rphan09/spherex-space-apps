# SPHEREx Blink

Fly around the infrared sky as NASA's SPHEREx mission sees it. Click any star,
nebula or empty patch, and the app plays every SPHEREx image of that 0.1° spot
as a looping "blink" animation in time order, so moving and variable objects
stand out.

Every blink frame is zodiacal-light subtracted and reprojected onto the same
north-up, east-left grid centred on your position, so frames line up exactly
even though SPHEREx observes at many different roll angles.

## Requirements

- Python 3.11 or newer
- Internet access to `irsa.ipac.caltech.edu`
- A browser with WebGL 2 (any current Chrome, Edge, Firefox or Safari)

No Node.js or build step: the frontend is plain HTML, CSS and JavaScript,
served by the backend. The sky viewer (Aladin Lite 3.8.2) is bundled in
`frontend/vendor/`.

## Setup

```bash
python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

## Run

From the repository root:

```bash
uvicorn backend.main:app --port 8000
```

Then open <http://127.0.0.1:8000>.

**First start:** the server pre-builds the colour sky map in the background:
1,021 tiles, about 10 minutes, done once. The tiles are cached in
`backend/cache/hips/`. The app works during this time, but wide sky views
fill in more slowly until the pre-build finishes. The pre-build pauses
whenever a search or blink is running.

## Using it

The site opens on a start screen that explains what it is, with two buttons:
- **Take the tour:** an 11-step guided walk through every feature. It moves
  the camera and opens the blink viewer itself, so each step points at a live
  control.
- **Start exploring:** go straight to the sky.

The **?** button (top right) brings the start screen back.

**The sky**

- Drag to look around and scroll to zoom. The view drifts slowly until you
  touch it.
- **Targets** (top left) lists the challenge test targets, plus a few other
  movers, variables, showcase nebulae and galaxies, and the SPHEREx deep
  fields. Click one, or its ring on the sky, and the view flies there and
  shows a short description.
- Click anywhere else on the sky to select that spot.
- **Blink this target** / **Blink this spot** opens the blink viewer. You can
  also type coordinates at the top and press **Blink**. Both decimal degrees
  (`133.7607`, `-7.2423`) and sexagesimal (`08h55m02.6s -07d14m32s` or
  `08:55:02.6 -07:14:32`) work.
- **Colour / One wavelength** (bottom left) switches the sky between:
  - a colour image (blue 1.25 µm, green 2.19 µm, red 3.29 µm);
  - any one of the 100 SPHEREx wavelength channels, chosen with the
    spectrum slider.

**The blink viewer**

| Control | What it does |
| --- | --- |
| Play / pause, ◀ ▶ (space, ← →) | Animate or step through frames |
| fps slider | Playback speed |
| Timeline | One tick per image, placed by date and coloured by detector. Click or drag to jump |
| All · D1–D6 | Show all frames or one detector. Each detector covers its own wavelength range, so blink one at a time for a fair comparison |
| Display → Smooth / Pixels | Smooth interpolation, or crisp nearest-neighbour pixels |
| Display → Black / White point, Stretch | Display range (percentiles of each frame) and asinh strength (0 = linear) |
| Same brightness range for every frame | One shared display range instead of a per-frame one |
| − / + on the image, mouse wheel, drag | Zoom (up to 16×) and pan; double-click resets |
| Esc | Close the card or the viewer |

Frames appear as they load, and a thin bar on the image shows progress. A
frame that cannot be fetched is skipped and listed, with a **Retry failed**
button.

### Why the images look soft

That is the data, not the app. SPHEREx is a 20 cm telescope built to take
spectra of hundreds of millions of objects, not sharp pictures. Its pixels are
6.2″ wide and its point-spread function is about as wide as a pixel. A 0.1°
field is therefore only 59 × 59 pixels, which the viewer enlarges about 12
times. For comparison, WISE pixels are 2.75″ and 2MASS pixels 1″.

The viewer offers two honest renderings:
- **Smooth** (the default) interpolates between pixels.
- **Pixels** shows each SPHEREx pixel as a square.

The all-sky map has even coarser 13″ pixels, so the sky view stops zooming
at 1°.

Two display conventions:
- **White star cores:** the pipeline leaves saturated pixels empty (NaN). The
  viewer draws those white when they sit inside a star.
- **Dark blue areas:** parts of the field that no detector covered.

## API

### `GET /api/search?ra=<ra>&dec=<dec>`

Every spectral image that covers the position, sorted by observation time.
Each entry has:
- `id`, `collection`, `obs_id`, `detector`
- `mjd`, `date_iso`
- `wavelength_min_um` / `wavelength_max_um` (the detector's band)
- `exposure_s`, `access_url`

Invalid coordinates return HTTP 400 with a readable `detail` message.

### `GET /api/frame/<id>?ra=<ra>&dec=<dec>&format=png|raw`

One aligned frame, `grid_size` × `grid_size` pixels (59 × 59 at 6.15″/pixel,
which is 0.1°).

- `format=png` (default): an 8-bit greyscale PNG with an asinh stretch
  between robust percentiles, computed per frame.
- `format=raw`: little-endian float32 pixels in MJy/sr. Row 0 is north and
  NaN means no data. The frontend uses this format so it can re-stretch
  locally.

Frame metadata is returned in the `X-Frame-Meta` header as JSON. It includes
the exact wavelength at the target pixel, from the image's WCS-WAVE table.

### Sky map

- `GET /api/sky`: the all-sky map's wavelength frames.
- `GET /hips/rgb/…`: the colour sky as a HiPS (built by this server and
  cached).
- `GET /hips/<frame>/…`: one wavelength frame as a HiPS. Each tile request is
  a redirect to IRSA, so no image data passes through this server.

## How it works

```
backend/
  config.py        collections, field of view, sky-map frames, concurrency
  data_access.py   coordinate parsing, IRSA SIA2 search, cutouts, HiPS tile fetches
  processing.py    ZODI subtraction, reprojection, stretch, colour tile compositing
  sky.py           colour sky tiles: build on demand, cache, background pre-build
  main.py          FastAPI routes; also serves frontend/
  cache.py         on-disk cache helpers
  scripts/build_presets.py   one-off script that builds frontend/presets.json
  tests/
frontend/
  index.html, style.css, app.js, presets.json
  vendor/aladin-lite-3.8.2/  sky viewer (LGPL-3.0, CDS Strasbourg)
```

**Blink**

1. **Search.** `astroquery`'s `Irsa.query_sia(pos=(coord, 1″),
   collection=config.COLLECTIONS)`. If the same exposure appears in two
   releases, the copy from the collection listed first in `COLLECTIONS` is
   kept.
2. **Cutouts.** IRSA's server-side cutout service:
   `<access_url>?center=<ra>,<dec>deg&size=0.15deg`. The cutout is 1.5 × the
   0.1° field, so the north-up grid stays fully covered at any roll angle.
   Full 2040 × 2040 images are never downloaded.
3. **Download trimming.** About 97% of each 4 MB cutout response is the EPSF
   table, which the cutout service does not crop. Downloads are streamed and
   stopped when that table starts, so each frame transfers about 125 kB
   instead of 4 MB. The WCS-WAVE wavelength table comes after the EPSF, so it
   is downloaded in full only once per detector calibration and then cached.
4. **Processing.** IMAGE − ZODI, then `reproject_interp` (bilinear) onto a TAN
   grid with `CDELT1 < 0` (east left), `CDELT2 > 0` (north up) and the
   reference pixel on the requested position.
5. **Concurrency.** Cutouts are fetched with an `asyncio.Semaphore(6)`. IRSA
   answers about a third of cutout requests with `503 Server busy`, however
   slowly they are sent, and a quick retry usually works. Each request
   therefore gets up to 7 attempts with short exponential backoff (0.4 s
   doubling, capped by `Retry-After`). A frame that still fails returns HTTP
   502 and is skipped by the client.
6. **Caching.** SIA results are cached for 24 hours under
   `backend/cache/sia/`. Processed frames are cached indefinitely under
   `backend/cache/frames/<collection>/`, keyed by (collection, image id, RA,
   Dec, FoV). Delete `backend/cache/` to clear the cache.

**Sky**

- **Source map.** The sky is IRSA's SPHEREx DR1 all-sky HiPS cube, with 102
  wavelength frames and 13″ pixels. Aladin Lite can show only one frame of a
  cube at a time, and it merges layers that share a survey ID. So the backend
  re-describes each frame as an ordinary 2-D HiPS (`/hips/<frame>/`),
  redirecting tile requests to IRSA.
- **Colour tiles.** Each tile is built from three frames (1.25, 2.19 and
  3.29 µm) and saved as JPEG. Saturated star cores, which are blank in the
  source tiles, are filled from their brightest neighbour.
- **Priority.** Searches and blink cutouts come first. While either is
  running, sky-tile building uses at most 2 IRSA connections. Without this
  rule, IRSA throttles everything, and in testing a search slowed from 2 s to
  30 s.

### New data releases

The SPHEREx collection names change between releases (`spherex_qr`,
`spherex_qr2`, then the current `spherex_dr1` and `spherex_qr3`). To list
what IRSA offers now:

```python
from astroquery.ipac.irsa import Irsa
print(Irsa.list_collections(servicetype="SIA", filter="spherex"))
```

Then edit `COLLECTIONS` in `backend/config.py`. Use the wide-survey
spectral-image collections, not `_deep` or `_cube`. A new all-sky map would
need `HIPS_URL` changed too. Then delete `backend/cache/hips/` so the colour
tiles are rebuilt.

## Targets

`frontend/presets.json` was generated once by
`python -m backend.scripts.build_presets`. The app never queries SIMBAD at
runtime. Positions are propagated to epoch 2025.5 with astropy's
`apply_space_motion`, using proper motion, parallax and radial velocity where
SIMBAD has them.

The five challenge test targets are marked "test" in the list:

| Target | Source | Shift applied |
| --- | --- | --- |
| Barnard's Star | SIMBAD (Gaia DR3 astrometry), J2000 → 2025.5 | 265″ |
| Epsilon Indi B | SIMBAD, J2000 → 2025.5 | 119″ |
| WISE 0855-0714 | Challenge position, treated as epoch 2010.35, propagated with SIMBAD's proper motion and parallax | 124″ |
| RW Aurigae | SIMBAD, J2000 → 2025.5 | 0.6″ |
| R Draconis | SIMBAD, J2000 → 2025.5 | 0.6″ |

The other targets:
- Proxima Centauri and Mira
- Orion Nebula, Galactic Centre, Andromeda Galaxy core, Tarantula Nebula,
  Crab Nebula, Eta Carinae and Rho Ophiuchi
- the north and south ecliptic poles (SPHEREx's deep fields), computed from
  the ecliptic frame

Two notes on sources:
- **WISE 0855.** The challenge position equals the object's WISE designation,
  J085510.83−071442.5, which is its WISE All-Sky position from the May 2010
  visit. The AllWISE catalogue position (mean epoch 2010.59) lies 1.3″ west of
  it, which matches the object's 8.1″/yr westward motion.
- **SIMBAD server.** The script uses the Harvard SIMBAD mirror because the CDS
  server was unreachable when the presets were built. Set `SIMBAD_SERVER =
  None` in the script to use astroquery's default.

## Tests

```bash
pytest                    # all tests
pytest -m "not network"   # skip the live IRSA query
```

- `test_coordinates.py`: decimal and sexagesimal parsing, and error messages.
- `test_processing.py`: reprojection of synthetic images at several roll
  angles onto the fixed grid (a star always lands on the same pixel), grid
  orientation, and ZODI subtraction.
- `test_sky.py`: tile naming per cube frame, the path allow-list for
  redirects, the colour compositor, and saturated-core filling.
- `test_sia_live.py` (marked `network`): a live SIA2 query for WISE 0855.

## Credits

- SPHEREx data: NASA/JPL-Caltech, served by NASA/IPAC IRSA.
- Sky viewer: [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/) by CDS,
  Strasbourg (LGPL-3.0). The bundled copy has its usage logging switched off.
- Target positions: SIMBAD (CDS).

## Data sources

- [IRSA SPHEREx tutorials](https://caltech-ipac.github.io/irsa-tutorials/spherex/)
- [SPHEREx data access](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
- [SPHEREx data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
- [IRSA HiPS list](https://irsa.ipac.caltech.edu/data/hips/list) (SPHEREx DR1 all-sky cube)
