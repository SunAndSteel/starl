import "./styles.css";

import { createDashboard } from "./renderers/dashboard.js";
import { createPanelLayout } from "./renderers/layout.js";
import { createSkyRenderer } from "./renderers/skyView.js";
import { createSocketClient } from "./socket.js";
import {
  azelToXYZ,
  buildPerpendicularBasis,
  buildFovBoundaryVectors,
  clamp,
  gridCellToAzEl,
  normalizeVec3,
  normalizeProjection,
  slerp,
  xyzToAzEl,
} from "./skyMath.js";

const canvas = document.getElementById("scene");
const skyCanvas = document.getElementById("sky-scene");
const skyStatus = document.getElementById("sky-status");
const skyClusters = document.getElementById("sky-clusters");
const exportButton = document.getElementById("export-button");
const resetButton = document.getElementById("reset-button");
const tleRefreshButton = document.getElementById("tle-refresh-button");
const skyCameraResetButton = document.getElementById("sky-camera-reset");
const observerLatitudeInput = document.getElementById("observer-latitude");
const observerLongitudeInput = document.getElementById("observer-longitude");
const observerAltitudeInput = document.getElementById("observer-altitude");
const observerSaveButton = document.getElementById("observer-save-button");
const observerInputs = [observerLatitudeInput, observerLongitudeInput, observerAltitudeInput];
const MAX_RENDERED_SATELLITES = 24;
const SEGMENT_RETENTION_MS = 1200;
const EMPTY_FLOAT32 = new Float32Array(0);
const SKY_WORLD_RADIUS = 1.0;
const GRID_LAYER_RADII = {
  average: SKY_WORLD_RADIUS + 0.01,
  current: SKY_WORLD_RADIUS + 0.018,
  mask: SKY_WORLD_RADIUS + 0.026,
  tracks: SKY_WORLD_RADIUS + 0.034,
  clusters: SKY_WORLD_RADIUS + 0.05,
  fov: SKY_WORLD_RADIUS + 0.038,
  satellites: SKY_WORLD_RADIUS + 0.058,
};
const DISH_AXIS_RADIUS = SKY_WORLD_RADIUS + 0.18;

function createFallbackRenderer(surface) {
  return {
    render() {},
    layout() {
      return createPanelLayout(surface.clientWidth, surface.clientHeight);
    },
    destroy() {},
  };
}

let renderer = null;
let rendererSupportsWebgl = true;
let initialRenderError = "";
let skyRenderer = null;
let skyRendererSupportsWebgl = true;
let initialSkyRenderError = "";

try {
  renderer = createDashboard(canvas);
} catch (error) {
  console.error("WebGL renderer initialization failed, using fallback overlay.", error);
  rendererSupportsWebgl = false;
  initialRenderError = error?.message || "WebGL renderer initialization failed.";
  renderer = createFallbackRenderer(canvas);
}

try {
  skyRenderer = createSkyRenderer(skyCanvas);
} catch (error) {
  console.error("Sky WebGL renderer initialization failed.", error);
  skyRendererSupportsWebgl = false;
  initialSkyRenderError = error?.message || "Sky WebGL renderer initialization failed.";
}

const state = {
  snapshot: null,
  dirty: true,
  renderMode: rendererSupportsWebgl ? "webgl" : "fallback",
  renderError: initialRenderError,
  rendererSupportsWebgl,
  observerSaving: false,
  manualObserverDraft: null,
  skyRendererSupportsWebgl,
  skyRenderError: initialSkyRenderError,
  satelliteSegments: new Map(),
};

const pill = document.getElementById("connection-pill");
const connectionDetail = document.getElementById("connection-detail");
const renderModeLabel = document.getElementById("render-mode-label");
const renderModeToggle = document.getElementById("render-mode-toggle");
const statusGrid = document.getElementById("status-grid");
const throughputDetails = document.getElementById("throughput-details");
const alertsList = document.getElementById("alerts-list");
const throughputAnnotations = document.getElementById("throughput-annotations");
const bufferbloatAnnotations = document.getElementById("bufferbloat-annotations");
const throughputCaption = document.getElementById("throughput-caption");
const bufferbloatCaption = document.getElementById("bufferbloat-caption");
const throughputOverlay = document.getElementById("throughput-overlay");
const bufferbloatOverlay = document.getElementById("bufferbloat-overlay");
const overlayElements = [throughputOverlay, bufferbloatOverlay];

const layerInputs = {
  current: document.getElementById("layer-current"),
  average: document.getElementById("layer-average"),
  mask: document.getElementById("layer-mask"),
  tracks: document.getElementById("layer-tracks"),
  live: document.getElementById("layer-live"),
  dish: document.getElementById("layer-dish"),
  clusters: document.getElementById("layer-clusters"),
};

const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
const skyDebugEnabled = (() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("debugSky") === "1") {
    return true;
  }
  try {
    return window.localStorage.getItem("starl.debug.sky") === "1";
  } catch {
    return false;
  }
})();
const skyDebugState = {
  lastSummaryAt: 0,
  lastSegmentSignature: "",
};

function requestRender() {
  state.dirty = true;
}

function skyDebugLog(event, details = {}) {
  if (!skyDebugEnabled) {
    return;
  }
  console.info(`[starl:sky] ${event}`, details);
}

skyDebugLog("enabled", {
  dashboardWebgl: rendererSupportsWebgl,
  skyWebgl: skyRendererSupportsWebgl,
  query: window.location.search,
});

function parseDecimalInput(value) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => (
    {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]
  ));
}

function applyRenderMode() {
  const usingFallback = state.renderMode === "fallback";
  const webglAvailable = state.rendererSupportsWebgl;
  const showDashboardFallback = usingFallback || !state.rendererSupportsWebgl;
  for (const element of overlayElements) {
    element.classList.toggle("panel-overlay-visible", showDashboardFallback);
  }

  if (!webglAvailable) {
    renderModeLabel.textContent = "Render: Fallback only";
    renderModeToggle.textContent = "Fallback only";
    renderModeToggle.disabled = true;
    renderModeToggle.title = state.renderError || "WebGL is unavailable in this session.";
    return;
  }

  renderModeLabel.textContent = usingFallback ? "Render: Fallback" : "Render: WebGL";
  renderModeToggle.textContent = usingFallback ? "Use WebGL" : "Use Fallback";
  renderModeToggle.disabled = false;
  if (state.renderError) {
    renderModeToggle.title = state.renderError;
  } else {
    renderModeToggle.removeAttribute("title");
  }
}

function formatBps(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(2)} Gbps`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(1)} Mbps`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(1)} Kbps`;
  }
  return `${value.toFixed(0)} bps`;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} ms` : "n/a";
}

function formatPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/a";
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) {
    return "n/a";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours}h ${minutes.toString().padStart(2, "0")}m ${secs.toString().padStart(2, "0")}s`;
}

function metricCard(label, value) {
  return `
    <div class="metric">
      <span class="metric-label">${label}</span>
      <span class="metric-value">${value}</span>
    </div>
  `;
}

function detailRow(label, value) {
  return `
    <div class="detail-row">
      <strong>${label}</strong>
      <span>${value}</span>
    </div>
  `;
}

function renderSidebar(snapshot) {
  const status = snapshot?.status || {};
  const throughput = snapshot?.throughput || {};
  const autorate = throughput.autorate || {};
  const meta = snapshot?.meta || {};

  statusGrid.innerHTML = [
    metricCard("State", status.state || "Unknown"),
    metricCard("Latency", formatMs(status.latency_ms)),
    metricCard("Drop", formatPct(status.drop_rate)),
    metricCard("Downlink", formatBps(status.downlink_bps)),
    metricCard("Uplink", formatBps(status.uplink_bps)),
    metricCard("Uptime", formatUptime(status.uptime_s)),
    metricCard("Samples", `${meta.sample_count || 0}`),
    metricCard("Worker", meta.worker_error ? "Error" : "OK"),
  ].join("");

  throughputDetails.innerHTML = [
    detailRow("Optimal downlink", formatBps(throughput.optimal?.downlink_bps || 0)),
    detailRow("Optimal uplink", formatBps(throughput.optimal?.uplink_bps || 0)),
    detailRow("Confidence", `${Math.round((throughput.confidence || 0) * 100)}% from ${throughput.valid_sample_count || 0} valid samples`),
    detailRow("Autorate phase", `${autorate.phase || "INIT"} — ${autorate.reason || "n/a"}`),
    meta.worker_error ? detailRow("Worker error", meta.worker_error) : "",
  ].join("");

  const alerts = snapshot?.alerts || {};
  const active = Object.entries(alerts).filter(([, value]) => value);
  alertsList.innerHTML = active.length
    ? active.slice(0, 6).map(([name]) => detailRow(name.replace(/^alert_/, "").replaceAll("_", " "), "active")).join("")
    : '<div class="detail-row muted">No active alerts</div>';
}

function lerp(start, end, alpha) {
  return start + (end - start) * alpha;
}

function scaleVector(vector, radius) {
  return [
    vector[0] * radius,
    vector[1] * radius,
    vector[2] * radius,
  ];
}

function isGridCellInsideProjection(x, y, projection) {
  const dx = ((x + 0.5) - projection.centerX) / projection.radius;
  const dy = (projection.centerY - (y + 0.5)) / projection.radius;
  return ((dx * dx) + (dy * dy)) <= 1;
}

function createGridCellProjector(projection, dish) {
  const dishAzimuth = Number(dish?.azimuth);
  const dishElevation = Number(dish?.elevation);
  const halfAngleDeg = Number(dish?.fov_half_angle_deg ?? 55);
  const hasDishPose = Number.isFinite(dishAzimuth) && Number.isFinite(dishElevation) && Number.isFinite(halfAngleDeg);
  const dishVector = hasDishPose ? azelToXYZ(dishAzimuth, dishElevation) : null;
  const basis = hasDishPose ? buildPerpendicularBasis(dishVector) : null;
  const halfAngleRad = hasDishPose ? (halfAngleDeg * Math.PI / 180) : 0;

  return (x, y) => {
    const radialX = ((x + 0.5) - projection.centerX) / projection.radius;
    const radialY = (projection.centerY - (y + 0.5)) / projection.radius;
    const radial = Math.hypot(radialX, radialY);
    if (radial > 1) {
      return null;
    }

    if (!hasDishPose) {
      const { azimuth, elevation } = gridCellToAzEl(x, y, projection);
      return azelToXYZ(azimuth, elevation);
    }

    const phi = Math.atan2(radialX, radialY);
    const theta = radial * halfAngleRad;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    const radialBasis = [
      Math.cos(phi) * basis.u[0] + Math.sin(phi) * basis.v[0],
      Math.cos(phi) * basis.u[1] + Math.sin(phi) * basis.v[1],
      Math.cos(phi) * basis.u[2] + Math.sin(phi) * basis.v[2],
    ];
    return normalizeVec3([
      (dishVector[0] * cosTheta) + (radialBasis[0] * sinTheta),
      (dishVector[1] * cosTheta) + (radialBasis[1] * sinTheta),
      (dishVector[2] * cosTheta) + (radialBasis[2] * sinTheta),
    ]);
  };
}

function parseUnixTimestampMs(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : NaN;
}

function parseSegmentPayload(segment, index) {
  const segmentId = String(segment?.segment_id ?? `segment-${index}`);
  const satId = String(segment?.sat_id ?? segment?.norad_id ?? `sat-${index}`);
  const trackEntries = Array.isArray(segment?.track) ? segment.track : [];
  if (trackEntries.length < 2) {
    return null;
  }

  const rawQualityEntries = Array.isArray(segment?.quality_track) ? segment.quality_track : [];
  const beamQualityEntries = Array.isArray(segment?.beam_quality_track) && segment.beam_quality_track.length
    ? segment.beam_quality_track
    : rawQualityEntries;
  const track = [];

  for (let pointIndex = 0; pointIndex < trackEntries.length; pointIndex += 1) {
    const point = trackEntries[pointIndex];
    const timestamp = Number(point?.[0]);
    const azimuth = Number(point?.[1]);
    const elevation = Number(point?.[2]);
    if (!Number.isFinite(timestamp) || !Number.isFinite(azimuth) || !Number.isFinite(elevation)) {
      continue;
    }
    const rawQuality = Number(rawQualityEntries[pointIndex]?.[1]);
    const beamQuality = Number(beamQualityEntries[pointIndex]?.[1]);
    track.push({
      t: timestamp,
      azimuth,
      elevation,
      vector: azelToXYZ(azimuth, elevation),
      rawQuality: Number.isFinite(rawQuality) ? rawQuality : 0,
      quality: Number.isFinite(beamQuality) ? beamQuality : 0,
    });
  }

  if (track.length < 2) {
    return null;
  }

  const tEntryMs = parseUnixTimestampMs(segment?.t_entry);
  const tExitMs = parseUnixTimestampMs(segment?.t_exit);
  if (!Number.isFinite(tEntryMs) || !Number.isFinite(tExitMs) || tEntryMs >= tExitMs) {
    return null;
  }

  return {
    segmentId,
    satId,
    name: String(segment?.name ?? segment?.sat_id ?? `SAT-${index + 1}`),
    tEntryMs,
    tExitMs,
    track,
    lastSeenAt: Date.now(),
    missingSince: null,
  };
}

function placeOverlay(element, panel) {
  element.style.left = `${panel.x}px`;
  element.style.top = `${panel.y}px`;
  element.style.width = `${panel.width}px`;
  element.style.height = `${panel.height}px`;
}

function placeCaptions(layout) {
  throughputCaption.style.left = `${layout.throughput.x + 20}px`;
  throughputCaption.style.top = `${layout.throughput.y + 18}px`;
  bufferbloatCaption.style.left = `${layout.bufferbloat.x + 20}px`;
  bufferbloatCaption.style.top = `${layout.bufferbloat.y + 18}px`;
}

function renderPanelOverlays(snapshot) {
  const layout = renderer.layout();
  placeCaptions(layout);
  placeOverlay(throughputOverlay, layout.throughput);
  placeOverlay(bufferbloatOverlay, layout.bufferbloat);
  placeOverlay(throughputAnnotations, layout.throughput);
  placeOverlay(bufferbloatAnnotations, layout.bufferbloat);
  renderThroughputOverlay(snapshot);
  renderBufferbloatOverlay(snapshot, layout.bufferbloat);
  renderThroughputAnnotations(snapshot, layout.throughput);
  renderBufferbloatAnnotations(snapshot, layout.bufferbloat);
}

function renderThroughputOverlay(snapshot) {
  const throughput = snapshot?.throughput || {};
  const currentDown = Number(throughput.current?.downlink_bps) || 0;
  const currentUp = Number(throughput.current?.uplink_bps) || 0;
  const optimalDown = Number(throughput.optimal?.downlink_bps) || 0;
  const optimalUp = Number(throughput.optimal?.uplink_bps) || 0;
  const recommendedDown = Number(throughput.autorate?.recommended_downlink_bps) || optimalDown;
  const recommendedUp = Number(throughput.autorate?.recommended_uplink_bps) || optimalUp;

  const visualMaxDown = Math.max(currentDown, optimalDown, Math.min(recommendedDown, Math.max(optimalDown * 1.4, currentDown * 1.4, 1)), 1);
  const visualMaxUp = Math.max(currentUp, optimalUp, Math.min(recommendedUp, Math.max(optimalUp * 1.4, currentUp * 1.4, 1)), 1);

  throughputOverlay.innerHTML = `
    <div class="throughput-shell">
      ${throughputLane("Downlink", currentDown, optimalDown, recommendedDown, visualMaxDown)}
      ${throughputLane("Uplink", currentUp, optimalUp, recommendedUp, visualMaxUp)}
    </div>
  `;
}

function throughputLane(label, current, optimal, recommended, maxValue) {
  const optimalWidth = clamp((optimal / maxValue) * 100, 0, 100);
  const currentWidth = clamp((current / maxValue) * 100, 0, 100);
  const markerLeft = clamp((recommended / maxValue) * 100, 0, 100);
  return `
    <div class="throughput-lane">
      <div class="throughput-lane-label">${label}</div>
      <div class="throughput-bar">
        <div class="throughput-fill-optimal" style="left:0;width:${optimalWidth}%"></div>
        <div class="throughput-fill-current" style="left:0;width:${currentWidth}%"></div>
        <div class="throughput-marker" style="left:calc(${markerLeft}% - 1px)"></div>
      </div>
      <div class="throughput-meta">
        <span>${formatBps(current)}</span>
        <span>${formatBps(optimal)}</span>
      </div>
    </div>
  `;
}

function renderThroughputAnnotations(snapshot, panel) {
  const throughput = snapshot?.throughput || {};
  const autorate = throughput.autorate || {};
  const firstReadoutTop = Math.round(Math.max(108, panel.height * 0.24));
  const secondReadoutTop = Math.round(Math.max(260, panel.height * 0.50));
  throughputAnnotations.innerHTML = `
    <div class="graph-stat-row">
      <span>Confidence ${Math.round((throughput.confidence || 0) * 100)}%</span>
      <span>${throughput.valid_sample_count || 0} valid samples</span>
      <span>Down target ${formatBps(autorate.recommended_downlink_bps)}</span>
      <span>Up target ${formatBps(autorate.recommended_uplink_bps)}</span>
    </div>
    <div class="throughput-readout" style="top:${firstReadoutTop}px">
      <div class="throughput-readout-label">Downlink</div>
      <div class="throughput-readout-values">
        <span>Current ${formatBps(throughput.current?.downlink_bps)}</span>
        <span>Optimal ${formatBps(throughput.optimal?.downlink_bps)}</span>
      </div>
    </div>
    <div class="throughput-readout" style="top:${secondReadoutTop}px">
      <div class="throughput-readout-label">Uplink</div>
      <div class="throughput-readout-values">
        <span>Current ${formatBps(throughput.current?.uplink_bps)}</span>
        <span>Optimal ${formatBps(throughput.optimal?.uplink_bps)}</span>
      </div>
    </div>
  `;
}

function renderBufferbloatOverlay(snapshot, panel) {
  const buckets = snapshot?.bufferbloat || [];
  if (!buckets.length) {
    bufferbloatOverlay.innerHTML = "";
    return;
  }

  const width = Math.max(panel.width - 30, 1);
  const height = Math.max(panel.height - 42, 1);
  const padding = { left: 18, right: 18, top: 40, bottom: 26 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxLatency = Math.max(...buckets.map((bucket) => bucket.max_latency_ms), 1);
  const minLoad = buckets[0].load_min_bps;
  const maxLoad = buckets[buckets.length - 1].load_max_bps;
  const logMin = Math.log10(minLoad);
  const logMax = Math.log10(maxLoad);

  const xFor = (load) => padding.left + ((Math.log10(load) - logMin) / Math.max(logMax - logMin, 1e-6)) * plotWidth;
  const yFor = (latency) => padding.top + (1 - latency / maxLatency) * plotHeight;

  const topLine = [];
  const bottomLine = [];
  const median = [];
  const points = [];
  for (const bucket of buckets) {
    const x = xFor(bucket.load_mid_bps);
    const y = yFor(bucket.median_latency_ms);
    topLine.push(`${x},${y}`);
    bottomLine.unshift(`${x},${padding.top + plotHeight}`);
    median.push(`${x},${y}`);
    points.push(`<circle class="bufferbloat-point" cx="${x}" cy="${y}" r="2.5" />`);
  }

  bufferbloatOverlay.innerHTML = `
    <svg class="bufferbloat-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line class="bufferbloat-axis" x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${padding.left + plotWidth}" y2="${padding.top + plotHeight}" />
      <polygon class="bufferbloat-band" points="${topLine.concat(bottomLine).join(" ")}" />
      <polyline class="bufferbloat-line" points="${median.join(" ")}" />
      ${points.join("")}
    </svg>
  `;
}

function renderBufferbloatAnnotations(snapshot, panel) {
  const buckets = snapshot?.bufferbloat || [];
  if (!buckets.length) {
    bufferbloatAnnotations.innerHTML = "";
    return;
  }

  const lastBucket = buckets.at(-1);
  const maxLatency = Math.max(...buckets.map((bucket) => bucket.max_latency_ms));
  const lowLoad = buckets[0].load_min_bps;
  const highLoad = buckets[buckets.length - 1].load_max_bps;

  bufferbloatAnnotations.innerHTML = `
    <div class="graph-stat-row graph-stat-row-right">
      <span>${buckets.length} buckets</span>
      <span>Latest ${formatMs(lastBucket.median_latency_ms)}</span>
      <span>Low ${formatBps(lowLoad)}</span>
      <span>High ${formatBps(highLoad)}</span>
    </div>
    <div class="bufferbloat-axis-label bufferbloat-axis-top" style="top:${Math.round(panel.height * 0.16)}px">${formatMs(maxLatency)}</div>
    <div class="bufferbloat-axis-label bufferbloat-axis-bottom" style="bottom:${Math.round(panel.height * 0.13)}px">0 ms</div>
    <div class="bufferbloat-axis-label bufferbloat-axis-left">Low load ${formatBps(lowLoad)}</div>
    <div class="bufferbloat-axis-label bufferbloat-axis-right">High load ${formatBps(highLoad)}</div>
    <div class="bufferbloat-axis-label bufferbloat-axis-note">Median latency vs load</div>
  `;
}

function updateSatelliteSegments(snapshot, now = Date.now()) {
  const sky = snapshot?.sky || {};
  const nextSegments = Array.isArray(sky.satellite_segments) ? sky.satellite_segments : [];
  const previousIds = new Set(state.satelliteSegments.keys());
  const updatedSegments = new Map();

  nextSegments.forEach((segment, index) => {
    const parsed = parseSegmentPayload(segment, index);
    if (!parsed) {
      return;
    }
    const previous = state.satelliteSegments.get(parsed.segmentId);
    updatedSegments.set(parsed.segmentId, {
      ...previous,
      ...parsed,
      lastSeenAt: now,
      missingSince: null,
    });
  });

  for (const [segmentId, previous] of state.satelliteSegments.entries()) {
    if (updatedSegments.has(segmentId)) {
      continue;
    }
    if (now <= previous.tExitMs + SEGMENT_RETENTION_MS) {
      updatedSegments.set(segmentId, {
        ...previous,
        missingSince: previous.missingSince ?? now,
      });
    }
  }

  state.satelliteSegments = updatedSegments;
  if (skyDebugEnabled) {
    const currentIds = Array.from(updatedSegments.keys());
    const added = currentIds.filter((segmentId) => !previousIds.has(segmentId)).slice(0, 8);
    const removed = Array.from(previousIds).filter((segmentId) => !updatedSegments.has(segmentId)).slice(0, 8);
    const signature = `${updatedSegments.size}|${added.join(",")}|${removed.join(",")}`;
    if (signature !== skyDebugState.lastSegmentSignature) {
      skyDebugState.lastSegmentSignature = signature;
      skyDebugLog("segments", {
        total: updatedSegments.size,
        added,
        removed,
      });
    }
  }
}

function findTrackIndex(track, nowSeconds) {
  if (!track?.length || track.length < 2) {
    return -1;
  }
  if (nowSeconds < track[0].t || nowSeconds >= track[track.length - 1].t) {
    return -1;
  }
  let low = 0;
  let high = track.length - 2;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (track[mid].t <= nowSeconds && nowSeconds < track[mid + 1].t) {
      return mid;
    }
    if (nowSeconds < track[mid].t) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return -1;
}

function buildLiveSatelliteFallback(liveSatellites) {
  if (!Array.isArray(liveSatellites) || !liveSatellites.length) {
    return [];
  }
  const satellites = [];
  liveSatellites.forEach((entry, index) => {
    const azimuth = Number(entry?.azimuth);
    const elevation = Number(entry?.elevation);
    if (!Number.isFinite(azimuth) || !Number.isFinite(elevation)) {
      return;
    }
    const quality = Number(entry?.beam_quality ?? entry?.quality);
    satellites.push({
      key: String(entry?.segment_id ?? `live-${index}`),
      satId: String(entry?.sat_id ?? `live-${index}`),
      name: String(entry?.name ?? entry?.sat_id ?? `SAT-${index + 1}`),
      vector: azelToXYZ(azimuth, elevation),
      azimuth,
      elevation,
      quality: Number.isFinite(quality) ? clamp(quality, 0, 1) : 0.5,
      rawQuality: Number.isFinite(quality) ? quality : 0.5,
      opacity: 1,
    });
  });
  satellites.sort((left, right) => (right.quality - left.quality) || (right.elevation - left.elevation));
  return satellites.slice(0, MAX_RENDERED_SATELLITES);
}

function animatedLiveSatellites(now = Date.now(), liveSatellites = null) {
  const satellites = [];
  const nowSeconds = now / 1000;

  for (const segment of state.satelliteSegments.values()) {
    if (now < segment.tEntryMs || now > segment.tExitMs) {
      continue;
    }
    const trackIndex = findTrackIndex(segment.track, nowSeconds);
    if (trackIndex < 0) {
      continue;
    }

    const start = segment.track[trackIndex];
    const end = segment.track[trackIndex + 1];
    const alpha = clamp((nowSeconds - start.t) / Math.max(end.t - start.t, 1e-6), 0, 1);
    const vector = slerp(start.vector, end.vector, alpha);
    const { azimuth, elevation } = xyzToAzEl(vector);

    satellites.push({
      key: segment.segmentId,
      satId: segment.satId,
      name: segment.name,
      vector,
      azimuth,
      elevation,
      quality: lerp(start.quality, end.quality, alpha),
      rawQuality: lerp(start.rawQuality, end.rawQuality, alpha),
      opacity: 1,
    });
  }

  satellites.sort((left, right) => (right.quality - left.quality) || (right.elevation - left.elevation));
  const interpolated = satellites.slice(0, MAX_RENDERED_SATELLITES);
  if (interpolated.length) {
    return interpolated;
  }
  return buildLiveSatelliteFallback(liveSatellites);
}

function satelliteAnimationActive(now = Date.now()) {
  if (!layerInputs.live.checked) {
    return false;
  }

  for (const segment of state.satelliteSegments.values()) {
    if (segment.track?.length >= 2 && now >= segment.tEntryMs && now <= segment.tExitMs) {
      return true;
    }
  }

  return false;
}

function buildGridPointLayer(grid, width, height, projection, projectCellVector, radius, size, alphaFor) {
  if (!grid?.length || !width || !height) {
    return EMPTY_FLOAT32;
  }

  const values = [];
  for (let y = 0; y < Math.min(height, grid.length); y += 1) {
    const row = grid[y];
    for (let x = 0; x < Math.min(width, row.length); x += 1) {
      if (!isGridCellInsideProjection(x, y, projection)) {
        continue;
      }
      const value = Number(row[x]);
      if (!Number.isFinite(value) || value < 0) {
        continue;
      }
      const vector = projectCellVector(x, y);
      if (!vector) {
        continue;
      }
      const point = scaleVector(vector, radius);
      values.push(point[0], point[1], point[2], size, clamp(alphaFor(value), 0.015, 0.42));
    }
  }

  return values.length ? new Float32Array(values) : EMPTY_FLOAT32;
}

function buildMaskPointLayer(mask, width, height, projection, projectCellVector, radius, size) {
  if (!mask?.length || !width || !height) {
    return EMPTY_FLOAT32;
  }

  const values = [];
  for (let y = 0; y < Math.min(height, mask.length); y += 1) {
    const row = mask[y];
    for (let x = 0; x < Math.min(width, row.length); x += 1) {
      if (!isGridCellInsideProjection(x, y, projection)) {
        continue;
      }
      if (!row[x]) {
        continue;
      }
      const vector = projectCellVector(x, y);
      if (!vector) {
        continue;
      }
      const point = scaleVector(vector, radius);
      values.push(point[0], point[1], point[2], size, 0.24);
    }
  }

  return values.length ? new Float32Array(values) : EMPTY_FLOAT32;
}

function buildClusterPointLayer(clusters) {
  if (!clusters?.length) {
    return EMPTY_FLOAT32;
  }

  const values = [];
  clusters.forEach((cluster) => {
    const azimuth = Number(cluster?.centroid?.azimuth);
    const elevation = Number(cluster?.centroid?.elevation);
    if (!Number.isFinite(azimuth) || !Number.isFinite(elevation)) {
      return;
    }
    const radius = GRID_LAYER_RADII.clusters;
    const point = scaleVector(azelToXYZ(azimuth, elevation), radius);
    const size = clamp(9 + Number(cluster?.size || 0) * 0.3, 10, 24);
    const alpha = clamp(0.22 + Number(cluster?.mean_score || 0) * 0.4, 0.24, 0.72);
    values.push(point[0], point[1], point[2], size, alpha);
  });

  return values.length ? new Float32Array(values) : EMPTY_FLOAT32;
}

function buildSatellitePointLayer(satellites, radius) {
  if (!satellites?.length) {
    return EMPTY_FLOAT32;
  }
  const values = [];
  satellites.forEach((satellite) => {
    const point = scaleVector(satellite.vector, radius);
    values.push(
      point[0],
      point[1],
      point[2],
      14,
      clamp(satellite.quality, 0, 1),
      clamp(satellite.opacity, 0, 1),
    );
  });
  return values.length ? new Float32Array(values) : EMPTY_FLOAT32;
}

function buildDishAxisLayer(dish) {
  if (!Number.isFinite(dish?.azimuth) || !Number.isFinite(dish?.elevation)) {
    return EMPTY_FLOAT32;
  }
  const point = scaleVector(azelToXYZ(dish.azimuth, dish.elevation), DISH_AXIS_RADIUS);
  return new Float32Array([
    0, 0, 0, 0.42,
    point[0], point[1], point[2], 0.9,
  ]);
}

function buildFovRingLayer(dish) {
  if (!Number.isFinite(dish?.azimuth) || !Number.isFinite(dish?.elevation)) {
    return EMPTY_FLOAT32;
  }
  const halfAngle = Number(dish?.fov_half_angle_deg ?? 55);
  const boundaryVectors = buildFovBoundaryVectors(
    azelToXYZ(dish.azimuth, dish.elevation),
    halfAngle,
    96,
  );
  const values = [];
  boundaryVectors.forEach((vector) => {
    const point = scaleVector(vector, GRID_LAYER_RADII.fov);
    values.push(point[0], point[1], point[2], 0.74);
  });
  return values.length ? new Float32Array(values) : EMPTY_FLOAT32;
}

function buildFovSpokeLayer(dish) {
  if (!Number.isFinite(dish?.azimuth) || !Number.isFinite(dish?.elevation)) {
    return EMPTY_FLOAT32;
  }
  const halfAngle = Number(dish?.fov_half_angle_deg ?? 55);
  const boundaryVectors = buildFovBoundaryVectors(
    azelToXYZ(dish.azimuth, dish.elevation),
    halfAngle,
    24,
  );
  const values = [];
  boundaryVectors.forEach((vector, index) => {
    if (index === boundaryVectors.length - 1) {
      return;
    }
    const point = scaleVector(vector, GRID_LAYER_RADII.fov);
    values.push(
      0, 0, 0, 0.08,
      point[0], point[1], point[2], 0.24,
    );
  });
  return values.length ? new Float32Array(values) : EMPTY_FLOAT32;
}

function buildSkyScene(snapshot, projection, active, now) {
  const sky = snapshot?.sky || {};
  const dimensions = sky.dimensions || { width: 0, height: 0 };
  const width = dimensions.width || 0;
  const height = dimensions.height || 0;
  const layers = sky.layers || {};
  const dish = sky.dish || {};
  const clusters = sky.persistent_obstructions?.clusters || [];
  const cellRadius = width && height ? clamp(920 / Math.max(width, height), 2.2, 7.5) : 4.5;
  const projectCellVector = createGridCellProjector(projection, dish);
  const satellites = active.live ? animatedLiveSatellites(now, sky.live_satellites) : [];

  return {
    layers: [
      {
        points: active.average
          ? buildGridPointLayer(layers.average, width, height, projection, projectCellVector, GRID_LAYER_RADII.average, cellRadius, (value) => 0.02 + (1 - value) * 0.22)
          : EMPTY_FLOAT32,
        color: [1, 1, 1],
      },
      {
        points: active.current
          ? buildGridPointLayer(layers.current, width, height, projection, projectCellVector, GRID_LAYER_RADII.current, cellRadius, (value) => 0.03 + (1 - value) * 0.28)
          : EMPTY_FLOAT32,
        color: [1, 1, 1],
      },
      {
        points: active.mask
          ? buildMaskPointLayer(layers.persistent_mask, width, height, projection, projectCellVector, GRID_LAYER_RADII.mask, cellRadius + 1)
          : EMPTY_FLOAT32,
        color: [1, 1, 1],
      },
      {
        points: active.tracks
          ? buildGridPointLayer(layers.satellite_tracks, width, height, projection, projectCellVector, GRID_LAYER_RADII.tracks, Math.max(1.8, cellRadius * 0.64), (value) => 0.08 + value * 0.35)
          : EMPTY_FLOAT32,
        color: [1, 1, 1],
      },
      {
        points: active.clusters
          ? buildClusterPointLayer(clusters)
          : EMPTY_FLOAT32,
        color: [1, 1, 1],
      },
    ],
    satellites: buildSatellitePointLayer(satellites, GRID_LAYER_RADII.satellites),
    lineLayers: [
      {
        points: active.dish ? buildDishAxisLayer(dish) : EMPTY_FLOAT32,
        color: [1, 1, 1],
        primitive: "lines",
      },
      {
        points: active.dish ? buildFovSpokeLayer(dish) : EMPTY_FLOAT32,
        color: [1, 1, 1],
        primitive: "lines",
      },
      {
        points: active.dish ? buildFovRingLayer(dish) : EMPTY_FLOAT32,
        color: [1, 1, 1],
        primitive: "line strip",
      },
    ],
  };
}

function logSkySummary(snapshot, projection, active, animatedSatellites, useSkyWebgl, now) {
  if (!skyDebugEnabled || (now - skyDebugState.lastSummaryAt) < 5000) {
    return;
  }
  skyDebugState.lastSummaryAt = now;
  const sky = snapshot?.sky || {};
  const dish = sky.dish || {};
  const observer = sky.observer || null;
  const tle = sky.tle || {};
  skyDebugLog("summary", {
    renderMode: state.renderMode,
    skyRenderer: useSkyWebgl ? "webgl" : "unavailable",
    dashboardWebgl: state.rendererSupportsWebgl,
    skyWebgl: state.skyRendererSupportsWebgl,
    activeLayers: Object.entries(active)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key),
    projection: projection.referenceFrame,
    observer: observer
      ? {
          latitude: observer.latitude,
          longitude: observer.longitude,
          altitude_m: observer.altitude_m,
          source: observer.source,
        }
      : null,
    dish: Number.isFinite(dish.azimuth) && Number.isFinite(dish.elevation)
      ? {
          azimuth: Number(dish.azimuth).toFixed(2),
          elevation: Number(dish.elevation).toFixed(2),
          fov_total_angle_deg: dish.fov_total_angle_deg,
        }
      : null,
    activeSegments: state.satelliteSegments.size,
    animatedSatellites: animatedSatellites.length,
    liveListCount: Array.isArray(sky.live_satellites) ? sky.live_satellites.length : 0,
    tle: {
      satelliteCount: tle.satellite_count,
      visibleCount: tle.visible_count,
      activeSegmentCount: tle.active_segment_count,
      available: tle.available,
      error: tle.error || null,
    },
    topSatellites: animatedSatellites.slice(0, 5).map((satellite) => ({
      satId: satellite.satId,
      quality: Number(satellite.quality).toFixed(3),
      elevation: Number(satellite.elevation).toFixed(2),
    })),
  });
}

function observerDisplayValue(value) {
  return Number.isFinite(Number(value)) ? String(value) : "";
}

function renderSkyView(snapshot, now = Date.now()) {
  const sky = snapshot?.sky || {};
  const dimensions = sky.dimensions || { width: 0, height: 0 };
  const width = dimensions.width || 0;
  const height = dimensions.height || 0;
  const projection = normalizeProjection(width, height, sky.projection || {});
  const layers = sky.layers || {};
  const clusters = sky.persistent_obstructions?.clusters || [];
  const stats = sky.persistent_obstructions?.stats || {};
  const liveSatellites = sky.live_satellites || [];
  const tle = sky.tle || {};
  const observer = sky.observer;
  const dish = sky.dish || {};
  const useSkyWebgl = !!(state.skyRendererSupportsWebgl && skyRenderer);

  const active = {
    current: layerInputs.current.checked,
    average: layerInputs.average.checked,
    mask: layerInputs.mask.checked,
    tracks: layerInputs.tracks.checked,
    live: layerInputs.live.checked,
    dish: layerInputs.dish.checked,
    clusters: layerInputs.clusters.checked,
  };

  const animatedSatellites = active.live ? animatedLiveSatellites(now, liveSatellites) : [];

  skyCanvas.style.display = useSkyWebgl ? "block" : "none";
  if (useSkyWebgl) {
    try {
      skyRenderer.render(buildSkyScene(snapshot, projection, active, now));
      state.skyRenderError = "";
    } catch (error) {
      console.error("Sky WebGL draw failed.", error);
      state.skyRendererSupportsWebgl = false;
      state.skyRenderError = error?.message || "Sky WebGL draw failed.";
      skyCanvas.style.display = "none";
    }
  }
  const cameraState = useSkyWebgl && skyRenderer ? skyRenderer.getCameraState() : null;
  const cameraText = cameraState
    ? `Orbit ${(cameraState.theta * 180 / Math.PI).toFixed(0)}°, polar ${(cameraState.phi * 180 / Math.PI).toFixed(0)}°, radius ${cameraState.radius.toFixed(2)}`
    : "Drag to orbit, wheel to zoom";

  const obstructed = stats.obstructed_cells || 0;
  const coverage = Number.isFinite(stats.coverage) ? `${(stats.coverage * 100).toFixed(1)}% sky blocked` : "No obstruction stats";
  const observerText = observer
    ? `${observer.latitude}, ${observer.longitude}${Number.isFinite(observer.altitude_m) ? `, ${Number(observer.altitude_m).toFixed(1)} m` : ""} (${observer.source || "observer"})`
    : "observer unknown";
  const skyRendererLabel = useSkyWebgl ? "WebGL" : `Unavailable${state.skyRenderError ? ` (${state.skyRenderError})` : ""}`;
  const observerInputsFocused = observerInputs.includes(document.activeElement);
  if (observer && !observerInputsFocused && !state.observerSaving) {
    const manualDraft = observer.source === "manual" ? state.manualObserverDraft : null;
    observerLatitudeInput.value = manualDraft?.latitude ?? observerDisplayValue(observer.latitude);
    observerLongitudeInput.value = manualDraft?.longitude ?? observerDisplayValue(observer.longitude);
    observerAltitudeInput.value = manualDraft?.altitude ?? observerDisplayValue(observer.altitude_m);
  }
  skyStatus.innerHTML = `
    <strong>Dish</strong> ${dish.azimuth != null && dish.elevation != null ? `${dish.azimuth.toFixed(1)}° / ${dish.elevation.toFixed(1)}°` : "direction unavailable"}<br>
    <strong>FOV</strong> ${Number.isFinite(dish.fov_total_angle_deg) ? `${Number(dish.fov_total_angle_deg).toFixed(0)}° cone` : "unavailable"}<br>
    <strong>Camera</strong> ${escapeHtml(cameraText)}<br>
    <strong>Sky Renderer</strong> ${escapeHtml(skyRendererLabel)}<br>
    <strong>Observer</strong> ${escapeHtml(observerText)}<br>
    <strong>Obstructions</strong> ${obstructed} cells, ${coverage}<br>
    <strong>Projection</strong> ${escapeHtml(projection.referenceFrame)}
  `;
  skyClusters.innerHTML = `
    <strong>Clusters</strong> ${clusters.length} persistent clusters<br>
    <strong>TLE</strong> ${observer ? (tle.available ? `${tle.active_segment_count || tle.visible_count || animatedSatellites.length || liveSatellites.length} in beam / ${tle.satellite_count} catalogued` : escapeHtml(tle.error || "catalog unavailable")) : "set observer location to enable live satellites"}<br>
    <strong>Tracks</strong> ${(sky.passive_tracking?.total_events || 0)} passive events
  `;
  logSkySummary(snapshot, projection, active, animatedSatellites, !!useSkyWebgl, now);
}

function updateConnectionUi(kind, detail) {
  pill.className = "pill";
  if (kind === "open") {
    pill.classList.add("pill-ok");
    pill.textContent = "Streaming";
  } else if (kind === "reconnecting") {
    pill.classList.add("pill-warn");
    pill.textContent = "Reconnecting";
  } else {
    pill.classList.add("pill-warn");
    pill.textContent = "Connecting";
  }
  connectionDetail.textContent = detail;
}

function switchRenderMode(mode, reason = "") {
  state.renderMode = mode;
  state.renderError = reason;
  skyDebugLog("render-mode", {
    mode,
    reason: reason || null,
    dashboardWebgl: state.rendererSupportsWebgl,
    skyWebgl: state.skyRendererSupportsWebgl,
  });
  applyRenderMode();
  if (state.snapshot) {
    renderSkyView(state.snapshot, Date.now());
  }
  requestRender();
}

function activeExportLayer() {
  if (layerInputs.current.checked) {
    return "current";
  }
  if (layerInputs.average.checked) {
    return "average";
  }
  if (layerInputs.mask.checked) {
    return "mask";
  }
  if (layerInputs.tracks.checked) {
    return "tracks";
  }
  return "average";
}

async function triggerExport() {
  const layer = activeExportLayer();
  const response = await fetch(`/api/export?layer=${encodeURIComponent(layer)}`);
  if (!response.ok) {
    throw new Error(`Export failed with ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `starlink-${layer}.png`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function postJson(url, payload = null) {
  const response = await fetch(url, {
    method: "POST",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}`);
  }
  return response.json();
}

renderModeToggle.addEventListener("click", () => {
  if (!state.rendererSupportsWebgl) {
    return;
  }
  switchRenderMode(state.renderMode === "webgl" ? "fallback" : "webgl");
});

for (const input of Object.values(layerInputs)) {
  input.addEventListener("change", () => {
    if (state.snapshot) {
      renderSkyView(state.snapshot);
    }
  });
}

exportButton.addEventListener("click", async () => {
  try {
    exportButton.disabled = true;
    await triggerExport();
    updateConnectionUi("open", `Exported ${activeExportLayer()} layer as PNG.`);
  } catch (error) {
    console.error(error);
    updateConnectionUi("reconnecting", error?.message || "PNG export failed.");
  } finally {
    exportButton.disabled = false;
  }
});

resetButton.addEventListener("click", async () => {
  try {
    resetButton.disabled = true;
    await postJson("/api/reset");
    updateConnectionUi("open", "Obstruction history reset. Waiting for fresh samples.");
  } catch (error) {
    console.error(error);
    updateConnectionUi("reconnecting", error?.message || "Reset failed.");
  } finally {
    resetButton.disabled = false;
  }
});

tleRefreshButton.addEventListener("click", async () => {
  try {
    tleRefreshButton.disabled = true;
    const result = await postJson("/api/tle/refresh");
    updateConnectionUi("open", result.error ? `TLE refresh error: ${result.error}` : `TLE refresh complete: ${result.satellite_count || 0} satellites.`);
  } catch (error) {
    console.error(error);
    updateConnectionUi("reconnecting", error?.message || "TLE refresh failed.");
  } finally {
    tleRefreshButton.disabled = false;
  }
});

skyCameraResetButton?.addEventListener("click", () => {
  skyRenderer?.resetCamera?.();
  if (state.snapshot) {
    renderSkyView(state.snapshot, Date.now());
  }
});

observerSaveButton.addEventListener("click", async () => {
  const draft = {
    latitude: observerLatitudeInput.value.trim(),
    longitude: observerLongitudeInput.value.trim(),
    altitude: observerAltitudeInput.value.trim() || "0",
  };
  const latitude = parseDecimalInput(draft.latitude);
  const longitude = parseDecimalInput(draft.longitude);
  const altitude = parseDecimalInput(draft.altitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(altitude)) {
    updateConnectionUi("reconnecting", "Enter valid observer latitude, longitude, and altitude.");
    return;
  }
  try {
    state.observerSaving = true;
    state.manualObserverDraft = draft;
    observerSaveButton.disabled = true;
    await postJson("/api/observer", { latitude, longitude, altitude_m: altitude });
    updateConnectionUi("open", `Observer saved at ${draft.latitude}, ${draft.longitude}, ${draft.altitude} m. Refreshing live satellites.`);
    await postJson("/api/tle/refresh");
  } catch (error) {
    console.error(error);
    updateConnectionUi("reconnecting", error?.message || "Observer update failed.");
  } finally {
    state.observerSaving = false;
    observerSaveButton.disabled = false;
  }
});

applyRenderMode();
placeCaptions(renderer.layout());

const socket = createSocketClient({
  url: wsUrl,
  onState(connectionState) {
    updateConnectionUi(
      connectionState,
      connectionState === "open" ? "WebSocket connected to /ws." : "Waiting for backend frames.",
    );
  },
  onMessage(snapshot) {
    const now = Date.now();
    state.snapshot = snapshot;
    if (snapshot?.sky?.observer?.source !== "manual") {
      state.manualObserverDraft = null;
    }
    updateSatelliteSegments(snapshot, now);
    renderSidebar(snapshot);
    renderSkyView(snapshot, now);
    renderPanelOverlays(snapshot);
    updateConnectionUi("open", snapshot.meta?.worker_error || `Streaming ${snapshot.meta?.sample_count || 0} buffered samples.`);
    requestRender();
  },
});

window.addEventListener("resize", () => {
  placeCaptions(renderer.layout());
  if (state.snapshot) {
    renderSkyView(state.snapshot, Date.now());
    renderPanelOverlays(state.snapshot);
    requestRender();
  }
});

socket.start();

function frame() {
  const now = Date.now();
  const cameraChanged = !!skyRenderer?.tick?.();
  const animateSky = !!state.snapshot && (
    satelliteAnimationActive(now)
    || cameraChanged
  );
  if (animateSky) {
    renderSkyView(state.snapshot, now);
  }
  if (state.dirty) {
    if (state.renderMode === "webgl") {
      try {
        renderer.render(state.snapshot);
        if (state.renderError) {
          state.renderError = "";
          applyRenderMode();
          placeCaptions(renderer.layout());
        }
      } catch (error) {
        console.error("WebGL draw failed, switching to fallback overlay.", error);
        switchRenderMode("fallback", error?.message || "WebGL draw failed.");
      }
    }
    state.dirty = false;
  }
  window.requestAnimationFrame(frame);
}

frame();
