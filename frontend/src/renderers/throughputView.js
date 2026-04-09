import { createPackedVertexStream } from "./packing.js";

function toClip(x, y, width, height) {
  return [(x / width) * 2 - 1, 1 - (y / height) * 2];
}

function rectVertices(left, top, right, bottom, color, viewport) {
  const [x0, y0] = toClip(left, top, viewport.width, viewport.height);
  const [x1, y1] = toClip(right, bottom, viewport.width, viewport.height);
  return [
    x0, y0, ...color,
    x1, y0, ...color,
    x1, y1, ...color,
    x0, y0, ...color,
    x1, y1, ...color,
    x0, y1, ...color,
  ];
}

export function createThroughputGeometry(snapshot, panel, viewport) {
  const throughput = snapshot?.throughput;
  if (!throughput) {
    return new Float32Array();
  }

  const safe = (value) => (Number.isFinite(value) ? value : 0);

  const margin = 28;
  const plotLeft = panel.x + margin;
  const plotRight = panel.x + panel.width - margin;
  const barWidth = plotRight - plotLeft;
  const confidenceTop = panel.y + 56;
  const confidenceBottom = confidenceTop + 10;
  const firstBarTop = panel.y + Math.max(152, panel.height * 0.30);
  const secondBarTop = panel.y + Math.max(300, panel.height * 0.56);
  const barHeight = 18;
  const maxThroughput = Math.max(
    safe(throughput.current?.downlink_bps),
    safe(throughput.current?.uplink_bps),
    safe(throughput.optimal?.downlink_bps),
    safe(throughput.optimal?.uplink_bps),
    safe(throughput.autorate?.recommended_downlink_bps),
    safe(throughput.autorate?.recommended_uplink_bps),
    1,
  );

  const vertexData = [];
  vertexData.push(
    ...rectVertices(
      plotLeft,
      confidenceTop,
      plotRight,
      confidenceBottom,
      [1.0, 1.0, 1.0, 0.12],
      viewport,
    ),
  );
  vertexData.push(
    ...rectVertices(
      plotLeft,
      confidenceTop,
      plotLeft + barWidth * throughput.confidence,
      confidenceBottom,
      [1.0, 1.0, 1.0, 0.56],
      viewport,
    ),
  );

  const bars = [
    {
      top: firstBarTop,
      current: safe(throughput.current?.downlink_bps),
      optimal: safe(throughput.optimal?.downlink_bps),
      recommended: safe(throughput.autorate?.recommended_downlink_bps) || safe(throughput.optimal?.downlink_bps),
      colors: {
        optimal: [1.0, 1.0, 1.0, 0.2],
        current: [1.0, 1.0, 1.0, 0.94],
        recommended: [1.0, 1.0, 1.0, 0.7],
      },
    },
    {
      top: secondBarTop,
      current: safe(throughput.current?.uplink_bps),
      optimal: safe(throughput.optimal?.uplink_bps),
      recommended: safe(throughput.autorate?.recommended_uplink_bps) || safe(throughput.optimal?.uplink_bps),
      colors: {
        optimal: [1.0, 1.0, 1.0, 0.2],
        current: [1.0, 1.0, 1.0, 0.94],
        recommended: [1.0, 1.0, 1.0, 0.7],
      },
    },
  ];

  bars.forEach((bar) => {
    const left = plotLeft;
    const top = bar.top;
    const bottom = top + barHeight;
    const trackTop = top - 6;
    const trackBottom = bottom + 6;
    vertexData.push(...rectVertices(left, trackTop, left + barWidth, trackBottom, [1.0, 1.0, 1.0, 0.08], viewport));
    vertexData.push(...rectVertices(left, top, left + barWidth * (bar.optimal / maxThroughput), bottom, bar.colors.optimal, viewport));
    vertexData.push(...rectVertices(left, top + 3, left + barWidth * (bar.current / maxThroughput), bottom - 3, bar.colors.current, viewport));
    const markerX = left + barWidth * (bar.recommended / maxThroughput);
    vertexData.push(...rectVertices(markerX - 1.5, trackTop - 8, markerX + 1.5, trackBottom + 8, bar.colors.recommended, viewport));
  });

  return new Float32Array(vertexData);
}

export function createThroughputView(regl) {
  const stream = createPackedVertexStream(regl);
  const draw = regl({
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
    count: regl.prop("count"),
    primitive: "triangles",
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

  return {
    draw(vertices) {
      if (!vertices.length) {
        return;
      }
      draw(stream.props(vertices));
    },
    destroy() {
      stream.destroy();
    },
  };
}
