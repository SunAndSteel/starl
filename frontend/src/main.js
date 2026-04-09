import "./styles.css";

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

const skyCanvas = document.getElementById("sky-scene");
const skyStage = document.querySelector(".sky-stage");
const skyStatus = document.getElementById("sky-status");
const skyClusters = document.getElementById("sky-clusters");
const exportButton = document.getElementById("export-button");
const tleRefreshButton = document.getElementById("tle-refresh-button");
const skyCameraResetButton = document.getElementById("sky-camera-reset");
const observerLatitudeInput = document.getElementById("observer-latitude");
const observerLongitudeInput = document.getElementById("observer-longitude");
const observerAltitudeInput = document.getElementById("observer-altitude");
const observerSaveButton = document.getElementById("observer-save-button");
const observerInputs = [observerLatitudeInput, observerLongitudeInput, observerAltitudeInput];
const skyCardinals = {
  N: document.getElementById("sky-cardinal-n"),
  S: document.getElementById("sky-cardinal-s"),
  E: document.getElementById("sky-cardinal-e"),
  O: document.getElementById("sky-cardinal-o"),
};
const MAX_RENDERED_SATELLITES = 100;
const SEGMENT_RETENTION_MS = 1200;
const EMPTY_FLOAT32 = new Float32Array(0);
const SKY_WORLD_RADIUS = 1.0;
const GRID_LAYER_RADII = {
  obstruction: SKY_WORLD_RADIUS + 0.03,
  fov: SKY_WORLD_RADIUS + 0.036,
  satellites: SKY_WORLD_RADIUS + 0.058,
};
const DISH_AXIS_RADIUS = SKY_WORLD_RADIUS + 0.18;
let skyRenderer = null;
let skyRendererSupportsWebgl = true;
let initialSkyRenderError = "";

try {
  skyRenderer = createSkyRenderer(skyCanvas);
} catch (error) {
  console.error("Sky WebGL renderer initialization failed.", error);
  skyRendererSupportsWebgl = false;
  initialSkyRenderError = error?.message || "Sky WebGL renderer initialization failed.";
}

const state = {
  snapshot: null,
  connectionState: "connecting",
  connectionDetail: "En attente des trames du backend.",
  observerSaving: false,
  manualObserverDraft: null,
  skyRendererSupportsWebgl,
  skyRenderError: initialSkyRenderError,
  satelliteSegments: new Map(),
};

const statusGrid = document.getElementById("status-grid");

const layerInputs = {
  mask: document.getElementById("layer-mask"),
  live: document.getElementById("layer-live"),
  dish: document.getElementById("layer-dish"),
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

function skyDebugLog(event, details = {}) {
  if (!skyDebugEnabled) {
    return;
  }
  console.info(`[starl:sky] ${event}`, details);
}

skyDebugLog("enabled", {
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

function formatBps(value) {
  if (!Number.isFinite(value)) {
    return "n/d";
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
  return Number.isFinite(value) ? `${value.toFixed(1)} ms` : "n/d";
}

function formatPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/d";
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) {
    return "n/d";
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

function renderSidebar(snapshot) {
  const status = snapshot?.status || {};
  const meta = snapshot?.meta || {};

  statusGrid.innerHTML = [
    metricCard("Etat", status.state || "Inconnu"),
    metricCard("Latence", formatMs(status.latency_ms)),
    metricCard("Perte", formatPct(status.drop_rate)),
    metricCard("Descendant", formatBps(status.downlink_bps)),
    metricCard("Montant", formatBps(status.uplink_bps)),
    metricCard("Uptime", formatUptime(status.uptime_s)),
    metricCard("Echantillons", `${meta.sample_count || 0}`),
    metricCard("Service", meta.worker_error ? "Erreur" : "OK"),
  ].join("");
}

function formatObserverSource(source) {
  if (!source) {
    return "observateur";
  }
  return (
    {
      manual: "manuel",
      config: "config",
      grpc: "grpc",
      gps: "gps",
      api: "api",
      observer: "observateur",
    }[source]
    || source
  );
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

function multiplyMat4Vec4(matrix, vector) {
  return [
    (matrix[0] * vector[0]) + (matrix[4] * vector[1]) + (matrix[8] * vector[2]) + (matrix[12] * vector[3]),
    (matrix[1] * vector[0]) + (matrix[5] * vector[1]) + (matrix[9] * vector[2]) + (matrix[13] * vector[3]),
    (matrix[2] * vector[0]) + (matrix[6] * vector[1]) + (matrix[10] * vector[2]) + (matrix[14] * vector[3]),
    (matrix[3] * vector[0]) + (matrix[7] * vector[1]) + (matrix[11] * vector[2]) + (matrix[15] * vector[3]),
  ];
}

function projectWorldPointToStage(vector, cameraState, stageWidth, stageHeight) {
  if (!cameraState?.viewMatrix || !cameraState?.projectionMatrix) {
    return null;
  }

  const viewPosition = multiplyMat4Vec4(cameraState.viewMatrix, [vector[0], vector[1], vector[2], 1]);
  const clipPosition = multiplyMat4Vec4(cameraState.projectionMatrix, viewPosition);
  const w = clipPosition[3];
  if (!Number.isFinite(w) || Math.abs(w) <= 1e-6) {
    return null;
  }

  const ndcX = clipPosition[0] / w;
  const ndcY = clipPosition[1] / w;
  const ndcZ = clipPosition[2] / w;
  const visible = w > 0 && ndcZ >= -1.1 && ndcZ <= 1.1;
  return {
    x: ((ndcX * 0.5) + 0.5) * stageWidth,
    y: ((-ndcY * 0.5) + 0.5) * stageHeight,
    visible,
  };
}

function updateSkyCardinals(cameraState) {
  if (!skyStage) {
    return;
  }

  const stageWidth = skyStage.clientWidth;
  const stageHeight = skyStage.clientHeight;
  const positions = {
    N: scaleVector(azelToXYZ(0, 0), 1.01),
    S: scaleVector(azelToXYZ(180, 0), 1.01),
    E: scaleVector(azelToXYZ(90, 0), 1.01),
    O: scaleVector(azelToXYZ(270, 0), 1.01),
  };

  Object.entries(skyCardinals).forEach(([label, element]) => {
    if (!element) {
      return;
    }
    const projected = projectWorldPointToStage(positions[label], cameraState, stageWidth, stageHeight);
    if (!projected || !projected.visible) {
      element.style.opacity = "0";
      return;
    }
    element.style.left = `${projected.x}px`;
    element.style.top = `${projected.y}px`;
    element.style.opacity = "1";
  });
}

function addVectors(...vectors) {
  const result = [0, 0, 0];
  vectors.forEach((vector) => {
    if (!vector) {
      return;
    }
    result[0] += vector[0];
    result[1] += vector[1];
    result[2] += vector[2];
  });
  return result;
}

function addTriangle(values, a, b, c) {
  values.push(
    a[0], a[1], a[2],
    b[0], b[1], b[2],
    c[0], c[1], c[2],
  );
}

function addQuad(values, a, b, c, d) {
  addTriangle(values, a, b, c);
  addTriangle(values, a, c, d);
}

function addLineSegment(values, start, end, alpha) {
  values.push(
    start[0], start[1], start[2], alpha,
    end[0], end[1], end[2], alpha,
  );
}

function orientedPoint(center, axisX, axisY, axisZ, offsetX, offsetY, offsetZ) {
  return [
    center[0] + (axisX[0] * offsetX) + (axisY[0] * offsetY) + (axisZ[0] * offsetZ),
    center[1] + (axisX[1] * offsetX) + (axisY[1] * offsetY) + (axisZ[1] * offsetZ),
    center[2] + (axisX[2] * offsetX) + (axisY[2] * offsetY) + (axisZ[2] * offsetZ),
  ];
}

function appendBoxGeometry(triangles, outline, center, axisX, axisY, axisZ, halfX, halfY, halfZ, outlineAlpha = 0.38) {
  const corners = {
    lbf: orientedPoint(center, axisX, axisY, axisZ, -halfX, -halfY, halfZ),
    rbf: orientedPoint(center, axisX, axisY, axisZ, halfX, -halfY, halfZ),
    rtf: orientedPoint(center, axisX, axisY, axisZ, halfX, halfY, halfZ),
    ltf: orientedPoint(center, axisX, axisY, axisZ, -halfX, halfY, halfZ),
    lbb: orientedPoint(center, axisX, axisY, axisZ, -halfX, -halfY, -halfZ),
    rbb: orientedPoint(center, axisX, axisY, axisZ, halfX, -halfY, -halfZ),
    rtb: orientedPoint(center, axisX, axisY, axisZ, halfX, halfY, -halfZ),
    ltb: orientedPoint(center, axisX, axisY, axisZ, -halfX, halfY, -halfZ),
  };

  addQuad(triangles, corners.lbf, corners.rbf, corners.rtf, corners.ltf);
  addQuad(triangles, corners.rbb, corners.lbb, corners.ltb, corners.rtb);
  addQuad(triangles, corners.lbb, corners.lbf, corners.ltf, corners.ltb);
  addQuad(triangles, corners.rbf, corners.rbb, corners.rtb, corners.rtf);
  addQuad(triangles, corners.ltf, corners.rtf, corners.rtb, corners.ltb);
  addQuad(triangles, corners.lbb, corners.rbb, corners.rbf, corners.lbf);

  addLineSegment(outline, corners.lbf, corners.rbf, outlineAlpha);
  addLineSegment(outline, corners.rbf, corners.rtf, outlineAlpha);
  addLineSegment(outline, corners.rtf, corners.ltf, outlineAlpha);
  addLineSegment(outline, corners.ltf, corners.lbf, outlineAlpha);
  addLineSegment(outline, corners.lbb, corners.rbb, outlineAlpha);
  addLineSegment(outline, corners.rbb, corners.rtb, outlineAlpha);
  addLineSegment(outline, corners.rtb, corners.ltb, outlineAlpha);
  addLineSegment(outline, corners.ltb, corners.lbb, outlineAlpha);
  addLineSegment(outline, corners.lbf, corners.lbb, outlineAlpha);
  addLineSegment(outline, corners.rbf, corners.rbb, outlineAlpha);
  addLineSegment(outline, corners.rtf, corners.rtb, outlineAlpha);
  addLineSegment(outline, corners.ltf, corners.ltb, outlineAlpha);
}

function appendRoundedPanelGeometry(triangles, outline, center, right, up, normal, width, height, thickness, cornerRadius) {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const corner = Math.min(cornerRadius, halfWidth * 0.45, halfHeight * 0.45);
  const profile = [
    [-halfWidth + corner, -halfHeight],
    [halfWidth - corner, -halfHeight],
    [halfWidth, -halfHeight + corner],
    [halfWidth, halfHeight - corner],
    [halfWidth - corner, halfHeight],
    [-halfWidth + corner, halfHeight],
    [-halfWidth, halfHeight - corner],
    [-halfWidth, -halfHeight + corner],
  ];
  const frontCenter = addVectors(center, scaleVector(normal, thickness * 0.5));
  const backCenter = addVectors(center, scaleVector(normal, -thickness * 0.5));
  const front = profile.map(([x, y]) => orientedPoint(frontCenter, right, up, normal, x, y, 0));
  const back = profile.map(([x, y]) => orientedPoint(backCenter, right, up, normal, x, y, 0));

  for (let index = 0; index < front.length; index += 1) {
    const next = (index + 1) % front.length;
    addTriangle(triangles, frontCenter, front[index], front[next]);
    addTriangle(triangles, backCenter, back[next], back[index]);
    addQuad(triangles, front[index], front[next], back[next], back[index]);
    addLineSegment(outline, front[index], front[next], 0.46);
    addLineSegment(outline, back[index], back[next], 0.22);
    addLineSegment(outline, front[index], back[index], 0.18);
  }
}

function buildDishModel(dish) {
  if (!Number.isFinite(dish?.azimuth) || !Number.isFinite(dish?.elevation)) {
    return { mesh: EMPTY_FLOAT32, outline: EMPTY_FLOAT32 };
  }

  const axis = normalizeVec3(azelToXYZ(dish.azimuth, dish.elevation));
  const { u, v } = buildPerpendicularBasis(axis);
  const worldRight = [1, 0, 0];
  const worldUp = [0, 1, 0];
  const worldForward = [0, 0, 1];
  const triangles = [];
  const outline = [];

  appendBoxGeometry(
    triangles,
    outline,
    [0, -0.072, 0],
    worldRight,
    worldUp,
    worldForward,
    0.014,
    0.072,
    0.014,
    0.18,
  );
  appendBoxGeometry(
    triangles,
    outline,
    [0, -0.142, 0],
    worldRight,
    worldUp,
    worldForward,
    0.068,
    0.006,
    0.017,
    0.14,
  );
  appendBoxGeometry(
    triangles,
    outline,
    [0, -0.142, 0],
    worldForward,
    worldUp,
    worldRight,
    0.052,
    0.006,
    0.017,
    0.14,
  );
  appendBoxGeometry(
    triangles,
    outline,
    [0, -0.004, 0],
    worldRight,
    worldUp,
    worldForward,
    0.019,
    0.019,
    0.019,
    0.22,
  );

  const panelCenter = addVectors(scaleVector(axis, 0.096), scaleVector(v, 0.008));
  appendRoundedPanelGeometry(triangles, outline, panelCenter, u, v, axis, 0.235, 0.152, 0.013, 0.03);

  const armTarget = addVectors(panelCenter, scaleVector(axis, -0.02));
  const armCenter = scaleVector(armTarget, 0.5);
  const armAxis = normalizeVec3(armTarget);
  const armBasis = buildPerpendicularBasis(armAxis);
  appendBoxGeometry(
    triangles,
    outline,
    armCenter,
    armBasis.u,
    armBasis.v,
    armAxis,
    0.012,
    0.01,
    Math.max(0.01, Math.hypot(armTarget[0], armTarget[1], armTarget[2]) * 0.5),
    0.2,
  );

  return {
    mesh: triangles.length ? new Float32Array(triangles) : EMPTY_FLOAT32,
    outline: outline.length ? new Float32Array(outline) : EMPTY_FLOAT32,
  };
}

function isGridCellInsideProjection(x, y, projection) {
  const dx = ((x + 0.5) - projection.centerX) / projection.radius;
  const dy = (projection.centerY - (y + 0.5)) / projection.radius;
  return ((dx * dx) + (dy * dy)) <= 1;
}

function createDishFovFilter(dish) {
  if (!Number.isFinite(dish?.azimuth) || !Number.isFinite(dish?.elevation)) {
    return null;
  }
  const halfAngle = Number(dish?.fov_half_angle_deg ?? 55);
  const cosHalf = Math.cos((halfAngle * Math.PI) / 180);
  const dishVec = azelToXYZ(dish.azimuth, dish.elevation);
  return (azimuth, elevation) => {
    const sampleVec = azelToXYZ(azimuth, elevation);
    return ((sampleVec[0] * dishVec[0]) + (sampleVec[1] * dishVec[1]) + (sampleVec[2] * dishVec[2])) > cosHalf;
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

function buildObstructionMapLayer(grid, width, height, projection, radius, size, inFov = null) {
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
      const { azimuth, elevation } = gridCellToAzEl(x, y, projection);
      if (inFov && !inFov(azimuth, elevation)) {
        continue;
      }
      const obstruction = clamp(1 - value, 0, 1);
      const greenBlue = 1 - (obstruction * 0.94);
      const alpha = 0.24 + (obstruction * 0.56);
      const point = scaleVector(azelToXYZ(azimuth, elevation), radius);
      values.push(
        point[0],
        point[1],
        point[2],
        size,
        1,
        greenBlue,
        greenBlue,
        clamp(alpha, 0.24, 0.8),
      );
    }
  }

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
  const obstructionGrid = layers.average?.length ? layers.average : layers.current;
  const cellRadius = width && height ? clamp(920 / Math.max(width, height), 2.8, 8.2) : 5.2;
  const inDishFov = createDishFovFilter(dish);
  const satellites = active.live ? animatedLiveSatellites(now) : [];
  const dishModel = active.dish ? buildDishModel(dish) : { mesh: EMPTY_FLOAT32, outline: EMPTY_FLOAT32 };

  return {
    obstructionMap: active.mask
      ? buildObstructionMapLayer(
        obstructionGrid,
        width,
        height,
        projection,
        GRID_LAYER_RADII.obstruction,
        cellRadius,
        inDishFov,
      )
      : EMPTY_FLOAT32,
    solidLayers: [
      {
        points: dishModel.mesh,
        color: [1, 1, 1],
        alpha: 0.82,
      },
    ],
    layers: [],
    satellites: buildSatellitePointLayer(satellites, GRID_LAYER_RADII.satellites),
    lineLayers: [
      {
        points: active.dish ? dishModel.outline : EMPTY_FLOAT32,
        color: [1, 1, 1],
        primitive: "lines",
      },
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
    skyRenderer: useSkyWebgl ? "webgl" : "unavailable",
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
  const stats = sky.persistent_obstructions?.stats || {};
  const liveSatellites = sky.live_satellites || [];
  const tle = sky.tle || {};
  const observer = sky.observer;
  const dish = sky.dish || {};
  const useSkyWebgl = !!(state.skyRendererSupportsWebgl && skyRenderer);

  const active = {
    mask: layerInputs.mask.checked,
    live: layerInputs.live.checked,
    dish: layerInputs.dish.checked,
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
    ? `Rotation ${(cameraState.theta * 180 / Math.PI).toFixed(0)}°, inclinaison ${(cameraState.phi * 180 / Math.PI).toFixed(0)}°, distance ${cameraState.radius.toFixed(2)}`
    : "Glisse pour tourner, molette pour zoomer";
  updateSkyCardinals(cameraState);

  const obstructed = stats.obstructed_cells || 0;
  const coverage = Number.isFinite(stats.coverage) ? `${(stats.coverage * 100).toFixed(1)}% du ciel obstrue` : "Pas de stats d'obstruction";
  const observerText = observer
    ? `${observer.latitude}, ${observer.longitude}${Number.isFinite(observer.altitude_m) ? `, ${Number(observer.altitude_m).toFixed(1)} m` : ""} (${formatObserverSource(observer.source)})`
    : "observateur inconnu";
  const skyRendererLabel = useSkyWebgl ? "WebGL" : `Indisponible${state.skyRenderError ? ` (${state.skyRenderError})` : ""}`;
  const observerInputsFocused = observerInputs.includes(document.activeElement);
  if (observer && !observerInputsFocused && !state.observerSaving) {
    const manualDraft = observer.source === "manual" ? state.manualObserverDraft : null;
    observerLatitudeInput.value = manualDraft?.latitude ?? observerDisplayValue(observer.latitude);
    observerLongitudeInput.value = manualDraft?.longitude ?? observerDisplayValue(observer.longitude);
    observerAltitudeInput.value = manualDraft?.altitude ?? observerDisplayValue(observer.altitude_m);
  }
  skyStatus.innerHTML = `
    <strong>Antenne</strong> ${dish.azimuth != null && dish.elevation != null ? `${dish.azimuth.toFixed(1)}° / ${dish.elevation.toFixed(1)}°` : "direction indisponible"}<br>
    <strong>Champ</strong> ${Number.isFinite(dish.fov_total_angle_deg) ? `${Number(dish.fov_total_angle_deg).toFixed(0)}° de cone` : "indisponible"}<br>
    <strong>Camera</strong> ${escapeHtml(cameraText)}<br>
    <strong>Rendu ciel</strong> ${escapeHtml(skyRendererLabel)}<br>
    <strong>Observateur</strong> ${escapeHtml(observerText)}<br>
    <strong>Obstructions</strong> ${obstructed} cellules, ${coverage}<br>
    <strong>Projection</strong> ${escapeHtml(projection.referenceFrame)}
  `;
  skyClusters.innerHTML = `
    <strong>Satellites</strong> ${observer ? (tle.available ? `${tle.active_segment_count || tle.visible_count || animatedSatellites.length || liveSatellites.length} dans le faisceau / ${tle.satellite_count} catalogues` : escapeHtml(tle.error || "catalogue indisponible")) : "definis la position de l'observateur pour activer les satellites en direct"}<br>
    <strong>Traces</strong> ${(sky.passive_tracking?.total_events || 0)} evenements passifs
  `;
  logSkySummary(snapshot, projection, active, animatedSatellites, !!useSkyWebgl, now);
}

function updateConnectionUi(kind, detail) {
  state.connectionState = kind;
  state.connectionDetail = detail;
}

function activeExportLayer() {
  if (layerInputs.mask.checked) {
    return "average";
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
    updateConnectionUi("open", `Couche ${activeExportLayer()} exportee en PNG.`);
  } catch (error) {
    console.error(error);
    updateConnectionUi("reconnecting", error?.message || "Echec de l'export PNG.");
  } finally {
    exportButton.disabled = false;
  }
});

tleRefreshButton.addEventListener("click", async () => {
  try {
    tleRefreshButton.disabled = true;
    const result = await postJson("/api/tle/refresh");
    updateConnectionUi("open", result.error ? `Erreur de rafraichissement TLE : ${result.error}` : `Rafraichissement TLE termine : ${result.satellite_count || 0} satellites.`);
  } catch (error) {
    console.error(error);
    updateConnectionUi("reconnecting", error?.message || "Echec du rafraichissement TLE.");
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
    updateConnectionUi("reconnecting", "Entre une latitude, une longitude et une altitude valides.");
    return;
  }
  try {
    state.observerSaving = true;
    state.manualObserverDraft = draft;
    observerSaveButton.disabled = true;
    await postJson("/api/observer", { latitude, longitude, altitude_m: altitude });
    updateConnectionUi("open", `Position enregistree : ${draft.latitude}, ${draft.longitude}, ${draft.altitude} m. Rafraichissement des satellites en direct.`);
    await postJson("/api/tle/refresh");
  } catch (error) {
    console.error(error);
    updateConnectionUi("reconnecting", error?.message || "Echec de la mise a jour de l'observateur.");
  } finally {
    state.observerSaving = false;
    observerSaveButton.disabled = false;
  }
});

const socket = createSocketClient({
  url: wsUrl,
  onState(connectionState) {
    updateConnectionUi(
      connectionState,
      connectionState === "open" ? "WebSocket connecte a /ws." : "En attente des trames du backend.",
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
    updateConnectionUi("open", snapshot.meta?.worker_error || `${snapshot.meta?.sample_count || 0} echantillons tamponnes en direct.`);
  },
});

window.addEventListener("resize", () => {
  if (state.snapshot) {
    renderSkyView(state.snapshot, Date.now());
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
  window.requestAnimationFrame(frame);
}

frame();
