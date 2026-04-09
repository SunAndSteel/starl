import createREGL from "regl";
import { createBufferbloatGeometry, createBufferbloatView } from "./bufferbloatView.js";
import { createPanelLayout } from "./layout.js";
import { createPackedVertexStream } from "./packing.js";
import { createThroughputGeometry, createThroughputView } from "./throughputView.js";

export function createDashboard(canvas) {
  const regl = createREGL({
    canvas,
    attributes: {
      antialias: true,
      alpha: false,
    },
  });

  const throughputView = createThroughputView(regl);
  const bufferbloatView = createBufferbloatView(regl);
  const panelBackgroundStream = createPackedVertexStream(regl);

  const drawPanelBackground = regl({
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
  });

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(canvas.clientWidth * dpr);
    const height = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    regl._gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const panelBackground = (panel, viewport, color) => {
    const x0 = (panel.x / viewport.width) * 2 - 1;
    const x1 = ((panel.x + panel.width) / viewport.width) * 2 - 1;
    const y0 = 1 - (panel.y / viewport.height) * 2;
    const y1 = 1 - ((panel.y + panel.height) / viewport.height) * 2;
    return new Float32Array([
      x0, y0, ...color,
      x1, y0, ...color,
      x1, y1, ...color,
      x0, y0, ...color,
      x1, y1, ...color,
      x0, y1, ...color,
    ]);
  };

  const render = (snapshot, interaction) => {
    resize();
    const viewport = { width: canvas.clientWidth, height: canvas.clientHeight };
    const layout = createPanelLayout(viewport.width, viewport.height);
    regl.clear({ color: [0.0, 0.0, 0.0, 1], depth: 1 });

    [
      panelBackground(layout.throughput, viewport, [0.035, 0.035, 0.035, 0.96]),
      panelBackground(layout.bufferbloat, viewport, [0.02, 0.02, 0.02, 0.98]),
    ].forEach((vertices) => drawPanelBackground(panelBackgroundStream.props(vertices)));

    const throughputVertices = createThroughputGeometry(snapshot, layout.throughput, viewport);
    throughputView.draw(throughputVertices);

    const bufferbloat = createBufferbloatGeometry(snapshot, layout.bufferbloat, viewport);
    bufferbloatView.draw(bufferbloat);
  };

  return {
    render,
    layout() {
      return createPanelLayout(canvas.clientWidth, canvas.clientHeight);
    },
    destroy() {
      panelBackgroundStream.destroy();
      throughputView.destroy();
      bufferbloatView.destroy();
      regl.destroy();
    },
  };
}
