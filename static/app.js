class SkyRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext("webgl", { antialias: true, alpha: false });
        if (!this.gl) {
            throw new Error("WebGL is not available in this browser.");
        }

        this.program = this.createProgram();
        this.buffer = this.gl.createBuffer();
        this.attribs = {
            position: this.gl.getAttribLocation(this.program, "a_position"),
            color: this.gl.getAttribLocation(this.program, "a_color"),
            size: this.gl.getAttribLocation(this.program, "a_size"),
        };
        this.uniforms = {
            pointMode: this.gl.getUniformLocation(this.program, "u_point_mode"),
        };

        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
        this.resize();
        window.addEventListener("resize", () => this.resize());
    }

    createProgram() {
        const vertexSource = `
            attribute vec2 a_position;
            attribute vec4 a_color;
            attribute float a_size;
            varying vec4 v_color;

            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                gl_PointSize = a_size;
                v_color = a_color;
            }
        `;

        const fragmentSource = `
            precision mediump float;
            varying vec4 v_color;
            uniform float u_point_mode;

            void main() {
                if (u_point_mode > 0.5) {
                    vec2 local = gl_PointCoord * 2.0 - 1.0;
                    if (dot(local, local) > 1.0) {
                        discard;
                    }
                }
                gl_FragColor = v_color;
            }
        `;

        const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, fragmentSource);
        const program = this.gl.createProgram();
        this.gl.attachShader(program, vertexShader);
        this.gl.attachShader(program, fragmentShader);
        this.gl.linkProgram(program);

        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            throw new Error(this.gl.getProgramInfoLog(program) || "Failed to link WebGL program.");
        }

        return program;
    }

    compileShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            throw new Error(this.gl.getShaderInfoLog(shader) || "Failed to compile shader.");
        }
        return shader;
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        const width = Math.floor(this.canvas.clientWidth * dpr);
        const height = Math.floor(this.canvas.clientHeight * dpr);
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    render(state, layers) {
        this.resize();
        this.gl.clearColor(0.02, 0.05, 0.09, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        const dims = state?.dimensions || { width: 0, height: 0 };
        const gridWidth = dims.width || 0;
        const gridHeight = dims.height || 0;
        const pointSize = Math.max(2, Math.floor(Math.min(this.canvas.width, this.canvas.height) * 0.46 / Math.max(gridWidth, gridHeight, 1)));

        this.drawReferenceRings();

        const payloadLayers = state?.layers || {};
        if (layers.average) {
            this.drawGrid(payloadLayers.average, pointSize, (value) => this.signalColor(value, 0.82));
        }
        if (layers.current) {
            this.drawGrid(payloadLayers.current, Math.max(pointSize, 3), (value) => this.signalColor(value, 0.55));
        }
        if (layers.tracks) {
            this.drawGrid(payloadLayers.satellite_tracks, Math.max(pointSize, 3), (value) => this.trackColor(value));
        }
        if (layers.mask) {
            this.drawGrid(payloadLayers.persistent_mask, Math.max(pointSize, 3), (value) => value ? [0.90, 0.38, 0.24, 0.72] : null);
        }

        if (layers.clusters) {
            this.drawClusters(state?.persistent_obstructions?.clusters || [], gridWidth, gridHeight);
        }
        if (layers.dish) {
            this.drawDish(state?.dish);
        }
        if (layers.satellites) {
            this.drawSatellites(state?.live_satellites || []);
        }
    }

    drawReferenceRings() {
        this.drawCircle(0.92, [0.42, 0.49, 0.58, 0.88]);
        this.drawCircle(0.92 * (2 / 3), [0.28, 0.33, 0.41, 0.45]);
        this.drawCircle(0.92 * (1 / 3), [0.22, 0.26, 0.33, 0.35]);

        const axes = [];
        axes.push(...this.lineVertex(0, 90, 0, 0, [0.30, 0.36, 0.45, 0.30], 1));
        axes.push(...this.lineVertex(90, 90, 90, 0, [0.30, 0.36, 0.45, 0.30], 1));
        axes.push(...this.lineVertex(180, 90, 180, 0, [0.30, 0.36, 0.45, 0.30], 1));
        axes.push(...this.lineVertex(270, 90, 270, 0, [0.30, 0.36, 0.45, 0.30], 1));
        this.drawVertices(this.gl.LINES, axes, false);
    }

    drawCircle(radius, color) {
        const vertices = [];
        const steps = 160;
        for (let index = 0; index <= steps; index += 1) {
            const theta = (index / steps) * Math.PI * 2;
            const x = Math.cos(theta) * radius;
            const y = Math.sin(theta) * radius;
            vertices.push(x, y, ...color, 1);
        }
        this.drawVertices(this.gl.LINE_STRIP, vertices, false);
    }

    drawGrid(grid, pointSize, colorFn) {
        if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0])) {
            return;
        }
        const vertices = [];
        const height = grid.length;
        const width = grid[0].length;

        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const value = grid[y][x];
                if (value == null || value < 0) {
                    continue;
                }
                const color = colorFn(value);
                if (!color) {
                    continue;
                }
                const [px, py] = this.projectGrid(x, y, width, height);
                vertices.push(px, py, color[0], color[1], color[2], color[3], pointSize);
            }
        }

        this.drawVertices(this.gl.POINTS, vertices, true);
    }

    drawClusters(clusters, gridWidth, gridHeight) {
        if (!clusters.length || !gridWidth || !gridHeight) {
            return;
        }

        const cells = [];
        const centroids = [];

        for (const cluster of clusters) {
            for (const [x, y] of cluster.cells || []) {
                const [px, py] = this.projectGrid(x, y, gridWidth, gridHeight);
                cells.push(px, py, 1.0, 0.78, 0.34, 0.35, 4);
            }

            const centroid = cluster.centroid;
            if (centroid && Number.isFinite(centroid.azimuth) && Number.isFinite(centroid.elevation)) {
                const [px, py] = this.projectSky(centroid.azimuth, centroid.elevation);
                centroids.push(px, py, 1.0, 0.92, 0.50, 1.0, 8);
            }
        }

        this.drawVertices(this.gl.POINTS, cells, true);
        this.drawVertices(this.gl.POINTS, centroids, true);
    }

    drawDish(dish) {
        if (!dish || !Number.isFinite(dish.azimuth) || !Number.isFinite(dish.elevation)) {
            return;
        }

        const [px, py] = this.projectSky(dish.azimuth, dish.elevation);
        const vertices = [
            0, 0, 1, 1, 1, 0.9, 1,
            px, py, 1, 1, 1, 0.9, 1,
        ];
        this.drawVertices(this.gl.LINES, vertices, false);
        this.drawVertices(this.gl.POINTS, [px, py, 1, 1, 1, 1, 8], true);
    }

    drawSatellites(satellites) {
        if (!satellites.length) {
            return;
        }
        const vertices = [];
        for (const satellite of satellites) {
            if (!Number.isFinite(satellite.azimuth) || !Number.isFinite(satellite.elevation)) {
                continue;
            }
            const [px, py] = this.projectSky(satellite.azimuth, satellite.elevation);
            const alpha = 0.45 + Math.min(0.55, satellite.elevation / 90);
            vertices.push(px, py, 0.36, 0.84, 0.96, alpha, 7);
        }
        this.drawVertices(this.gl.POINTS, vertices, true);
    }

    drawVertices(mode, data, pointMode) {
        if (!data.length) {
            return;
        }

        const typed = data instanceof Float32Array ? data : new Float32Array(data);
        this.gl.useProgram(this.program);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, typed, this.gl.STREAM_DRAW);

        const stride = 7 * Float32Array.BYTES_PER_ELEMENT;
        this.gl.enableVertexAttribArray(this.attribs.position);
        this.gl.vertexAttribPointer(this.attribs.position, 2, this.gl.FLOAT, false, stride, 0);
        this.gl.enableVertexAttribArray(this.attribs.color);
        this.gl.vertexAttribPointer(this.attribs.color, 4, this.gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
        this.gl.enableVertexAttribArray(this.attribs.size);
        this.gl.vertexAttribPointer(this.attribs.size, 1, this.gl.FLOAT, false, stride, 6 * Float32Array.BYTES_PER_ELEMENT);
        this.gl.uniform1f(this.uniforms.pointMode, pointMode ? 1 : 0);
        this.gl.drawArrays(mode, 0, typed.length / 7);
    }

    projectGrid(x, y, width, height) {
        const azimuth = ((x + 0.5) / width) * 360;
        const elevation = 90 - ((y + 0.5) / height) * 90;
        return this.projectSky(azimuth, elevation);
    }

    projectSky(azimuth, elevation) {
        const radius = ((90 - elevation) / 90) * 0.92;
        const theta = (azimuth * Math.PI) / 180;
        return [
            Math.sin(theta) * radius,
            Math.cos(theta) * radius,
        ];
    }

    lineVertex(fromAz, fromEl, toAz, toEl, color, size) {
        const [x0, y0] = this.projectSky(fromAz, fromEl);
        const [x1, y1] = this.projectSky(toAz, toEl);
        return [
            x0, y0, ...color, size,
            x1, y1, ...color, size,
        ];
    }

    signalColor(value, alpha) {
        const v = Math.max(0, Math.min(1, value));
        return [
            0.1 + (1 - v) * 0.85,
            0.2 + v * 0.78,
            0.22 + v * 0.18,
            alpha,
        ];
    }

    trackColor(value) {
        const v = Math.max(0, Math.min(1, value));
        if (v <= 0) {
            return null;
        }
        return [
            0.18 + v * 0.25,
            0.45 + v * 0.4,
            0.65 + v * 0.25,
            0.16 + v * 0.65,
        ];
    }
}

const renderer = new SkyRenderer(document.getElementById("sky-canvas"));
const state = {
    payload: null,
    layers: {
        average: true,
        current: false,
        mask: true,
        tracks: true,
        satellites: true,
        dish: true,
        clusters: true,
    },
};

const metricGrid = document.getElementById("metric-grid");
const clusterList = document.getElementById("cluster-list");
const satelliteList = document.getElementById("satellite-list");
const connectionPill = document.getElementById("connection-pill");
const clusterSummary = document.getElementById("cluster-summary");
const trackingSummary = document.getElementById("tracking-summary");
const observerLine = document.getElementById("observer-line");
const tleStatus = document.getElementById("tle-status");

document.querySelectorAll("[data-layer]").forEach((input) => {
    input.addEventListener("change", () => {
        state.layers[input.dataset.layer] = input.checked;
    });
});

document.getElementById("reset-button").addEventListener("click", async () => {
    await fetch("/api/reset", { method: "POST" });
});

document.getElementById("refresh-tle-button").addEventListener("click", async () => {
    await fetch("/api/tle/refresh", { method: "POST" });
});

document.getElementById("export-button").addEventListener("click", async () => {
    const layer = document.getElementById("export-layer").value;
    const response = await fetch(`/api/export?layer=${encodeURIComponent(layer)}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `starlink-${layer}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
});

function renderHud(payload) {
    const metrics = payload?.metrics || {};
    const tle = payload?.tle || {};
    const tracking = payload?.passive_tracking || {};
    const observer = payload?.observer;
    const clusters = payload?.persistent_obstructions?.clusters || [];
    const liveSatellites = payload?.live_satellites || [];
    const collectorError = payload?.errors?.collector;

    const stateClass = collectorError ? "danger" : payload?.ready ? "success" : "warning";
    connectionPill.className = `pill ${stateClass}`;
    connectionPill.textContent = collectorError || (payload?.ready ? "Telemetry streaming" : "Waiting for telemetry");

    metricGrid.innerHTML = [
        metricCard("Dish state", metrics.state || "Unknown"),
        metricCard("Latency", formatMs(metrics.latency_ms)),
        metricCard("Packet loss", formatPercent(metrics.packet_loss)),
        metricCard("Downlink", formatBps(metrics.downlink_bps)),
        metricCard("Uplink", formatBps(metrics.uplink_bps)),
        metricCard("Obstructed", formatPercent(metrics.fraction_obstructed)),
        metricCard("Dish azimuth", formatAngle(payload?.dish?.azimuth)),
        metricCard("Dish elevation", formatAngle(payload?.dish?.elevation)),
    ].join("");

    if (observer) {
        observerLine.textContent = `Observer: ${observer.latitude.toFixed(4)}°, ${observer.longitude.toFixed(4)}° at ${Math.round(observer.altitude_m)} m`;
    } else {
        observerLine.textContent = "Observer location unavailable. Set GPS permissions or STARLINK_OBSERVER_LAT/LON.";
    }

    if (!clusters.length) {
        clusterSummary.textContent = "No stable obstruction clusters detected yet.";
        clusterList.innerHTML = "";
    } else {
        const stats = payload?.persistent_obstructions?.stats || {};
        clusterSummary.textContent = `${clusters.length} persistent clusters across ${Math.round((stats.coverage || 0) * 100)}% of the sky grid.`;
        clusterList.innerHTML = clusters.slice(0, 5).map((cluster, index) => `
            <div class="metric">
                <span class="label">Cluster ${index + 1}</span>
                <div class="value">${cluster.size} cells • ${cluster.centroid.azimuth}° / ${cluster.centroid.elevation}°</div>
                <div class="status-line">Mean obstruction score ${cluster.mean_score}</div>
            </div>
        `).join("");
    }

    trackingSummary.textContent = `${tracking.total_events || 0} passive good-signal events, ${liveSatellites.length} visible satellites, throughput threshold ${formatBps(tracking.thresholds?.throughput_bps)}.`;
    satelliteList.innerHTML = liveSatellites.slice(0, 6).map((satellite) => `
        <div class="metric">
            <span class="label">${satellite.name}</span>
            <div class="value">${formatAngle(satellite.azimuth)} / ${formatAngle(satellite.elevation)}</div>
            <div class="status-line">Range ${satellite.range_km.toFixed(1)} km</div>
        </div>
    `).join("");

    if (tle.available) {
        tleStatus.textContent = `${tle.satellite_count} TLE entries loaded, ${tle.visible_count} above horizon. Last refresh ${formatDateTime(tle.updated_at)}.`;
    } else if (tle.error) {
        tleStatus.textContent = `TLE catalog unavailable: ${tle.error}`;
    } else {
        tleStatus.textContent = "TLE catalog has not been loaded yet.";
    }
}

function metricCard(label, value) {
    return `
        <div class="metric">
            <span class="label">${label}</span>
            <div class="value">${value}</div>
        </div>
    `;
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

function formatPercent(value) {
    if (!Number.isFinite(value)) {
        return "n/a";
    }
    return `${(value * 100).toFixed(2)}%`;
}

function formatMs(value) {
    if (!Number.isFinite(value)) {
        return "n/a";
    }
    return `${value.toFixed(1)} ms`;
}

function formatAngle(value) {
    if (!Number.isFinite(value)) {
        return "n/a";
    }
    return `${value.toFixed(1)}°`;
}

function formatDateTime(value) {
    if (!value) {
        return "n/a";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function pollState() {
    try {
        const response = await fetch("/api/state", { cache: "no-store" });
        const payload = await response.json();
        state.payload = payload;
        renderHud(payload);
    } catch (error) {
        connectionPill.className = "pill danger";
        connectionPill.textContent = `Fetch error: ${error.message}`;
    } finally {
        window.setTimeout(pollState, 1500);
    }
}

function tick() {
    renderer.render(state.payload, state.layers);
    window.requestAnimationFrame(tick);
}

pollState();
tick();
