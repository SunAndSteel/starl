# AGENTS.md

## Frontend Context

- The production UI lives in `frontend/` and is served by the FastAPI backend from the built Vite output in `frontend/dist`.
- The frontend uses `regl` directly for WebGL rendering. There is also a DOM/SVG fallback overlay mode kept for debugging and recovery.
- The web app now has two presentation zones:
  - a fisheye sky view for obstruction/satellite layers
  - a regl analytics dashboard for throughput and bufferbloat
- The design direction is now monochrome space-minimalism:
  - Use `D-DIN` everywhere.
  - Keep the palette black/white only.
  - Use white opacity for hierarchy and accents instead of blue highlights.
  - Do not reintroduce the `Outage Timeline` viewport panel unless explicitly requested.
- Observer entry must preserve full precision:
  - The sky UI uses text inputs plus manual decimal parsing, not browser `number` rounding/locale behavior.
  - Do not write `toFixed(4)` back into observer fields.
  - Keep manual observer values intact after save, including altitude.

## Backend Integration Notes

- The FastAPI app combines:
  - `TelemetryService` for outage/throughput/bufferbloat analytics
  - `MonitorService` for obstruction maps, passive tracks, TLE tracking, PNG export, and persisted sky state
- WebSocket payloads now include a top-level `sky` object from `MonitorService.state_snapshot()`.
- Useful HTTP endpoints:
  - `GET /api/state`
  - `GET /api/export?layer=current|average|mask|tracks&size=...`
  - `POST /api/reset`
  - `POST /api/tle/refresh`
  - `POST /api/observer`

## Sky Projection Notes

- Do not treat the Starlink obstruction map as a simple rectangular azimuth/elevation grid.
- The obstruction map behaves like a polar/fisheye projection stored inside a square grid with invalid cells outside the valid sky area.
- Use raw obstruction-map metadata plus inferred center/radius:
  - `min_elevation_deg`
  - `max_theta_deg`
  - `map_reference_frame`
  - inferred `center_x`, `center_y`, `radius`
- Grid layers in the sky UI should be rendered by projecting source grid coordinates directly from that polar geometry.
- Satellite and dish overlays should project from azimuth/elevation using the same `min_elevation_deg`.
- If `location_data()` is unavailable, live TLE satellites will stay at 0 visible until the observer is provided manually or via config.

## Important WebGL Pitfalls Already Hit

- `regl` enables depth testing by default.
  - This caused the exact symptom where panel backgrounds rendered, but the charts themselves were invisible.
  - Reason: the background quads wrote depth first, then the later 2D bars/lines at the same `z` failed the depth test.
  - For 2D dashboard draws, every command must set:

```js
depth: {
  enable: false,
  mask: false,
}
```

- Do not set `lineWidth` above `1`.
  - On many WebGL drivers the supported range is `[1, 1]`.
  - We already hit a startup crash from `lineWidth: 2` in regl.

- Prefer persistent/interleaved `regl.buffer(...)` uploads for packed vertex data.
  - The current renderers use one packed float stream per draw path with `stride: 24` and `offset: 0/8`.
  - This is more reliable than ad hoc attribute upload patterns that were harder to reason about during debugging.

## Rendering / Layout Notes

- Keep captions and panel chrome aligned from the actual panel layout in JS, not from fixed CSS percentages.
- Live TLE satellites in the sky SVG are animated between websocket snapshots.
  - Do not stop at simple interpolation between two frames; that causes satellites to freeze for several seconds and then jump.
  - Do not animate in screen-space `x/y`; that caused backward motion and unstable corrections.
  - The backend now sends `azimuth_rate_deg_s` and `elevation_rate_deg_s` per visible satellite from the TLE propagation itself.
  - The frontend tracks each satellite by `norad_id`, propagates in azimuth/elevation, then projects to the fisheye sky view every frame.
  - Use backend timestamps (`tracked_at`, `generated_at`) with a measured local clock offset; do not anchor live-satellite motion purely on `performance.now()`.
  - When a satellite disappears from the backend visible list, let it coast briefly and fade out instead of deleting it immediately.
  - Re-render the sky view during animation frames even if the regl dashboard itself has no new data.
- If a graph looks blank again:
  1. Verify the browser loaded the latest Vite bundle from `frontend/dist/assets`.
  2. Check whether the app is in `WebGL` or `Fallback` mode.
  3. Re-check `depth: false` on every relevant regl command before changing shaders or geometry math.

## Static Assets

- Font files are expected under `frontend/public/fonts/`.
- FastAPI must serve both `/assets` and `/fonts`; missing `/fonts` previously caused D-DIN 404s.

## 

You are building a real-time 3D Starlink sky visualization using:

- FastAPI backend
- WebSockets
- Vite frontend
- WebGL rendering with regl

Your task is to implement a physically correct Field of View (FOV) model for the Starlink dish (Gen 3) and integrate it into both backend computations and frontend rendering.

---

🎯 GOAL

Implement a correct 3D conical field of view for the dish and use it to:

1. Filter visible satellites
2. Generate trajectory segments (entry/exit in FOV)
3. Render the FOV in WebGL
4. Apply signal quality weighting based on angular distance

---

📡 FOV MODEL (MANDATORY)

The Starlink Gen 3 dish has an approximate:

- Total FOV ≈ 110°
- Half-angle ≈ 55°

The FOV must be modeled as a 3D cone, NOT:

- a flat circle
- a zenith-centered projection
- an elevation-only filter

---

🧠 COORDINATE SYSTEM

All directions must be expressed in 3D using azimuth/elevation.

Convention (mandatory, used everywhere — backend AND frontend):

- X = East
- Y = Up (zenith)
- Z = North

Convert az/el to 3D unit vector:

def azel_to_xyz(az_deg, el_deg):
    az = radians(az_deg)
    el = radians(el_deg)
    x = cos(el) * sin(az)   # X = East
    y = sin(el)              # Y = Up
    z = cos(el) * cos(az)   # Z = North
    return normalize((x, y, z))

Mathematical proof of unit norm:
  |v|² = cos²(el)·sin²(az) + sin²(el) + cos²(el)·cos²(az)
       = cos²(el)·[sin²(az)+cos²(az)] + sin²(el)
       = cos²(el) + sin²(el) = 1  ✓

Azimuth: clockwise from North (compass convention).
El = 0 → horizon, el = 90° → zenith.
This convention must be identical in Python (backend) and GLSL/JS (frontend).
Any axis mismatch causes satellites, FOV, and obstruction map to desynchronize.

---

⚙️ BACKEND REQUIREMENTS

---

1. Dish direction

Use:
- "direction_azimuth" (degrees, clockwise from North)
- "direction_elevation" (degrees, 0 = horizon, 90 = zenith)

dish_vec = normalize(azel_to_xyz(direction_azimuth, direction_elevation))

---

2. Satellite propagation (MANDATORY)

Use SGP4 propagation only. Do NOT interpolate orbital elements linearly.

Generate satellite positions at fixed time steps:
- dt MUST be ≤ 2 seconds
- dt = 1 second is recommended
- All timestamps must be in UTC (Unix timestamp, float seconds)

For each time step, compute az/el from observer position using standard
topocentric conversion (ECEF → observer frame), then call azel_to_xyz().

---

3. Satellite filtering (FOV test)

For each satellite position:

  COS_HALF  = cos(radians(55))           # ≈ 0.5736
  sat_vec   = normalize(azel_to_xyz(sat_az, sat_el))
  dish_vec  = normalize(azel_to_xyz(direction_az, direction_el))
  cos_angle = dot(sat_vec, dish_vec)
  visible   = cos_angle > COS_HALF

Proof: for unit vectors u·v = cos(θ).
  dot > cos(55°)  ⟺  θ < 55°  ✓  (cos is strictly decreasing on [0°, 180°])

Rules:
- NEVER use arccos — dot product comparison only
- ALWAYS normalize sat_vec and dish_vec before dot product

---

4. Segment generation (critical)

Generate trajectory segments ONLY while satellite is continuously inside FOV.

Each time a satellite enters the FOV, start a new segment.
Each time it exits, close the current segment.

A segment must contain:

{
  "segment_id": "<uuid4>",
  "sat_id": "...",
  "t_entry": <float UTC>,
  "t_exit": <float UTC>,
  "entry_az": <float degrees>,
  "entry_el": <float degrees>,
  "exit_az": <float degrees>,
  "exit_el": <float degrees>,
  "track": [
    [t, az, el],          # one point per dt (≤ 2s)
    ...
  ],
  "quality_track": [
    [t, quality],         # remapped quality at each track point
    ...
  ]
}

Invariants (enforced server-side):
- No two segments for the same sat_id may overlap in time
- No segment may have t_entry == t_exit
- track must contain at least 2 points
- All track points must satisfy the FOV test (dot > COS_HALF)
- segment_id must be a UUID4, unique across all segments and satellites

---

5. Signal quality model (CORRECTED)

⚠️ CRITICAL: Do NOT use clamp(dot, 0, 1) directly.

For a visible satellite: dot ∈ [cos(55°), 1.0] ≈ [0.5736, 1.0].
Using clamp(dot, 0, 1) would give quality ≈ 0.574 at the FOV edge — never 0.
The color mapping would never show red. This is a bug.

CORRECT formula:

  COS_HALF = cos(radians(55))      # ≈ 0.5736
  RANGE    = 1.0 - COS_HALF       # ≈ 0.4264
  raw      = dot(sat_vec, dish_vec)
  quality  = clamp((raw - COS_HALF) / RANGE, 0.0, 1.0)

Verification:
  angle = 0°  (center): quality = (1.0 - 0.5736) / 0.4264 = 1.0  ✓ (green)
  angle = 55° (edge)  : quality = (0.5736 - 0.5736) / 0.4264 = 0.0  ✓ (red)

RANGE > 0 always → no division by zero. ✓

---

🎨 FRONTEND (REGL / WEBGL)

---

1. Coordinate system

EXACT same convention as backend:

function azelToXYZ(az_deg, el_deg) {
    const az = az_deg * Math.PI / 180;
    const el = el_deg * Math.PI / 180;
    return [
        Math.cos(el) * Math.sin(az),   // X = East
        Math.sin(el),                   // Y = Up
        Math.cos(el) * Math.cos(az)    // Z = North
    ];
    // Result is unit vector (proved algebraically above)
}

Do NOT use a different axis convention in the frontend.

---

2. Satellite animation (prevents teleportation and backward motion)

NEVER interpolate az/el directly.

Why az/el interpolation causes backward motion:
  Satellite at az=350° → az=10° (crossing North, shortest arc = 20°)
  Naive lerp: 350 → 180 → 10  (sweeps 340° backward across the sky)
  SLERP in 3D: interpolates the 20° arc correctly

SLERP implementation:

function slerp(v0, v1, t) {
    // v0, v1 must be unit vectors
    const dot = Math.max(-1.0, Math.min(1.0, v0[0]*v1[0] + v0[1]*v1[1] + v0[2]*v1[2]));
    const theta = Math.acos(dot);
    if (Math.abs(theta) < 1e-6) return [...v0];     // identical vectors
    const sinTheta = Math.sin(theta);
    const s0 = Math.sin((1 - t) * theta) / sinTheta;
    const s1 = Math.sin(t * theta) / sinTheta;
    return [
        s0 * v0[0] + s1 * v1[0],
        s0 * v0[1] + s1 * v1[1],
        s0 * v0[2] + s1 * v1[2]
    ];
    // Result is always a unit vector (algebraically proved)
}

At each animation frame (requestAnimationFrame):

function animateSatellites(t_now, segments) {
    for (const seg of segments) {
        if (t_now < seg.t_entry || t_now > seg.t_exit) {
            hideSatellite(seg.sat_id);   // DO NOT carry over position
            continue;
        }
        const track = seg.track;
        let i = track.findIndex(p => p[0] > t_now) - 1;
        i = Math.max(0, Math.min(i, track.length - 2));
        const dt = track[i+1][0] - track[i][0];
        // Guard against zero dt
        const alpha = (dt < 1e-9) ? 0.0
                    : Math.min(1.0, Math.max(0.0, (t_now - track[i][0]) / dt));
        const v0 = azelToXYZ(track[i][1],   track[i][2]);
        const v1 = azelToXYZ(track[i+1][1], track[i+1][2]);
        const pos = slerp(v0, v1, alpha);
        renderSatelliteAt(seg.sat_id, pos, interpolateQuality(seg, i, alpha));
    }
}

Satellite identity:
- Each satellite tracked by sat_id
- When segment expires (t_now > t_exit): remove from scene
- NEVER carry position between segments of the same sat_id

---

3. FOV visualization

Build orthonormal basis perpendicular to dish_vec:

function buildBasis(dish_vec) {
    const arbitrary = (Math.abs(dish_vec[1]) < 0.99)
                    ? [0, 1, 0]
                    : [1, 0, 0];
    const u = normalize(cross(dish_vec, arbitrary));
    const v = cross(dish_vec, u);    // already unit if inputs are unit
    return { u, v };
}

Generate N ≥ 64 boundary points (all on unit sphere, all at exactly dot=cos(55°)):

const COS_HALF = Math.cos(55 * Math.PI / 180);   // 0.5736
const SIN_HALF = Math.sin(55 * Math.PI / 180);   // 0.8192
const { u, v }  = buildBasis(dish_vec);

const points = [];
for (let i = 0; i < N; i++) {
    const phi = 2 * Math.PI * i / N;
    const p = [
        COS_HALF * dish_vec[0] + SIN_HALF * (Math.cos(phi)*u[0] + Math.sin(phi)*v[0]),
        COS_HALF * dish_vec[1] + SIN_HALF * (Math.cos(phi)*u[1] + Math.sin(phi)*v[1]),
        COS_HALF * dish_vec[2] + SIN_HALF * (Math.cos(phi)*u[2] + Math.sin(phi)*v[2]),
    ];
    // |p| = sqrt(cos²(55°) + sin²(55°)) = 1  (no normalize needed, kept for safety)
    points.push(normalize(p));
}

// Proof: dot(p, dish_vec) = cos(55°)·1 + sin(55°)·0 = cos(55°) ✓
// → boundary circle aligns perfectly with backend filter threshold

Render as line loop (wireframe) or translucent filled cone.
Must update every frame if dish direction changes.

---

4. Satellite rendering

GLSL quality color function (correct, continuous):

vec3 qualityToColor(float q) {
    // q = 0.0 → red   (FOV edge)
    // q = 0.5 → yellow
    // q = 1.0 → green (beam center)
    // Continuous at q=0.5: both branches yield (1,1,0)
    if (q > 0.5) {
        float t = (q - 0.5) * 2.0;
        return mix(vec3(1.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0), t);
    } else {
        float t = q * 2.0;
        return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), t);
    }
}

Interpolate quality between track points:

function interpolateQuality(seg, i, alpha) {
    const q0 = seg.quality_track[i][1];
    const q1 = seg.quality_track[i+1][1];
    return q0 + alpha * (q1 - q0);  // linear OK for scalar quality
}

---

5. Obstruction map integration

Projection rules (MANDATORY):
- Use the EXACT same azelToXYZ() function
- Render on unit sphere (same radius as satellites and FOV cone)
- Same coordinate system

If obstruction zones appear misaligned with satellites:
  1. First verify azelToXYZ() is identical between all subsystems
  2. Verify az=0 maps to Z=1 (North), az=90 maps to X=1 (East)
  3. Never apply any rotation to one system but not the others

---

⚠️ CONSTRAINTS

- No 2D approximations for FOV
- No elevation-only filtering
- No static zenith-based circle
- No linear interpolation of az/el (always SLERP in 3D)
- No reuse of position from a different segment
- No clamp(dot, 0, 1) for quality — use the remapped formula
- Must be physically consistent: backend filter ↔ frontend rendering

---

🧪 OUTPUT EXPECTATIONS

Provide:

1. Backend code:
   - SGP4 propagation at dt ≤ 2s
   - FOV filtering: dot(sat_vec, dish_vec) > cos(55°)
   - Quality: clamp((dot - cos55°) / (1 - cos55°), 0, 1)
   - Segment generation with UUID4, no overlaps

2. Frontend code:
   - azelToXYZ() matching backend exactly
   - SLERP animation with alpha clamp and dt guard
   - FOV ring via buildBasis() + parametric circle
   - Segment expiry: hide satellite, never carry position

3. Shader code (GLSL):
   - qualityToColor(float q) as shown above
   - Point/billboard rendering

4. Explanation of:
   - Why SLERP prevents backward motion (az wrap-around example)
   - Why quality must be remapped (edge ≠ 0 without remapping)
   - Why dot product replaces arccos (speed + numerical stability)
   - Why coordinate systems must be identical everywhere

---

🎯 SUCCESS CRITERIA

- Satellites appear ONLY inside the cone
- No satellite ever moves backward or teleports
- Entry/exit events are stable and non-overlapping
- FOV cone, satellites, and obstruction map are visually aligned
- Red at FOV edge, green at beam center (requires quality remapping)
- Smooth animation via requestAnimationFrame + SLERP
- No NaN or divide-by-zero in alpha computation

This must behave like a physically correct antenna beam model,
not a visual approximation.
```
