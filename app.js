/* ============================================================
   Point Tracker — app.js
   Pipeline:
     1. getDisplayMedia() -> <video>
     2. User click on stage -> grab a small template patch
        around the click from the current video frame.
     3. On each animation tick: run cv.matchTemplate over the
        current frame (search window around last known position
        for performance), find best match -> new (x,y).
     4. Push {t, x, y} into a 60s ring buffer.
     5. Derive vertical speed, direction, momentum from the
        buffer.
     6. Fit a simple linear regression (least squares) over the
        recent window to extrapolate 60s ahead -> UP/DOWN prob
        + confidence.
   Everything below runs entirely in the browser.
   ============================================================ */

(() => {
  'use strict';

  // ---------- DOM ----------
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const stage = document.getElementById('stage');
  const stageEmpty = document.getElementById('stageEmpty');
  const captureHint = document.getElementById('captureHint');

  const btnShare = document.getElementById('btnShare');
  const btnCamera = document.getElementById('btnCamera');
  const btnUpload = document.getElementById('btnUpload');
  const fileInput = document.getElementById('fileInput');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnReset = document.getElementById('btnReset');

  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  const probUpEl = document.getElementById('probUp');
  const probDownEl = document.getElementById('probDown');
  const probUpFill = document.getElementById('probUpFill');
  const probDownFill = document.getElementById('probDownFill');
  const confValueEl = document.getElementById('confValue');

  const metricPos = document.getElementById('metricPos');
  const metricSpeed = document.getElementById('metricSpeed');
  const metricDirection = document.getElementById('metricDirection');
  const metricMomentum = document.getElementById('metricMomentum');
  const metricMatch = document.getElementById('metricMatch');
  const metricBuffer = document.getElementById('metricBuffer');

  const historyCanvas = document.getElementById('historyChart');
  const historyCtx = historyCanvas.getContext('2d');
  const logEl = document.getElementById('log');

  const octx = overlay.getContext('2d');

  // ---------- State ----------
  const BUFFER_SECONDS = 60;
  let cvReady = false;
  let stream = null;
  let hasSource = false;   // true once ANY video source (share/camera/file) is active
  let objectUrl = null;    // set when source is an uploaded video file
  let trackingArmed = false;   // waiting for user click to choose a point
  let tracking = false;        // actively tracking
  let rafId = null;

  let templateMat = null;      // cv.Mat of the patch being tracked
  let templateSize = 48;       // patch half-size in video-pixel space
  let searchMargin = 90;       // how far around last point to search each frame

  let lastPoint = null;        // {x, y} in video-native pixel coords
  let lastMatchScore = 0;

  // Ring buffer of samples: {t (ms), x, y}
  let buffer = [];

  // Offscreen canvas to pull frames from <video> for OpenCV
  const frameCanvas = document.createElement('canvas');
  const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });

  // ---------- Logging ----------
  function log(msg) {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `<span class="t">${time}</span>${msg}`;
    logEl.appendChild(div);
    // cap log length
    while (logEl.children.length > 80) logEl.removeChild(logEl.firstChild);
  }

  function setStatus(text, mode) {
    statusText.textContent = text;
    statusDot.classList.remove('live', 'warn');
    if (mode) statusDot.classList.add(mode);
  }

  // ---------- OpenCV readiness ----------
  // opencv.js calls Module.onRuntimeInitialized when WASM is ready.
  // We poll for cv.Mat existing as a robust readiness check across versions.
  window.__cvReady = () => {
    const check = () => {
      if (window.cv && (cv.Mat || (cv.onRuntimeInitialized !== undefined))) {
        if (typeof cv.Mat === 'function') {
          cvReady = true;
          log('OpenCV.js loaded — ready to track.');
          updateButtonStates();
        } else {
          cv.onRuntimeInitialized = () => {
            cvReady = true;
            log('OpenCV.js loaded — ready to track.');
            updateButtonStates();
          };
        }
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  };
  // In case the script already loaded before this ran:
  if (window.cv) window.__cvReady();

  function updateButtonStates() {
    btnStart.disabled = !(hasSource && cvReady) || tracking || trackingArmed;
  }

  // Common "we now have a live video source" setup, shared by
  // screen-share, camera, and file-upload sources.
  function activateSource(label, statusMode) {
    hasSource = true;
    stage.classList.add('has-video');
    stageEmpty.style.display = 'none';
    captureHint.textContent = 'Click any point on the chart to begin tracking it';
    setStatus(label, statusMode || 'warn');
    log(`${label}.`);

    video.addEventListener('loadedmetadata', sizeCanvases, { once: true });
    sizeCanvases();
    updateButtonStates();
  }

  // ---------- Screen capture (desktop browsers only) ----------
  btnShare.addEventListener('click', async () => {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
      log('Screen share isn\'t supported by this browser (common on mobile Chrome/Safari — there is no OS-level API for it). Use "Use Camera" or "Upload Video" instead.');
      setStatus('Share unsupported', 'warn');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();

      activateSource('Screen shared', 'warn');

      stream.getVideoTracks()[0].addEventListener('ended', () => {
        log('Screen share ended by user.');
        stopEverything(true);
      });
    } catch (err) {
      log(`Screen share failed: ${escapeHtml(err.message || String(err))}. Try "Use Camera" or "Upload Video" instead.`);
      setStatus('Share failed', 'warn');
    }
  });

  // ---------- Camera fallback (works on mobile: point the rear
  // camera at another screen/monitor showing the chart) ----------
  btnCamera.addEventListener('click', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      video.srcObject = stream;
      await video.play();

      activateSource('Camera active — aim at the chart', 'warn');

      stream.getVideoTracks()[0].addEventListener('ended', () => {
        log('Camera stopped.');
        stopEverything(true);
      });
    } catch (err) {
      log(`Camera access failed: ${escapeHtml(err.message || String(err))}`);
      setStatus('Camera failed', 'warn');
    }
  });

  // ---------- Upload fallback (record your screen with your
  // phone's built-in screen recorder, then upload the video here) ----------
  btnUpload.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // allow re-selecting the same file later
    if (!file) return;

    try {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(file);
      video.srcObject = null;
      video.src = objectUrl;
      video.muted = true;
      video.loop = true;
      await video.play();

      activateSource(`Playing uploaded video: ${escapeHtml(file.name)}`, 'warn');
    } catch (err) {
      log(`Video upload failed: ${escapeHtml(err.message || String(err))}`);
      setStatus('Upload failed', 'warn');
    }
  });

  function sizeCanvases() {
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    frameCanvas.width = vw;
    frameCanvas.height = vh;

    // overlay matches the displayed (CSS) size of the video, in device pixels
    const rect = video.getBoundingClientRect();
    overlay.width = Math.round(rect.width * (window.devicePixelRatio || 1));
    overlay.height = Math.round(rect.height * (window.devicePixelRatio || 1));
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }
  window.addEventListener('resize', sizeCanvases);

  // ---------- Point selection on click ----------
  stage.addEventListener('click', (e) => {
    if (!hasSource) return;
    if (tracking) return; // ignore clicks once actively tracking; user must Reset first
    armPointSelection(e);
  });

  function armPointSelection(e) {
    const videoPoint = clientToVideoCoords(e.clientX, e.clientY);
    if (!videoPoint) return;
    captureTemplateAt(videoPoint.x, videoPoint.y);
  }

  function clientToVideoCoords(clientX, clientY) {
    const rect = video.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    // account for object-fit: contain letterboxing
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dispW = vw * scale, dispH = vh * scale;
    const offX = (rect.width - dispW) / 2;
    const offY = (rect.height - dispH) / 2;

    const localX = clientX - rect.left - offX;
    const localY = clientY - rect.top - offY;
    if (localX < 0 || localY < 0 || localX > dispW || localY > dispH) return null;

    return {
      x: Math.round(localX / scale),
      y: Math.round(localY / scale)
    };
  }

  function captureTemplateAt(x, y) {
    if (!cvReady) {
      log('OpenCV.js is still loading — try again in a moment.');
      return;
    }
    drawCurrentFrameToCanvas();

    const half = templateSize;
    const tx = Math.max(0, Math.min(frameCanvas.width - half * 2, x - half));
    const ty = Math.max(0, Math.min(frameCanvas.height - half * 2, y - half));

    const full = cv.imread(frameCanvas);
    const rect = new cv.Rect(tx, ty, half * 2, half * 2);
    const patch = full.roi(rect);

    if (templateMat) templateMat.delete();
    templateMat = patch.clone();
    full.delete();
    patch.delete();

    lastPoint = { x, y };
    lastMatchScore = 1;

    buffer = []; // fresh tracking target -> fresh buffer
    pushSample(x, y);

    trackingArmed = true;
    btnStart.disabled = false;
    captureHint.textContent = 'Point captured — click "Start Tracking" to begin';
    drawReticle(x, y, '#f5a623');
    log(`Point selected at (${x}, ${y}). Template patch captured (${half * 2}×${half * 2}px).`);
  }

  function drawCurrentFrameToCanvas() {
    frameCanvas.width = video.videoWidth;
    frameCanvas.height = video.videoHeight;
    frameCtx.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
  }

  // ---------- Tracking loop ----------
  btnStart.addEventListener('click', () => {
    if (!templateMat) {
      log('Select a point on the chart first.');
      return;
    }
    tracking = true;
    trackingArmed = false;
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnReset.disabled = false;
    setStatus('Tracking', 'live');
    captureHint.textContent = 'Tracking active — click Stop to pause';
    log('Tracking started.');
    rafId = requestAnimationFrame(trackTick);
  });

  btnStop.addEventListener('click', () => {
    stopTracking();
    log('Tracking stopped.');
  });

  function stopTracking() {
    tracking = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    btnStop.disabled = true;
    btnStart.disabled = !templateMat;
    setStatus(hasSource ? 'Video active' : 'Idle', hasSource ? 'warn' : null);
  }

  btnReset.addEventListener('click', () => {
    stopTracking();
    if (templateMat) { templateMat.delete(); templateMat = null; }
    lastPoint = null;
    buffer = [];
    trackingArmed = false;
    btnStart.disabled = true;
    btnReset.disabled = true;
    captureHint.textContent = hasSource ? 'Click any point on the chart to begin tracking it' : 'Share your screen, use the camera, or upload a video, then click a point on the chart to track';
    clearOverlay();
    resetMetricsUI();
    log('Reset. Select a new point to track.');
  });

  let lastTickTime = 0;
  const TICK_INTERVAL_MS = 100; // ~10 matches/sec is plenty for chart-speed motion

  function trackTick(now) {
    if (!tracking) return;
    if (now - lastTickTime >= TICK_INTERVAL_MS) {
      lastTickTime = now;
      try {
        runMatch();
      } catch (err) {
        log(`Tracking error: ${escapeHtml(err.message || String(err))}`);
      }
    }
    rafId = requestAnimationFrame(trackTick);
  }

  function runMatch() {
    if (!templateMat || !lastPoint) return;
    drawCurrentFrameToCanvas();

    const frameMat = cv.imread(frameCanvas);
    const tW = templateMat.cols, tH = templateMat.rows;

    // Search window around last known point for performance + robustness
    const sx = Math.max(0, lastPoint.x - searchMargin);
    const sy = Math.max(0, lastPoint.y - searchMargin);
    const ex = Math.min(frameMat.cols, lastPoint.x + searchMargin + tW);
    const ey = Math.min(frameMat.rows, lastPoint.y + searchMargin + tH);
    const sw = ex - sx, sh = ey - sy;

    if (sw <= tW || sh <= tH) {
      frameMat.delete();
      return; // point near edge / degenerate window
    }

    const searchRect = new cv.Rect(sx, sy, sw, sh);
    const searchRegion = frameMat.roi(searchRect);

    const result = new cv.Mat();
    cv.matchTemplate(searchRegion, templateMat, result, cv.TM_CCOEFF_NORMED);
    const minMax = cv.minMaxLoc(result);
    const score = minMax.maxVal;
    const loc = minMax.maxLoc;

    // New point = center of matched patch, in full-frame coords
    const newX = sx + loc.x + tW / 2;
    const newY = sy + loc.y + tH / 2;

    searchRegion.delete();
    result.delete();
    frameMat.delete();

    lastMatchScore = score;

    if (score < 0.45) {
      // Low confidence match — keep last point, don't pollute buffer with noise
      log(`Low match confidence (${score.toFixed(2)}) — holding last position.`);
    } else {
      lastPoint = { x: Math.round(newX), y: Math.round(newY) };
      pushSample(lastPoint.x, lastPoint.y);
    }

    drawReticle(lastPoint.x, lastPoint.y, score < 0.45 ? '#ef6461' : '#4fd1c5');
    updateMetricsAndPrediction();
  }

  // ---------- Buffer management ----------
  function pushSample(x, y) {
    const t = performance.now();
    buffer.push({ t, x, y });
    const cutoff = t - BUFFER_SECONDS * 1000;
    while (buffer.length && buffer[0].t < cutoff) buffer.shift();
  }

  // ---------- Metrics + prediction ----------
  function updateMetricsAndPrediction() {
    if (buffer.length < 2) return;

    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    const dt = (last.t - first.t) / 1000; // seconds spanned by buffer

    // Vertical speed: use a short recent window (last ~1s) for responsiveness
    const recentWindowMs = 1000;
    const recent = buffer.filter(s => s.t >= last.t - recentWindowMs);
    let vSpeed = 0; // px/sec, positive = moving down (screen coords), we'll flip sign for "up"
    if (recent.length >= 2) {
      const r0 = recent[0], r1 = recent[recent.length - 1];
      const rdt = (r1.t - r0.t) / 1000;
      if (rdt > 0) vSpeed = (r1.y - r0.y) / rdt;
    }

    // Direction: chart-up = decreasing Y in screen coords
    const screenDirection = vSpeed < -2 ? 'UP' : vSpeed > 2 ? 'DOWN' : 'FLAT';

    // Momentum: rate of change of speed (acceleration) over the recent window,
    // normalized into an arbitrary but consistent unit for display.
    let momentum = 0;
    if (recent.length >= 3) {
      const mid = recent[Math.floor(recent.length / 2)];
      const dtA = (mid.t - recent[0].t) / 1000;
      const dtB = (recent[recent.length - 1].t - mid.t) / 1000;
      if (dtA > 0 && dtB > 0) {
        const speedA = (mid.y - recent[0].y) / dtA;
        const speedB = (recent[recent.length - 1].y - mid.y) / dtB;
        momentum = (speedB - speedA) / ((dtA + dtB) || 1);
      }
    }

    // Linear regression over full buffer (y = a*t + b) for 60s-ahead extrapolation
    const reg = linearRegression(buffer);
    const horizonMs = 60000;
    const projectedY = reg.a * (last.t + horizonMs) + reg.b;
    const deltaY = projectedY - last.y; // negative => moves up on screen

    // Convert regression slope to a probability via a logistic squash.
    // Slope is in px/ms; scale it to px/s for a more intuitive magnitude.
    const slopePxPerSec = reg.a * 1000;
    const k = 0.08; // sensitivity constant — tuned for typical chart pixel speeds
    const upScore = sigmoid(-slopePxPerSec * k); // negative slope (moving up) -> high upScore
    const probUp = Math.round(upScore * 100);
    const probDown = 100 - probUp;

    // Confidence: combines regression fit quality (R²) and match score
    const confidence = Math.round(Math.max(0, Math.min(1, reg.r2 * 0.7 + lastMatchScore * 0.3)) * 100);

    renderMetrics({
      x: last.x, y: last.y,
      vSpeed, screenDirection, momentum,
      probUp, probDown, confidence,
      matchScore: lastMatchScore,
      bufferPct: Math.min(100, Math.round((dt / BUFFER_SECONDS) * 100))
    });

    drawHistoryChart();
  }

  function linearRegression(points) {
    const n = points.length;
    if (n < 2) return { a: 0, b: points[0]?.y || 0, r2: 0 };
    const t0 = points[0].t;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of points) {
      const x = p.t - t0; // ms since first sample, keeps numbers small
      sumX += x; sumY += p.y; sumXY += x * p.y; sumXX += x * x;
    }
    const denom = (n * sumXX - sumX * sumX) || 1e-9;
    const a = (n * sumXY - sumX * sumY) / denom;
    const b = (sumY - a * sumX) / n;

    // R^2
    const meanY = sumY / n;
    let ssTot = 0, ssRes = 0;
    for (const p of points) {
      const x = p.t - t0;
      const pred = a * x + b;
      ssTot += (p.y - meanY) ** 2;
      ssRes += (p.y - pred) ** 2;
    }
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

    // a is in px per ms relative to t0; convert back to absolute time basis
    return { a, b: b - a * t0, r2 };
  }

  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

  // ---------- Rendering ----------
  function renderMetrics(m) {
    metricPos.textContent = `${m.x}, ${m.y}`;
    metricSpeed.textContent = `${Math.abs(m.vSpeed).toFixed(1)} px/s`;
    metricDirection.textContent = m.screenDirection;
    metricDirection.style.color = m.screenDirection === 'UP' ? 'var(--cyan)' : m.screenDirection === 'DOWN' ? 'var(--coral)' : 'var(--text-0)';
    metricMomentum.textContent = m.momentum.toFixed(2);
    metricMatch.textContent = `${(m.matchScore * 100).toFixed(0)}%`;
    metricBuffer.textContent = `${m.bufferPct}%`;

    probUpEl.textContent = `${m.probUp}%`;
    probDownEl.textContent = `${m.probDown}%`;
    probUpFill.style.width = `${m.probUp}%`;
    probDownFill.style.width = `${m.probDown}%`;
    confValueEl.textContent = `${m.confidence}%`;
  }

  function resetMetricsUI() {
    metricPos.textContent = '—';
    metricSpeed.textContent = '—';
    metricDirection.textContent = '—';
    metricDirection.style.color = 'var(--text-0)';
    metricMomentum.textContent = '—';
    metricMatch.textContent = '—';
    metricBuffer.textContent = '0%';
    probUpEl.textContent = '—';
    probDownEl.textContent = '—';
    probUpFill.style.width = '0%';
    probDownFill.style.width = '0%';
    confValueEl.textContent = '—';
    historyCtx.clearRect(0, 0, historyCanvas.width, historyCanvas.height);
  }

  function drawReticle(x, y, color) {
    clearOverlay();
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dispW = vw * scale, dispH = vh * scale;
    const offX = (rect.width - dispW) / 2;
    const offY = (rect.height - dispH) / 2;
    const dpr = window.devicePixelRatio || 1;

    const cx = (offX + x * scale) * dpr;
    const cy = (offY + y * scale) * dpr;
    const r = 14 * dpr;

    octx.save();
    octx.strokeStyle = color;
    octx.lineWidth = 2 * dpr;
    octx.beginPath();
    octx.arc(cx, cy, r, 0, Math.PI * 2);
    octx.stroke();
    octx.beginPath();
    octx.moveTo(cx - r * 1.6, cy);
    octx.lineTo(cx - r * 0.6, cy);
    octx.moveTo(cx + r * 0.6, cy);
    octx.lineTo(cx + r * 1.6, cy);
    octx.moveTo(cx, cy - r * 1.6);
    octx.lineTo(cx, cy - r * 0.6);
    octx.moveTo(cx, cy + r * 0.6);
    octx.lineTo(cx, cy + r * 1.6);
    octx.stroke();
    octx.restore();
  }

  function clearOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }

  function drawHistoryChart() {
    const w = historyCanvas.clientWidth || 280;
    const h = historyCanvas.clientHeight || 140;
    const dpr = window.devicePixelRatio || 1;
    if (historyCanvas.width !== w * dpr || historyCanvas.height !== h * dpr) {
      historyCanvas.width = w * dpr;
      historyCanvas.height = h * dpr;
    }
    historyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    historyCtx.clearRect(0, 0, w, h);

    if (buffer.length < 2) return;

    const ys = buffer.map(p => p.y);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 8;
    const range = (maxY - minY) || 1;
    const t0 = buffer[0].t, t1 = buffer[buffer.length - 1].t;
    const tRange = (t1 - t0) || 1;

    historyCtx.strokeStyle = '#2a313b';
    historyCtx.lineWidth = 1;
    historyCtx.beginPath();
    historyCtx.moveTo(0, h / 2);
    historyCtx.lineTo(w, h / 2);
    historyCtx.stroke();

    historyCtx.strokeStyle = '#f5a623';
    historyCtx.lineWidth = 1.8;
    historyCtx.beginPath();
    buffer.forEach((p, i) => {
      const px = ((p.t - t0) / tRange) * w;
      // invert Y since screen-y-down should plot as "up" visually for intuitiveness
      const py = pad + (1 - (p.y - minY) / range) * (h - pad * 2);
      if (i === 0) historyCtx.moveTo(px, py);
      else historyCtx.lineTo(px, py);
    });
    historyCtx.stroke();
  }

  // ---------- Cleanup ----------
  function stopEverything(keepLog) {
    stopTracking();
    if (templateMat) { templateMat.delete(); templateMat = null; }
    buffer = [];
    lastPoint = null;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    hasSource = false;
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
    stage.classList.remove('has-video');
    stageEmpty.style.display = 'flex';
    btnStart.disabled = true;
    btnStop.disabled = true;
    btnReset.disabled = true;
    captureHint.textContent = 'Share your screen, use the camera, or upload a video, then click a point on the chart to track';
    setStatus('Idle', null);
    clearOverlay();
    resetMetricsUI();
    if (!keepLog) log('Session reset.');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Initial UI state
  resetMetricsUI();
  log('App loaded. Waiting for OpenCV.js and screen share permission.');
})();
