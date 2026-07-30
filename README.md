# Point Tracker — Live Screen Motion Analysis

A fully client-side web app that captures your screen via WebRTC, lets you click any point (e.g. a point on a chart line), tracks that point's pixel motion in real time using OpenCV.js template matching, and extrapolates a short-term (60-second) trajectory from the tracked motion.

**No backend. No build step. No data ever leaves the browser.**

> ⚠️ **Important — read this before using it for anything real:** This app tracks the *visual position of a pixel pattern on your screen*. It has no connection to live market data, no understanding of what the chart represents, and no statistical edge over the instrument itself. The "UP/DOWN probability" is a linear extrapolation of recent pixel movement, not a financial forecast. Treat this as a computer-vision / motion-analysis demo, not a trading signal.

---

## Features

- 🖥️ **Share Screen** — captures any screen, window, or tab via `getDisplayMedia()`
- 🎯 **Click-to-track** — click anywhere on the live feed to select a point; the app grabs a small image patch around it as a template
- 🔍 **OpenCV.js template matching** — each frame, searches a local window around the last known position for the best match (`cv.matchTemplate`, `TM_CCOEFF_NORMED`)
- 📊 **Live metrics** — X/Y position, vertical speed (px/s), direction (UP/DOWN/FLAT), momentum (acceleration of vertical speed)
- 🧮 **60-second rolling buffer** — all position samples from the last 60 seconds are kept and used for analysis
- 🔮 **60s-ahead extrapolation** — a least-squares linear regression over the buffer projects position 60 seconds forward; the projected slope is converted to UP/DOWN probabilities via a logistic function
- 🎚️ **Confidence score** — blends regression fit quality (R²) with template match confidence
- 📈 **Mini history chart** — visualizes the tracked point's Y-position over the last 60 seconds
- 📱 **Responsive layout** — works on desktop and mobile browsers (mobile screen-share support depends on the browser/OS)
- 🧰 **Start / Stop / Reset controls**

---

## How it works

1. **Capture** — `navigator.mediaDevices.getDisplayMedia()` streams the shared screen into a hidden `<video>` element.
2. **Select a point** — clicking on the video grabs the current frame into an offscreen canvas, reads it into an OpenCV `Mat`, and crops a small square patch (default 96×96 px) centered on the click. This patch is the *template*.
3. **Track** — on a ~10 Hz timer, the current frame is captured again. Instead of searching the whole frame (slow), the app searches a window around the last known point (`±90px` by default) using `cv.matchTemplate`. The best match location (via `cv.minMaxLoc`) becomes the new tracked position. Matches below a confidence threshold (0.45) are discarded to avoid jitter from drift.
4. **Buffer** — every accepted match is pushed into an in-memory ring buffer as `{ timestamp, x, y }`. Samples older than 60 seconds are dropped automatically.
5. **Metrics**:
   - **Speed** — vertical pixel displacement over the last ~1 second, in px/s.
   - **Direction** — `UP` if the point is moving toward lower Y values fast enough, `DOWN` if moving toward higher Y, `FLAT` otherwise (screen Y increases downward, so "up" visually means decreasing Y).
   - **Momentum** — the rate of change of speed itself (a simple discrete second derivative), giving a sense of acceleration/deceleration.
6. **Prediction** — a least-squares linear regression is fit over the entire 60-second buffer (`y = a·t + b`). The slope `a` is projected 60 seconds into the future to estimate where the point would land if the recent trend continued. The slope is passed through a logistic (sigmoid) function to produce an UP probability (and `100 − UP` for DOWN). Confidence combines the regression's R² (how well a straight line fits the recent motion) with the live template match score.

All of this — video capture, OpenCV processing, math, and rendering — happens in your browser tab. Nothing is uploaded anywhere.

---

## Getting started locally

No build tools or package manager are required.

```bash
# Clone or download this repository, then from inside the folder:
python3 -m http.server 8080
# or: npx serve .
```

Open `http://localhost:8080` in Chrome, Edge, or another Chromium-based browser (these have the most reliable `getDisplayMedia()` support). Then:

1. Click **Share Screen** and choose a screen, window, or tab containing the chart you want to track.
2. Click directly on a point on the chart in the video preview (e.g. the tip of a price line).
3. Click **Start Tracking**.
4. Watch the live metrics and 60-second outlook update in real time.
5. Click **Stop Tracking** to pause, or **Reset** to clear the buffer and pick a new point.

> Note: `getDisplayMedia()` requires a secure context (HTTPS or `localhost`). It will not work over a plain `http://` connection to a remote host.

---

## Deploying to GitHub Pages

This repo includes a ready-to-use GitHub Actions workflow at `.github/workflows/deploy.yml`.

1. Push this folder to a new GitHub repository (as the repo root, or adjust the workflow's `path` if nested).
2. In the repository, go to **Settings → Pages → Build and deployment → Source**, and select **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the **Actions** tab).
4. Your app will be published at `https://<your-username>.github.io/<repo-name>/`.

No further configuration is needed — there's no build step, no environment variables, and no server-side code.

### Manual alternative (no Actions)

If you'd rather not use Actions, you can instead:

1. Go to **Settings → Pages → Build and deployment → Source → Deploy from a branch**.
2. Choose the `main` branch and `/ (root)` folder.
3. Save — GitHub will publish the static files directly.

---

## Project structure

```
.
├── index.html              # App shell / layout
├── style.css                # Visual design, responsive layout
├── app.js                    # Capture, tracking, metrics, prediction logic
├── .nojekyll                 # Tells GitHub Pages to skip Jekyll processing
├── .github/workflows/deploy.yml   # GitHub Pages CI/CD
└── README.md
```

OpenCV.js is loaded directly from the official CDN (`docs.opencv.org`) at runtime — there's nothing to install or vendor locally.

---

## Browser & platform notes

- **Best support:** Desktop Chrome, Edge, or other Chromium-based browsers.
- **Firefox:** `getDisplayMedia()` is supported on desktop; behavior of tab-vs-window capture can vary slightly.
- **Safari:** Desktop Safari 13+ supports screen capture; iOS Safari does **not** support `getDisplayMedia()` at all (a system limitation, not specific to this app) — on iPhone/iPad you can still view the responsive layout, but screen sharing won't be available.
- **Mobile Chrome on Android:** Screen capture support varies by OS version and is generally more limited than desktop.
- A **secure context (HTTPS)** is required for screen capture in all browsers; GitHub Pages serves over HTTPS by default, so deployed builds work without extra configuration.

---

## Tuning the tracker

A few constants near the top of `app.js` control tracking behavior:

| Constant | Default | Effect |
|---|---|---|
| `templateSize` | `48` (→ 96×96 px patch) | Larger = more robust to noise, slower and less precise for small/thin lines |
| `searchMargin` | `90` px | How far the tracker looks around the last known point each frame; increase if your chart moves fast |
| `TICK_INTERVAL_MS` | `100` (10 Hz) | How often matching runs; lower = smoother tracking but more CPU |
| match confidence threshold | `0.45` | Matches below this score are discarded as unreliable |
| sigmoid sensitivity `k` | `0.08` | Controls how quickly UP/DOWN probability saturates as slope increases |

---

## Known limitations

- Template matching can lose track if the tracked pattern changes appearance significantly (e.g. a line changes color, the chart rescales, or another element occludes it). If this happens, click **Reset** and re-select the point.
- The "prediction" is a simple linear extrapolation of recent pixel motion — it has no awareness of the underlying data, seasonality, support/resistance, news, or anything else. It will be wrong as often as a straight line drawn through recent noise would be wrong, because that's exactly what it is.
- Performance depends on your device; very high-resolution screen shares with a small search window are the most efficient configuration.

## License

MIT — use, modify, and deploy freely.
