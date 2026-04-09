import {
  clamp,
  crossVec3,
  dotVec3,
  normalizeVec3,
} from "../skyMath.js";

const FULL_TURN = Math.PI * 2;
const DEFAULT_OPTIONS = {
  radius: 2.45,
  theta: 0.0,
  phi: Math.PI - 0.34,
  minRadius: 1.35,
  maxRadius: 5.5,
  minPhi: 0.01,
  maxPhi: Math.PI - 0.01,
  rotateSpeed: 0.0055,
  zoomSpeed: 0.0012,
  damping: 0.16,
  dragDamping: 0.34,
  fovY: (46 * Math.PI) / 180,
  near: 0.01,
  far: 20.0,
};

function wrapAngle(value) {
  return ((value % FULL_TURN) + FULL_TURN) % FULL_TURN;
}

function lerpScalar(from, to, alpha) {
  return from + (to - from) * alpha;
}

function lerpAngle(from, to, alpha) {
  const delta = ((((to - from) % FULL_TURN) + FULL_TURN + Math.PI) % FULL_TURN) - Math.PI;
  return from + delta * alpha;
}

function sphericalToCartesian(radius, theta, phi) {
  return [
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.cos(theta),
  ];
}

function buildPerspectiveMatrix(fovY, aspect, near, far) {
  const f = 1.0 / Math.tan(fovY * 0.5);
  const nf = 1.0 / (near - far);
  return new Float32Array([
    f / Math.max(aspect, 1e-6), 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, (2 * far * near) * nf, 0,
  ]);
}

function buildLookAtMatrix(eye, target, up) {
  const zAxis = normalizeVec3([
    eye[0] - target[0],
    eye[1] - target[1],
    eye[2] - target[2],
  ]);

  let xAxis = crossVec3(up, zAxis);
  if (Math.hypot(xAxis[0], xAxis[1], xAxis[2]) <= 1e-6) {
    xAxis = crossVec3([0, 0, 1], zAxis);
  }
  xAxis = normalizeVec3(xAxis);

  const yAxis = normalizeVec3(crossVec3(zAxis, xAxis));

  return new Float32Array([
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -dotVec3(xAxis, eye), -dotVec3(yAxis, eye), -dotVec3(zAxis, eye), 1,
  ]);
}

export function createOrbitCamera(canvas, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const defaults = {
    theta: wrapAngle(settings.theta),
    phi: clamp(settings.phi, settings.minPhi, settings.maxPhi),
    radius: clamp(settings.radius, settings.minRadius, settings.maxRadius),
  };

  const state = {
    theta: defaults.theta,
    phi: defaults.phi,
    radius: defaults.radius,
    targetTheta: defaults.theta,
    targetPhi: defaults.phi,
    targetRadius: defaults.radius,
    pointerId: null,
    dragging: false,
    lastX: 0,
    lastY: 0,
    dirty: true,
  };

  function syncCanvasDragging(isDragging) {
    canvas.classList.toggle("is-dragging", isDragging);
  }

  function stopDragging() {
    state.pointerId = null;
    state.dragging = false;
    syncCanvasDragging(false);
  }

  function onPointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    state.pointerId = event.pointerId;
    state.dragging = true;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.dirty = true;
    syncCanvasDragging(true);
    canvas.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!state.dragging || state.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;

    state.targetTheta = wrapAngle(state.targetTheta - dx * settings.rotateSpeed);
    state.targetPhi = clamp(state.targetPhi + dy * settings.rotateSpeed, settings.minPhi, settings.maxPhi);
    state.dirty = true;
  }

  function onPointerUp(event) {
    if (state.pointerId !== event.pointerId) {
      return;
    }
    canvas.releasePointerCapture(event.pointerId);
    stopDragging();
    state.dirty = true;
  }

  function onPointerCancel(event) {
    if (state.pointerId !== event.pointerId) {
      return;
    }
    stopDragging();
    state.dirty = true;
  }

  function onWheel(event) {
    event.preventDefault();
    const zoomScale = Math.exp(event.deltaY * settings.zoomSpeed);
    state.targetRadius = clamp(
      state.targetRadius * zoomScale,
      settings.minRadius,
      settings.maxRadius,
    );
    state.dirty = true;
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("lostpointercapture", stopDragging);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return {
    tick() {
      const step = state.dragging ? settings.dragDamping : settings.damping;
      let changed = state.dirty;

      const nextTheta = lerpAngle(state.theta, state.targetTheta, step);
      const nextPhi = lerpScalar(state.phi, state.targetPhi, step);
      const nextRadius = lerpScalar(state.radius, state.targetRadius, step);

      if (Math.abs(nextTheta - state.theta) > 1e-5) {
        state.theta = wrapAngle(nextTheta);
        changed = true;
      } else {
        state.theta = state.targetTheta;
      }

      if (Math.abs(nextPhi - state.phi) > 1e-5) {
        state.phi = clamp(nextPhi, settings.minPhi, settings.maxPhi);
        changed = true;
      } else {
        state.phi = state.targetPhi;
      }

      if (Math.abs(nextRadius - state.radius) > 1e-5) {
        state.radius = clamp(nextRadius, settings.minRadius, settings.maxRadius);
        changed = true;
      } else {
        state.radius = state.targetRadius;
      }

      state.dirty = false;
      return changed;
    },

    getMatrices(aspect) {
      const position = sphericalToCartesian(state.radius, state.theta, state.phi);
      const forward = normalizeVec3([-position[0], -position[1], -position[2]]);
      const up = Math.abs(dotVec3(forward, [0, 1, 0])) > 0.985 ? [0, 0, 1] : [0, 1, 0];

      return {
        position,
        theta: state.theta,
        phi: state.phi,
        radius: state.radius,
        projectionMatrix: buildPerspectiveMatrix(settings.fovY, aspect, settings.near, settings.far),
        viewMatrix: buildLookAtMatrix(position, [0, 0, 0], up),
      };
    },

    reset() {
      state.theta = defaults.theta;
      state.phi = defaults.phi;
      state.radius = defaults.radius;
      state.targetTheta = defaults.theta;
      state.targetPhi = defaults.phi;
      state.targetRadius = defaults.radius;
      state.dirty = true;
    },

    destroy() {
      stopDragging();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", stopDragging);
      canvas.removeEventListener("wheel", onWheel);
    },
  };
}
