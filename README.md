# PointCloud Inspector

> A professional, fully client-side point cloud inspection & analysis tool that runs in your browser.

PointCloud Inspector is a web application for loading, validating, visualising and analysing 3D point clouds. Everything runs locally in the browser — **your files never leave your machine**. No backend, no upload, no account.

---

## Features

- **Zero-install, privacy-first** — Drop a file and inspect it. Parsing, rendering and analysis all happen on-device via WebGL and Web Workers.
- **Broad format support** — LAS / LAZ / PCD / PLY / PTS / PTX / XYZ / CSV / TXT / OBJ / raw BIN. Unknown extensions are sniffed by content.
- **High-performance WebGL rendering** — Custom Three.js shader with point-size control (screen-space or world-space), square/circle sprites, opacity, fog and colour gain.
- **Flexible colouring** — Uniform colour, per-attribute lookup tables (LUT), raw RGB, or elevation. Built-in colormaps (viridis, terrain, thermal, jet, …) with automatic guesses from attribute names, plus user-importable custom LUTs.
- **Smart downsampling** — Voxel / random / uniform strategies that work on index buffers (the source arrays are never copied). Auto-downsamples above a soft limit and refuses to render above a hard limit to keep the tab responsive.
- **Compliance / validation** — Detects invalid coordinates, duplicate ratios and suspicious coordinate magnitudes (often a unit mistake), and recommends a safe target count.
- **Non-destructive filtering** — Range rules (per axis or named scalar) and set rules (e.g. LAS classification codes), combined with AND/OR logic. Filters compose with downsampling and colouring.
- **Section / profile analysis** — Sample a cylindrical tube around a picked segment and reduce it to a 1-D curve with rich statistics (min/max/mean/median/std, trend slope, extremes location, largest slope step).
- **Measurement & picking** — `orbit` and `measure` interaction modes, spatial picking with hover cards, and on-screen distance read-outs.
- **Rich exports** — Current view as CSV / PLY / PCD, profile curves as CSV, rendered viewport as an image, and reusable session presets (JSON).
- **Ergonomic UI** — Dark/light themes, resizable collapsible panels (left/right/bottom docks), charts and legends, and keyboard shortcuts (`Ctrl+1/2/3` toggle panels). Demo data is one click away.

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ (Node 20 recommended)

### Install & run

```bash
# install dependencies
npm install

# start the dev server (default http://localhost:5173)
npm run dev

# type-check only
npm run typecheck

# production build (outputs to dist/)
npm run build

# preview the production build locally
npm run preview
```

Then open the URL printed by Vite and **drag a point cloud file** onto the viewport (or use *Load file* / *Load demo data*).

---

## Supported formats

| Format | Label | Notes | Binary |
| ------ | ----- | ----- | ------ |
| `.las` | LAS | ASPRS lidar standard 1.0–1.4 | ✔ |
| `.laz` | LAZ | Lossless compression of LAS | ✔ |
| `.pcd` | PCD | PCL — ascii / binary / LZF | ✔ |
| `.ply` | PLY | Polygon File Format (Stanford) | ✔ |
| `.pts` | PTS | Leica scanner text point cloud | |
| `.ptx` | PTX | Text point cloud with poses | |
| `.xyz` | XYZ | Plain coordinates, optional attribute columns | |
| `.csv` | CSV | Tabular cloud with header | |
| `.txt` | TXT | Generic delimited text | |
| `.obj` | OBJ | Wavefront — vertices only | |
| `.bin` | BIN | Raw `float32` xyz triplet stream | ✔ |

For delimited text formats (CSV/TXT/XYZ/PTS/PTX) a column-mapping dialog lets you assign which columns are X / Y / Z and which carry extra scalar attributes.

---

## Project structure

```
pointcloudChecker/
├─ index.html              # App shell (top bar, panels, viewport, dock, status bar)
├─ src/
│  ├─ main.ts              # Entry point — loads styles, boots App
│  ├─ app.ts               # Orchestrator: state store + viewer + all interactions
│  ├─ core/                # Pure logic, no DOM
│  │  ├─ cloud.ts          # Cloud model, statistics, sampling helpers
│  │  ├─ colormap.ts       # Built-in + custom LUTs, auto-guess by name
│  │  ├─ downsample.ts     # voxel / random / uniform index strategies
│  │  ├─ filters.ts        # Range & set filter rules (AND/OR)
│  │  ├─ profile.ts        # Section/profile sampling + statistics
│  │  ├─ validate.ts       # Compliance checks & sanitisation
│  │  ├─ state.ts          # Central reactive store & types
│  │  └─ demo.ts           # Bundled sample cloud
│  ├─ io/                  # Parsers & exporters
│  │  ├─ index.ts          # Format detection + dispatch
│  │  ├─ las.ts  laz.ts    # LAS / LAZ (via laz-perf)
│  │  ├─ pcd.ts ply.ts obj.ts raw.ts
│  │  ├─ text.ts           # CSV/TXT/XYZ/PTS/PTX with header mapping
│  │  └─ export.ts         # CSV / PLY / PCD / image / preset export
│  ├─ render/
│  │  └─ Viewer.ts         # WebGL viewport, shader, camera, picking, measurement
│  ├─ ui/                  # Views over App + store (no business logic)
│  │  ├─ panelSettings.ts  # Render & colour settings
│  │  ├─ panelFunctions.ts # Downsample / filter / profile / measure
│  │  ├─ panelData.ts      # Statistics, charts, table
│  │  ├─ exportDialog.ts   # Export wizard
│  │  ├─ columnDialog.ts   # Text column mapping
│  │  ├─ legend.ts chart.ts controls.ts dom.ts
│  └─ styles/              # Design tokens → base → components → app shell
├─ scripts/                # Build/CI smoke tests & interaction probes
└─ vite.config.ts
```

The architecture separates **`core`** (pure, DOM-free algorithms), **`io`** (parsing/serialisation), **`render`** (WebGL), and **`ui`** (declarative views driven by a single reactive `Store`). This keeps the heavy lifting testable and the panels as thin observers over application state.

---

## Tech stack

| Area | Choice |
| ---- | ------ |
| Language | TypeScript (strict) |
| Build / dev | Vite 5 |
| 3D / WebGL | Three.js (custom `ShaderMaterial`, `TrackballControls`) |
| LAZ decode | `laz-perf` |
| UI | Hand-rolled DOM components + CSS variables (light/dark themes) |

---

## npm scripts

| Script | Description |
| ------ | ----------- |
| `npm run dev` | Start the Vite dev server with HMR. |
| `npm run build` | Type-check (`tsc --noEmit`) then build to `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm run typecheck` | Run TypeScript type checks without emitting. |
| `npm run smoke` | Node smoke test of the core parsing pipeline. |
| `npm run smoke:browser` | Headless browser interaction smoke test. |

---

## Privacy & performance notes

- **Local only.** Files are read with the File API and parsed in the browser. Nothing is uploaded to any server.
- **Memory aware.** A *soft* limit (~1.5 M points) triggers automatic downsampling; a *hard* limit (~40 M points) avoids rendering the full set to protect the tab.
- **Large files.** For multi-million point clouds, prefer LAZ/LAS (decoded efficiently) and let voxel downsampling reduce the working set.

---

## License

See `LICENSE` in the repository root. (Add your chosen license here.)

---

*PointCloud Inspector — inspect, validate and understand your point clouds, entirely in the browser.*
