export const SKY_VIEWBOX = 1000;
export const SKY_CENTER = SKY_VIEWBOX / 2;
export const SKY_RADIUS = 460;

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function normalizeAzimuth(value) {
  return ((value % 360) + 360) % 360;
}

export function dotVec3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function crossVec3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function normalizeVec3(vector) {
  const [x, y, z] = vector;
  const length = Math.hypot(x, y, z);
  if (length <= 1e-9) {
    return [0, 0, 1];
  }
  return [x / length, y / length, z / length];
}

export function azelToXYZ(azimuthDeg, elevationDeg) {
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const elevation = (elevationDeg * Math.PI) / 180;
  return normalizeVec3([
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  ]);
}

export function xyzToAzEl(vector) {
  const [x, y, z] = normalizeVec3(vector);
  return {
    azimuth: normalizeAzimuth((Math.atan2(x, z) * 180) / Math.PI),
    elevation: (Math.asin(clamp(y, -1, 1)) * 180) / Math.PI,
  };
}

export function slerp(v0, v1, t) {
  const from = normalizeVec3(v0);
  const to = normalizeVec3(v1);
  let dot = clamp(dotVec3(from, to), -1, 1);
  if (dot > 0.999999) {
    return normalizeVec3([
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    ]);
  }
  const theta = Math.acos(dot);
  if (Math.abs(theta) < 1e-6) {
    return from;
  }
  const sinTheta = Math.sin(theta);
  if (Math.abs(sinTheta) < 1e-6) {
    return normalizeVec3([
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    ]);
  }
  const s0 = Math.sin((1 - t) * theta) / sinTheta;
  const s1 = Math.sin(t * theta) / sinTheta;
  return normalizeVec3([
    s0 * from[0] + s1 * to[0],
    s0 * from[1] + s1 * to[1],
    s0 * from[2] + s1 * to[2],
  ]);
}

export function normalizeProjection(width, height, projection) {
  return {
    centerX: Number(projection?.center_x ?? ((width - 1) / 2)),
    centerY: Number(projection?.center_y ?? ((height - 1) / 2)),
    radius: Math.max(1, Number(projection?.radius ?? (Math.min(width, height) / 2))),
    minElevation: Number(projection?.min_elevation_deg ?? 0),
    referenceFrame: String(projection?.reference_frame ?? "FRAME_EARTH"),
  };
}

export function projectSky(azimuth, elevation, projection) {
  const radial = ((90 - elevation) / Math.max(1, 90 - projection.minElevation)) * SKY_RADIUS;
  const theta = (azimuth * Math.PI) / 180;
  return {
    x: SKY_CENTER + Math.sin(theta) * radial,
    y: SKY_CENTER - Math.cos(theta) * radial,
  };
}

export function gridCellToAzEl(x, y, projection) {
  const dx = ((x + 0.5) - projection.centerX) / projection.radius;
  const dy = (projection.centerY - (y + 0.5)) / projection.radius;
  const radial = clamp(Math.hypot(dx, dy), 0, 1);
  return {
    azimuth: normalizeAzimuth((Math.atan2(dx, dy) * 180) / Math.PI),
    elevation: clamp(
      90 - radial * Math.max(1, 90 - projection.minElevation),
      projection.minElevation,
      90,
    ),
  };
}

export function projectGridCell(x, y, projection) {
  const dx = ((x + 0.5) - projection.centerX) / projection.radius;
  const dy = ((y + 0.5) - projection.centerY) / projection.radius;
  return {
    x: SKY_CENTER + dx * SKY_RADIUS,
    y: SKY_CENTER + dy * SKY_RADIUS,
  };
}

export function projectVectorToSky(vector, projection) {
  const { azimuth, elevation } = xyzToAzEl(vector);
  return {
    ...projectSky(azimuth, elevation, projection),
    azimuth,
    elevation,
  };
}

export function buildPerpendicularBasis(direction) {
  const axis = normalizeVec3(direction);
  const reference = Math.abs(axis[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
  let u = normalizeVec3(crossVec3(reference, axis));
  if (Math.hypot(u[0], u[1], u[2]) <= 1e-6) {
    u = normalizeVec3(crossVec3([0, 0, 1], axis));
  }
  const v = normalizeVec3(crossVec3(axis, u));
  return { u, v };
}

export function buildFovBoundaryVectors(dishVec, halfAngleDeg, segments = 96) {
  const axis = normalizeVec3(dishVec);
  const { u, v } = buildPerpendicularBasis(axis);
  const halfAngle = (halfAngleDeg * Math.PI) / 180;
  const cosHalf = Math.cos(halfAngle);
  const sinHalf = Math.sin(halfAngle);
  const points = [];

  for (let index = 0; index <= segments; index += 1) {
    const phi = (index / segments) * Math.PI * 2;
    const radial = [
      Math.cos(phi) * u[0] + Math.sin(phi) * v[0],
      Math.cos(phi) * u[1] + Math.sin(phi) * v[1],
      Math.cos(phi) * u[2] + Math.sin(phi) * v[2],
    ];
    points.push(normalizeVec3([
      axis[0] * cosHalf + radial[0] * sinHalf,
      axis[1] * cosHalf + radial[1] * sinHalf,
      axis[2] * cosHalf + radial[2] * sinHalf,
    ]));
  }

  return points;
}

export function normalizeBeamQuality(rawQuality, halfAngleDeg) {
  const floor = Math.cos((halfAngleDeg * Math.PI) / 180);
  return clamp((rawQuality - floor) / Math.max(1 - floor, 1e-6), 0, 1);
}
