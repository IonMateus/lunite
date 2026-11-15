# Last Light: data pack and data viewer

This is a static site (GitHub Pages, no server). `index.html` is a **data viewer**. It exists to check that the data pack is correct and to see how it looks. It is not the final product.

## What is in `data/`

| Path | What | Source |
|---|---|---|
| `terrain/g64` | Whole Moon, 474 m/pixel (64 px/deg) | NASA LOLA `ldem_64` (native) |
| `terrain/g32 … g4` | Zoomed-out overviews, 948 m to 7.6 km | 2×2 block means of `g64` (derived) |
| `terrain/p120` | South polar cap 75–90°S, 120 m | LOLA `ldem_75s_120m` (native) |
| `terrain/p240`, `p480` | Polar overviews | 2×2 block means of `p120` (derived) |
| `terrain/p40` | 80–90°S, 40 m | LOLA `ldem_80s_40m` (native) |
| `terrain/p20` | 85–87.5°S, 20 m | LOLA `ldem_80s_20m` (native, band only) |
| `terrain/p10` | 87.5–90°S, 10 m | LOLA `ldem_85s_10m` (native, band only) |
| `terrain/<site>_core` | Polar sites, 0–5 km at 5, 10 or 20 m | LOLA polar files (native crop) |
| `terrain/<site>_r30` | 0–25 km at 30 m | Non-polar: LOLA `ldem_1024` tiles (native crop). Polar: bilinear resample of the 20 m file (derived) |
| `terrain/<site>_r120` | 25–100 km at ~120 m | Polar: `ldem_75s_120m` (native crop). Non-polar: 4×4 block mean of the 30 m tiles (derived) |
| `illum/sun60`, `illum/earth60` | Average Sun / Earth visibility, 85–90°S, 60 m | LOLA illumination maps (EXTRAS, for comparison) |
| `ephem/*.bin` | Sun and Earth directions every 3 h, 2020–2050 and 1969–1972 | JPL Horizons API, DE441, frame MOON_ME |
| `validation.json` | Horizons topocentric az/el at 5 test sites | JPL Horizons |
| `sites.json` | The 20 curated sites | NSSDCA, LROC, IAU Gazetteer, NASA |
| `textures/` | Moon colour and Earth day/night (visual only) | NASA SVS |
| `layers.json` | Every layer: projection, tile grid, stored tiles, source file + SHA-256, native/derived | — |

Heights are stored as the original LOLA integers: height = DN × 0.5 m above the 1737.4 km sphere. Tiles are 257×257 samples, with one border row and column shared with the next tile. Each tile is coded with a predictor (left + up − up-left), then zlib. This is **lossless**: decoding returns the exact NASA integers.

Every raw NASA file, its URL and its SHA-256 are listed in `tools/raw_manifest.json`. `tools/download_nasa_data.py` downloads and verifies them (about 23 GB, not stored here). `tools/build_pack.py` builds `data/` from them, and `tools/sites.json` is its input list of curated sites.

## How a point gets its height

1. **Choose the layer.** Among the layers stored at that point, the viewer takes the coarsest one whose pixel is no larger than the grid spacing on screen. If no layer is that fine, it takes the finest layer available there. South of about 75°S it uses the polar products instead of the cylindrical global map. Curated-site windows count as layers too.
2. **Interpolate between samples.** It uses bilinear interpolation of the 4 surrounding LOLA samples.

Why bilinear interpolation is valid here:

- **It is exact at every sample.** The original NASA value is returned at every grid point.
- **It never creates peaks or pits.** Each value lies between its 4 neighbours, so there is no overshoot. That matters, because a fake peak could cast a fake shadow.
- **It is continuous**, so there are no cracks between tiles. The tiles share their border samples.
- **It adds no information, and claims none.** LOLA grids are themselves interpolated from laser tracks, so detail finer than the pixel is unknown. Showing a smooth plane between samples is the honest choice. The real resolution of each patch is shown in the panel and in the "Data resolution" overlay.
- **The error is bounded:** at most about Δ²·|curvature|/8, where Δ is the pixel size. For example, a 30 m pixel on a 20° slope that bends over 300 m errs by well under a metre.

Spline or bicubic methods are smoother, but they can overshoot near crater rims. Procedural "detail" would invent terrain, so neither is used.

## Shadows

For each vertex, the viewer marches toward the Sun over the patch, then over a coarse context patch 8× wider. It keeps the steepest terrain angle (the local horizon) and compares it with the Sun's elevation. The visible fraction of the Sun's disc (0.53° wide) gives a soft, physical penumbra. Curvature of the Moon is included, because all positions are exact 3-D points on the sphere.

Terrain beyond the context patch is ignored. The context reaches 4× the patch width from the centre: 6.4 km at the closest zoom, about 1,600 km at the widest.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. A plain `file://` open does not work, because browsers block workers and `fetch` there.
