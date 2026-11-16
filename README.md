# SPHEREx Blink

Fly around the infrared sky as NASA's SPHEREx mission sees it. Click any
star, nebula or empty patch to open every SPHEREx image of that spot in a
full-screen blink viewer. There you can:
- play the images in time order;
- add up and subtract visits;
- read the spectrum;
- check the quality flags;
- compare with Gaia and WISE.

Moving and variable objects stand out.

Every image is zodiacal-light subtracted and reprojected onto the same
north-up, east-left grid centred on your position, so frames line up exactly
even though SPHEREx observes at many different roll angles.

## Requirements

- Python 3.11 or newer
- Internet access to `irsa.ipac.caltech.edu`
- A browser with WebGL 2 (any current Chrome, Edge, Firefox or Safari)

There is no build step. The frontend is plain HTML, CSS and ES-module
JavaScript served by the backend. The sky viewer, Aladin Lite 3.8.2, is
bundled in `frontend/vendor/`.

## Setup and run

```bash
python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --port 8000
```

Then open <http://127.0.0.1:8000>.

**First start:** the server pre-builds the colour sky map in the background:
1,021 tiles, about 10 minutes, done once. The tiles are cached in
`backend/cache/hips/`. The app works during this time. The pre-build always
gives way to searches and blinks.

## Using it

The site opens on a start screen. It has:
- **Take the tour:** a 15-step guided walk that moves the camera and opens
  the viewer itself, pointing at each live control.
- **Start exploring:** go straight to the sky.

The **?** button brings the start screen back. The small **?** icons beside
each control and each technical field explain what it shows. They open on
click or tap, or on hover with a mouse. Escape or a click elsewhere closes
them.

### The sky

- Drag to look around and scroll to zoom. The view drifts until you touch it.
- **Targets** lists the five challenge test targets, plus fast movers,
  variable stars, nebulae and galaxies, and the SPHEREx deep fields. Clicking
  one flies there and shows a short description.
- Click any other spot to select it.
- **Open blink viewer** on the card opens the viewer. You can also type RA
  and Dec at the top, in decimal degrees or sexagesimal.
- **Colour / One wavelength** switches the sky between:
  - a colour image (1.25, 2.19 and 3.29 µm);
  - any of the 100 SPHEREx wavelength channels.

### The blink viewer

The viewer is a full-screen view of its own, with the image in the middle.

| Area | What it does |
| --- | --- |
| **Show** | Four views (details below) |
| **Detector** | All detectors, or one of D1–D6, each with its wavelength range and images loaded. Choosing one also loads its images first |
| **Overlays** | Target crosshair; **Gaia DR3** stars moved to each image's date with their proper motion; **AllWISE** sources (2010 positions); **quality flags** (pixels SPHEREx marked as affected); the spectrum aperture |
| Image | Scroll to zoom, drag to pan, double-click to reset. A click moves the spectrum aperture to any star |
| Playback and timeline | Play / pause (space), step (← →), speed. One timeline tick per image, placed by date and coloured by detector. Click or drag to jump |
| **This image** | Date, detector, exact wavelength, data release, observation ID, exposure, quality check (L2 DQA), PSF width, glow contamination (aurora, shuttle glow, helium airglow, radio transmission), cosmic-ray, snowball and streak counts, and the quality flags at the target |
| **Spectrum** | Brightness against wavelength at the aperture, built from every loaded image. Click a point to show its image. **Download CSV** saves it |
| **Display** | Smooth or square pixels; black point, white point, stretch; same range for every image |
| **Data** | Load progress, failed images (with **Retry**), and which data releases were searched |
| **Field of view** | 0.05°, 0.1°, 0.2° or 0.3°. Larger fields follow faster movers but take longer to download |
| **Share or embed** | A link to this exact view, and `<iframe>` code to embed the viewer elsewhere |

The four views:
- **Every image:** each exposure in date order.
- **Visit stacks:** SPHEREx sees each part of the sky in visits about six
  months apart (a gap of more than 20 days starts a new visit). This adds up
  the images of each visit, which cuts the noise while keeping the timeline.
- **Differences:** each visit minus the average of all the others. Amber is
  brighter in this visit and blue is brighter in the others, so a moving
  star shows as an amber–blue pair and a variable star as a single colour.
- **Detector stacks:** everything each detector saw, added together. This is
  the deepest view in each wavelength range.

Display conventions:
- **White star cores:** the pipeline leaves saturated pixels empty (NaN). The
  viewer draws those white when they sit inside a star.
- **Dark blue areas:** parts of the field that no detector covered.

### Links and embedding

Every view has its own address:

```
/?ra=269.446371&dec=4.766881&fov=0.2&name=Barnard%27s%20Star&mode=difference&det=6
```

| Parameter | Meaning |
| --- | --- |
| `ra`, `dec` | Field centre: decimal degrees or sexagesimal (`08h55m10.8s`, `-07d14m42s`) |
| `fov` | `0.05`, `0.1` (default), `0.2` or `0.3` degrees |
| `name` | Title to show |
| `mode` | `frames` (default), `epochs`, `difference` or `detectors` |
| `det` | Detector filter, `1`–`6` |
| `embed=1` | The viewer alone, for an `<iframe>` on another site |

The browser's Back button returns from the viewer to the sky.

### Why the images look soft

That is the data. SPHEREx is a 20 cm telescope built to take spectra of
hundreds of millions of objects, not sharp pictures. Its pixels are 6.2″
wide and its PSF is about as wide as a pixel, so a 0.1° field is 59 × 59
pixels. For comparison, WISE pixels are 2.75″ and 2MASS pixels 1″. Visit and
detector stacks lower the noise but cannot add resolution.

## New data releases

The app checks for new data releases by itself. Once a day it asks IRSA
which SPHEREx collections exist:

```python
Irsa.list_collections(servicetype="SIA", filter="spherex")
```

It then searches every wide-survey spectral-image collection, meaning
`spherex_dr<N>` and `spherex_qr<N>`:
- data releases first, newest first, then quick releases;
- `_deep` and `_cube` collections are skipped;
- an exposure that appears in two releases is taken from the preferred one.

The viewer's **Data** panel shows which collections were searched. So when
`spherex_dr2` appears, it is used the next day with no code change. Two
settings in `backend/config.py` control this:
- `AUTO_DISCOVER_COLLECTIONS = False` turns discovery off and uses
  `COLLECTIONS` as written;
- `COLLECTIONS` is also the fallback if IRSA can't be asked.

A new all-sky map would need `HIPS_URL` changed. After that, delete
`backend/cache/hips/` so the colour tiles are rebuilt.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/info` | Collections in use, field-of-view choices, flag definitions, header metadata keys, overlay catalogues |
| `GET /api/search?ra&dec&fov` | Every image covering the position, sorted by time: `id`, `collection`, `obs_id`, `detector`, `mjd`, `date_iso`, detector band, `exposure_s`, `access_url` |
| `POST /api/stream` | Body `{ra, dec, fov, ids}`. Streams many frames over one connection, each as soon as it is ready (format below) |
| `GET /api/frame/<id>?ra&dec&fov&format=png\|raw` | One frame: an asinh-stretched PNG, or float32 pixels with metadata in `X-Frame-Meta` |
| `GET /api/catalog?name=gaia\|allwise&ra&dec&fov` | Catalogue sources `[ra, dec, pmra, pmdec, mag]`, brightest first |
| `GET /api/sky`, `/hips/rgb/…`, `/hips/<frame>/…` | The all-sky map: wavelength frames, and HiPS tiles in colour or for one frame |

**Stream format.** Each message is:
1. two little-endian `uint32` values, the header length and the payload
   length;
2. a JSON header with `id`, `ok`, `width`, `height` and `meta` (date,
   wavelength, header metadata, flags at the target);
3. the payload:
   - pixels as float16, `width × height × 2` bytes, row 0 north, NaN for no
     data;
   - one byte per pixel of flag categories.

A failed frame has `ok: false` and an `error`. The stream ends with
`{"done": true}`.

**Flag categories.** The bits come from the FLAGS layer, using Table 16 of the
SPHEREx Explanatory Supplement:

| Bit | Category |
| --- | --- |
| 0 | Cosmic rays and snowballs |
| 1 | Bad pixels |
| 2 | Persistence |
| 3 | Ghosts and crosstalk |
| 4 | Satellite streaks |
| 5 | Outliers |
| 6 | Blooming |
| 7 | Known source (informational) |

## Speed

- **Measured throughput.** Loading is limited by how fast IRSA serves
  cutouts. Measured on uncached frames:

  | Parallel downloads | Frames per second |
  | --- | --- |
  | 6 | 2.5 |
  | 12 | 3.1 |
  | 16 | 2.9 |

- **One streaming connection.** Browsers open at most 6 connections to one
  server, so the viewer loads through `/api/stream`. The server fetches 12
  cutouts at once and sends each frame the moment it is ready.
- **Small downloads.**
  - Cutouts stop at the EPSF table, about 125 kB each instead of 4 MB.
  - Frames travel as float16 plus one flag byte per pixel, about 10 kB each
    for a 0.1° field.
- **Useful early.** Frames are requested round-robin across visits and
  detectors, with the chosen detector first. The first few images already
  span every visit, so blinking is useful within seconds.
- **Prefetch.** The search starts in the background as soon as a target's
  card opens.
- **Priority.**
  - Searches and blink cutouts come first.
  - While either is running, sky-map tiles get at most 2 IRSA connections.
  - Catalogue queries have their own small pool.
- **Caching.** Everything is cached on disk under `backend/cache/`: search
  results for 24 hours, frames (with flags) and catalogues indefinitely. A
  second visit to a field is instant.
- **Page load.**
  - Text responses are gzipped. The 2.4 MB Aladin script goes out as about
    0.8 MB.
  - Binary frame endpoints are never gzipped, so frames are not held back.
  - The vendored library lives in a versioned folder, so browsers cache it
    for a year.
  - Our own files are revalidated on each load, so updates show at once.
  - All JavaScript modules are preloaded in parallel.
  - The typeface is one variable-font file.

## How it works

```
backend/
  config.py        collections, field of view, catalogues, concurrency
  data_access.py   collection discovery, SIA2 search, cutouts, Gator catalogue queries, HiPS tiles
  processing.py    ZODI subtraction, reprojection, quality flags, stretch, encodings
  sky.py           colour sky tiles: build on demand, cache, background pre-build
  main.py          FastAPI routes; also serves frontend/
  cache.py         on-disk cache helpers
  scripts/build_presets.py   one-off script that builds frontend/presets.json
  tests/
frontend/
  index.html, style.css, presets.json
  js/main.js       start-up, URL parameters, history
  js/sky.js        sky map, markers, prompt card, camera
  js/viewer.js     blink viewer: loading, views, overlays, spectrum, sharing
  js/tour.js       start screen and guided tour
  js/help.js       the ? help icons and their explanations
  js/util.js       helpers (coordinates, float16 decoding, stream reader)
  vendor/aladin-lite-3.8.2/
```

1. **Search.** `Irsa.query_sia(pos=(coord, 1″), collection=[…discovered…])`.
2. **Cutouts.** IRSA's server-side cutout service at 1.5 × the field of view,
   so the north-up grid stays covered at any roll angle. Full 2040 × 2040
   images are never downloaded.
3. **Processing.**
   - IMAGE − ZODI, then bilinear `reproject_interp` onto a TAN grid with east
     on the left, north up, and the target at the centre.
   - FLAGS goes onto the same grid by nearest neighbour.
   - The exact wavelength at the target comes from the WCS-WAVE lookup table.
4. **Retries.** IRSA answers about a third of cutout requests with
   `503 Server busy`. Each request gets up to 7 attempts with short
   exponential backoff. A frame that still fails is reported and skipped.
5. **In the browser.** Visit, difference and detector stacks are averages of
   the loaded frames, ignoring NaN pixels.
6. **Spectrum.**
   - Aperture: a sum within 2 pixels of the aperture position.
   - Background: the median of a 4–7 pixel ring, subtracted.
   - Conversion to flux density: × the pixel solid angle.
   - No aperture correction.
7. **Overlays.** Gaia DR3 and AllWISE come from IRSA's Gator cone search.
   Gaia positions are moved from epoch 2016.0 to each image's date.

## Targets

`frontend/presets.json` was generated once by
`python -m backend.scripts.build_presets`. The app never queries SIMBAD at
runtime. Positions are propagated to epoch 2025.5 with astropy's
`apply_space_motion`.

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
- the two ecliptic-pole deep fields

**WISE 0855.** The challenge position equals the object's WISE designation,
J085510.83−071442.5, which is its WISE All-Sky position from the May 2010
visit. The AllWISE position (mean epoch 2010.59) lies 1.3″ west of it, which
matches the object's 8.1″/yr westward motion.

## Tests

```bash
pytest                    # all tests
pytest -m "not network"   # skip the live IRSA query
```

| File | Covers |
| --- | --- |
| `test_coordinates.py` | Coordinate parsing and error messages |
| `test_processing.py` | Reprojection at several roll angles onto the fixed grid, orientation, ZODI subtraction |
| `test_sky.py` | All-sky tile naming, redirect allow-list, colour compositor |
| `test_features.py` | Release discovery and ordering, the flag table and category mask, float16 encoding, the binary stream (including a failed frame), field-of-view validation |
| `test_sia_live.py` (marked `network`) | A live SIA2 query for WISE 0855 |

## Licence and credits

- Code: MIT licence (see `LICENSE`).
- SPHEREx data: NASA/JPL-Caltech, served by NASA/IPAC IRSA.
- Gaia DR3 (ESA) and AllWISE (NASA/JPL-Caltech) catalogues, via IRSA.
- Sky viewer: [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/) by
  CDS, Strasbourg (LGPL-3.0), bundled unmodified, with usage logging switched
  off by option.
- Flag definitions: SPHEREx Explanatory Supplement v2.0, Table 16.
- Target positions: SIMBAD (CDS).
- Typeface: Public Sans (USWDS, SIL Open Font License).

## Data sources

- [IRSA SPHEREx tutorials](https://caltech-ipac.github.io/irsa-tutorials/spherex/)
- [SPHEREx data access](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
- [SPHEREx data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
- [SPHEREx Explanatory Supplement](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp_QR.pdf)
- [IRSA HiPS list](https://irsa.ipac.caltech.edu/data/hips/list)
