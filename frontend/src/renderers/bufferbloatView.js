import { createPackedVertexStream } from "./packing.js";

function toClip(x, y, width, height) {
  return [(x / width) * 2 - 1, 1 - (y / height) * 2];
}

function log10(value) {
  return Math.log(value) / Math.log(10);
}

export function createBufferbloatGeometry(snapshot, panel, viewport) {
  const dataset = snapshot?.bufferbloat || [];
  if (!dataset.length) {
    return {
      area: new Float32Array(),
      line: new Float32Array(),
    };
  }

  const minLoad = dataset[0].load_min_bps;
  const maxLoad = dataset[dataset.length - 1].load_max_bps;
  const maxLatency = Math.max(...dataset.map((point) => point.max_latency_ms), 1);
  const areaVertices = [];
  const lineVertices = [];
  const left = panel.x + 36;
  const right = panel.x + panel.width - 28;
  const top = panel.y + 104;
  const bottom = panel.y + panel.height - 72;

  const xFor = (load) => {
    const ratio = (log10(load) - log10(minLoad)) / (log10(maxLoad) - log10(minLoad) || 1);
    return left + ratio * (right - left);
  };
  const yFor = (latency) => bottom - (latency / maxLatency) * (bottom - top);

  dataset.forEach((point) => {
    const x = xFor(point.load_mid_bps);
    const yMedian = yFor(point.median_latency_ms);

    const [ax0, ay0] = toClip(x, bottom, viewport.width, viewport.height);
    const [ax1, ay1] = toClip(x, yMedian, viewport.width, viewport.height);
    areaVertices.push(ax0, ay0, 1.0, 1.0, 1.0, 0.0);
    areaVertices.push(ax1, ay1, 1.0, 1.0, 1.0, 0.12);

    const [lx, ly] = toClip(x, yMedian, viewport.width, viewport.height);
    lineVertices.push(lx, ly, 1.0, 1.0, 1.0, 0.92);
  });

  return {
    area: new Float32Array(areaVertices),
    line: new Float32Array(lineVertices),
  };
}

export function createBufferbloatView(regl) {
  const areaStream = createPackedVertexStream(regl);
  const lineStream = createPackedVertexStream(regl);
  const drawArea = regl({
    frag: `
      precision mediump float;
      varying vec4 vColor;
      void main() {
        gl_FragColor = vColor;
      }
    `,
    vert: `
      precision mediump float;
      attribute vec2 position;
      attribute vec4 color;
      varying vec4 vColor;
      void main() {
        vColor = color;
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `,
    attributes: {
      position: {
        buffer: regl.prop("buffer"),
        size: 2,
        stride: 24,
        offset: 0,
      },
      color: {
        buffer: regl.prop("buffer"),
        size: 4,
        stride: 24,
        offset: 8,
      },
    },
    primitive: "triangle strip",
    count: regl.prop("count"),
    depth: {
      enable: false,
      mask: false,
    },
    blend: {
      enable: true,
      func: {
        srcRGB: "src alpha",
        dstRGB: "one minus src alpha",
        srcAlpha: "one",
        dstAlpha: "one minus src alpha",
      },
    },
  });

  const drawLine = regl({
    frag: `
      precision mediump float;
      varying vec4 vColor;
      void main() {
        gl_FragColor = vColor;
      }
    `,
    vert: `
      precision mediump float;
      attribute vec2 position;
      attribute vec4 color;
      varying vec4 vColor;
      void main() {
        vColor = color;
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `,
    attributes: {
      position: {
        buffer: regl.prop("buffer"),
        size: 2,
        stride: 24,
        offset: 0,
      },
      color: {
        buffer: regl.prop("buffer"),
        size: 4,
        stride: 24,
        offset: 8,
      },
    },
    primitive: "line strip",
    count: regl.prop("count"),
    depth: {
      enable: false,
      mask: false,
    },
    // Many WebGL drivers only expose a line-width range of [1, 1].
    // Leaving the width at the implementation default avoids startup crashes.
  });

  return {
    draw({ area, line }) {
      if (area.length) {
        drawArea(areaStream.props(area));
      }
      if (line.length) {
        drawLine(lineStream.props(line));
      }
    },
    destroy() {
      areaStream.destroy();
      lineStream.destroy();
    },
  };
}
