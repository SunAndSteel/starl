import { createPackedVertexStream } from "./packing.js";

const STATE_COLORS = {
  OK: [0.38, 0.83, 0.48, 0.85],
  DEGRADED: [0.95, 0.74, 0.26, 0.9],
  INSTABILITY: [0.92, 0.47, 0.27, 0.92],
  MICRO_OUTAGE: [0.85, 0.30, 0.30, 0.96],
  OUTAGE: [0.73, 0.12, 0.18, 0.98],
};

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

export function projectTimeline(snapshot, panel, viewport, interaction) {
  const latestMs = Date.parse(snapshot.generated_at);
  const visibleEnd = latestMs - interaction.offsetMs;
  const visibleStart = visibleEnd - interaction.windowMs;
  const vertexData = [];
  const hoverRects = [];
  const plotLeft = panel.x + 186;
  const plotRight = panel.x + panel.width - 24;
  const trackTop = panel.y + 54;
  const trackBottom = trackTop + Math.min(92, Math.max(58, panel.height * 0.22));
  const innerTop = trackTop + 10;
  const innerBottom = trackBottom - 10;

  if (plotRight > plotLeft) {
    vertexData.push(
      ...rectVertices(plotLeft, trackTop, plotRight, trackBottom, [0.07, 0.11, 0.17, 0.88], viewport),
      ...rectVertices(plotLeft, trackTop, plotRight, trackTop + 1.5, [0.2, 0.29, 0.4, 0.46], viewport),
      ...rectVertices(plotLeft, trackBottom - 1.5, plotRight, trackBottom, [0.2, 0.29, 0.4, 0.22], viewport),
    );
  }

  if (!snapshot?.timeline?.length) {
    return { vertices: new Float32Array(vertexData), hoverRects };
  }

  snapshot.timeline.forEach((event, index) => {
    const eventStart = Date.parse(event.start);
    const eventEnd = Date.parse(event.end) + 1000;
    if (eventEnd < visibleStart || eventStart > visibleEnd) {
      return;
    }

    const x0 = plotLeft + ((Math.max(eventStart, visibleStart) - visibleStart) / interaction.windowMs) * (plotRight - plotLeft);
    const x1 = plotLeft + ((Math.min(eventEnd, visibleEnd) - visibleStart) / interaction.windowMs) * (plotRight - plotLeft);
    const left = Math.max(plotLeft, Math.min(x0, x1));
    const right = Math.min(plotRight, Math.max(x0, x1) + 2);
    const color = STATE_COLORS[event.state] || STATE_COLORS.OK;

    vertexData.push(...rectVertices(left, innerTop, right, innerBottom, color, viewport));

    hoverRects.push({ event, left, right, top: trackTop, bottom: trackBottom, index });
  });

  return { vertices: new Float32Array(vertexData), hoverRects };
}

export function createTimelineView(regl) {
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
