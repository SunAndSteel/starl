import createREGL from "regl";
import { azelToXYZ } from "../skyMath.js";
import { createOrbitCamera } from "./orbitCamera.js";

const EMPTY_FLOATS = new Float32Array(0);
const GUIDE_RADIUS = 1.002;

function createStream(regl, components) {
  const buffer = regl.buffer({
    usage: "dynamic",
    type: "float",
    data: EMPTY_FLOATS,
  });

  return {
    props(values) {
      const data = values?.length ? values : EMPTY_FLOATS;
      buffer({
        usage: "dynamic",
        type: "float",
        data,
      });
      return {
        buffer,
        count: Math.floor(data.length / components),
      };
    },
    destroy() {
      buffer.destroy();
    },
  };
}

function createStaticGeometry(regl, data, components, primitive = "line strip", color = [1, 1, 1]) {
  const buffer = regl.buffer({
    usage: "static",
    type: "float",
    data,
  });

  return {
    buffer,
    count: Math.floor(data.length / components),
    primitive,
    color,
    destroy() {
      buffer.destroy();
    },
  };
}

function scaleVector(vector, radius) {
  return [
    vector[0] * radius,
    vector[1] * radius,
    vector[2] * radius,
  ];
}

function buildElevationRing(elevationDeg, radius = GUIDE_RADIUS, segments = 160, alpha = 0.12) {
  const values = [];
  for (let index = 0; index <= segments; index += 1) {
    const azimuth = (index / segments) * 360;
    const point = scaleVector(azelToXYZ(azimuth, elevationDeg), radius);
    values.push(point[0], point[1], point[2], alpha);
  }
  return new Float32Array(values);
}

function buildMeridian(azimuthDeg, radius = GUIDE_RADIUS, segments = 56, alpha = 0.1) {
  const values = [];
  for (let index = 0; index <= segments; index += 1) {
    const elevation = (index / segments) * 90;
    const point = scaleVector(azelToXYZ(azimuthDeg, elevation), radius);
    values.push(point[0], point[1], point[2], alpha);
  }
  return new Float32Array(values);
}

function createGuideGeometry(regl) {
  const guides = [
    createStaticGeometry(regl, buildElevationRing(0, GUIDE_RADIUS, 200, 0.18), 4, "line strip"),
    createStaticGeometry(regl, buildElevationRing(30, GUIDE_RADIUS, 160, 0.08), 4, "line strip"),
    createStaticGeometry(regl, buildElevationRing(60, GUIDE_RADIUS, 160, 0.08), 4, "line strip"),
    createStaticGeometry(regl, buildElevationRing(80, GUIDE_RADIUS, 160, 0.06), 4, "line strip"),
    createStaticGeometry(regl, buildMeridian(0, GUIDE_RADIUS, 64, 0.08), 4, "line strip"),
    createStaticGeometry(regl, buildMeridian(45, GUIDE_RADIUS, 64, 0.06), 4, "line strip"),
    createStaticGeometry(regl, buildMeridian(90, GUIDE_RADIUS, 64, 0.08), 4, "line strip"),
    createStaticGeometry(regl, buildMeridian(135, GUIDE_RADIUS, 64, 0.06), 4, "line strip"),
  ];

  return {
    lines: guides,
    destroy() {
      this.lines.forEach((guide) => guide.destroy());
    },
  };
}

export function createSkyRenderer(canvas) {
  const regl = createREGL({
    canvas,
    attributes: {
      antialias: true,
      alpha: true,
    },
  });

  const camera = createOrbitCamera(canvas);
  const guideGeometry = createGuideGeometry(regl);
  const layerStream = createStream(regl, 5);
  const obstructionStream = createStream(regl, 8);
  const solidStream = createStream(regl, 3);
  const satelliteStream = createStream(regl, 6);
  const lineStream = createStream(regl, 4);

  const blendState = {
    enable: true,
    func: {
      srcRGB: "src alpha",
      dstRGB: "one minus src alpha",
      srcAlpha: "one",
      dstAlpha: "one minus src alpha",
    },
  };

  const drawSolidMesh = regl({
    blend: blendState,
    depth: {
      enable: true,
      mask: true,
    },
    cull: {
      enable: false,
    },
    frag: `
      precision mediump float;
      uniform vec3 uColor;
      uniform float uAlpha;
      varying float vShade;

      void main() {
        gl_FragColor = vec4(uColor * vShade, uAlpha);
      }
    `,
    vert: `
      precision mediump float;
      attribute vec3 position;
      uniform mat4 uProjection;
      uniform mat4 uView;
      varying float vShade;

      void main() {
        gl_Position = uProjection * uView * vec4(position, 1.0);
        vShade = 0.68 + (clamp(position.y, -0.3, 0.6) * 0.18) + (clamp(position.z, -0.5, 0.5) * 0.06);
      }
    `,
    attributes: {
      position: {
        buffer: regl.prop("buffer"),
        size: 3,
        stride: 12,
        offset: 0,
      },
    },
    uniforms: {
      uProjection: regl.prop("projectionMatrix"),
      uView: regl.prop("viewMatrix"),
      uColor: regl.prop("color"),
      uAlpha: regl.prop("alpha"),
    },
    primitive: "triangles",
    count: regl.prop("count"),
  });

  const drawLayerPoints = regl({
    blend: blendState,
    depth: {
      enable: true,
      mask: false,
    },
    frag: `
      precision mediump float;
      uniform vec3 uColor;
      varying float vAlpha;

      void main() {
        vec2 centered = gl_PointCoord * 2.0 - 1.0;
        float radius = length(centered);
        if (radius > 1.0) {
          discard;
        }
        float falloff = 1.0 - smoothstep(0.32, 1.0, radius);
        gl_FragColor = vec4(uColor, vAlpha * falloff);
      }
    `,
    vert: `
      precision mediump float;
      attribute vec3 position;
      attribute float pointSize;
      attribute float alpha;
      uniform mat4 uProjection;
      uniform mat4 uView;
      uniform float uPixelRatio;
      varying float vAlpha;

      void main() {
        gl_Position = uProjection * uView * vec4(position, 1.0);
        gl_PointSize = max(1.0, pointSize * uPixelRatio);
        vAlpha = alpha;
      }
    `,
    attributes: {
      position: {
        buffer: regl.prop("buffer"),
        size: 3,
        stride: 20,
        offset: 0,
      },
      pointSize: {
        buffer: regl.prop("buffer"),
        size: 1,
        stride: 20,
        offset: 12,
      },
      alpha: {
        buffer: regl.prop("buffer"),
        size: 1,
        stride: 20,
        offset: 16,
      },
    },
    uniforms: {
      uProjection: regl.prop("projectionMatrix"),
      uView: regl.prop("viewMatrix"),
      uPixelRatio: regl.prop("pixelRatio"),
      uColor: regl.prop("color"),
    },
    primitive: "points",
    count: regl.prop("count"),
  });

  const drawObstructionPoints = regl({
    blend: blendState,
    depth: {
      enable: true,
      mask: false,
    },
    frag: `
      precision mediump float;
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        vec2 centered = gl_PointCoord * 2.0 - 1.0;
        float radius = length(centered);
        if (radius > 1.0) {
          discard;
        }
        float falloff = 1.0 - smoothstep(0.2, 1.0, radius);
        gl_FragColor = vec4(vColor, vAlpha * falloff);
      }
    `,
    vert: `
      precision mediump float;
      attribute vec3 position;
      attribute float pointSize;
      attribute vec3 color;
      attribute float alpha;
      uniform mat4 uProjection;
      uniform mat4 uView;
      uniform float uPixelRatio;
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        gl_Position = uProjection * uView * vec4(position, 1.0);
        gl_PointSize = max(1.0, pointSize * uPixelRatio);
        vColor = color;
        vAlpha = alpha;
      }
    `,
    attributes: {
      position: {
        buffer: regl.prop("buffer"),
        size: 3,
        stride: 32,
        offset: 0,
      },
      pointSize: {
        buffer: regl.prop("buffer"),
        size: 1,
        stride: 32,
        offset: 12,
      },
      color: {
        buffer: regl.prop("buffer"),
        size: 3,
        stride: 32,
        offset: 16,
      },
      alpha: {
        buffer: regl.prop("buffer"),
        size: 1,
        stride: 32,
        offset: 28,
      },
    },
    uniforms: {
      uProjection: regl.prop("projectionMatrix"),
      uView: regl.prop("viewMatrix"),
      uPixelRatio: regl.prop("pixelRatio"),
    },
    primitive: "points",
    count: regl.prop("count"),
  });

  const drawLines = regl({
    blend: blendState,
    depth: {
      enable: true,
      mask: false,
    },
    frag: `
      precision mediump float;
      uniform vec3 uColor;
      varying float vAlpha;

      void main() {
        gl_FragColor = vec4(uColor, vAlpha);
      }
    `,
    vert: `
      precision mediump float;
      attribute vec3 position;
      attribute float alpha;
      uniform mat4 uProjection;
      uniform mat4 uView;
      varying float vAlpha;

      void main() {
        gl_Position = uProjection * uView * vec4(position, 1.0);
        vAlpha = alpha;
      }
    `,
    attributes: {
      position: {
        buffer: regl.prop("buffer"),
        size: 3,
        stride: 16,
        offset: 0,
      },
      alpha: {
        buffer: regl.prop("buffer"),
        size: 1,
        stride: 16,
        offset: 12,
      },
    },
    uniforms: {
      uProjection: regl.prop("projectionMatrix"),
      uView: regl.prop("viewMatrix"),
      uColor: regl.prop("color"),
    },
    primitive: regl.prop("primitive"),
    count: regl.prop("count"),
    lineWidth: 1,
  });

  const drawSatellites = regl({
    blend: blendState,
    depth: {
      enable: true,
      mask: false,
    },
    frag: `
      precision mediump float;
      varying float vQuality;
      varying float vOpacity;

      vec3 qualityToColor(float q) {
        if (q > 0.5) {
          float t = (q - 0.5) * 2.0;
          return mix(vec3(1.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0), t);
        }
        float t = q * 2.0;
        return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), t);
      }

      void main() {
        vec2 centered = gl_PointCoord * 2.0 - 1.0;
        float radius = length(centered);
        if (radius > 1.0) {
          discard;
        }
        float halo = 1.0 - smoothstep(0.38, 1.0, radius);
        float core = 1.0 - smoothstep(0.0, 0.18, radius);
        vec3 color = qualityToColor(clamp(vQuality, 0.0, 1.0));
        float alpha = vOpacity * (0.2 + halo * 0.58 + core * 0.22);
        gl_FragColor = vec4(mix(color * 0.38, color, halo), alpha);
      }
    `,
    vert: `
      precision mediump float;
      attribute vec3 position;
      attribute float pointSize;
      attribute float quality;
      attribute float opacity;
      uniform mat4 uProjection;
      uniform mat4 uView;
      uniform float uPixelRatio;
      varying float vQuality;
      varying float vOpacity;

      void main() {
        gl_Position = uProjection * uView * vec4(position, 1.0);
        gl_PointSize = max(3.0, pointSize * uPixelRatio);
        vQuality = quality;
        vOpacity = opacity;
      }
    `,
    attributes: {
      position: {
        buffer: regl.prop("buffer"),
        size: 3,
        stride: 24,
        offset: 0,
      },
      pointSize: {
        buffer: regl.prop("buffer"),
        size: 1,
        stride: 24,
        offset: 12,
      },
      quality: {
        buffer: regl.prop("buffer"),
        size: 1,
        stride: 24,
        offset: 16,
      },
      opacity: {
        buffer: regl.prop("buffer"),
        size: 1,
        stride: 24,
        offset: 20,
      },
    },
    uniforms: {
      uProjection: regl.prop("projectionMatrix"),
      uView: regl.prop("viewMatrix"),
      uPixelRatio: regl.prop("pixelRatio"),
    },
    primitive: "points",
    count: regl.prop("count"),
  });

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    regl._gl.viewport(0, 0, canvas.width, canvas.height);
    return {
      pixelRatio: dpr,
      aspect: width / Math.max(height, 1),
    };
  }

  function drawLineBatch(cameraState, points, color, primitive = "line strip") {
    if (!points?.length) {
      return;
    }

    drawLines({
      ...cameraState,
      ...lineStream.props(points),
      color,
      primitive,
    });
  }

  return {
    render(scene) {
      const layout = resize();
      const cameraState = {
        ...camera.getMatrices(layout.aspect),
        pixelRatio: layout.pixelRatio,
      };

      regl.clear({ color: [0, 0, 0, 0], depth: 1 });

      guideGeometry.lines.forEach((guide) => {
        drawLines({
          ...cameraState,
          ...guide,
        });
      });

      if (!scene) {
        return;
      }

      scene.solidLayers?.forEach((layer) => {
        if (!layer.points?.length) {
          return;
        }
        drawSolidMesh({
          ...cameraState,
          ...solidStream.props(layer.points),
          color: layer.color || [1, 1, 1],
          alpha: layer.alpha ?? 0.8,
        });
      });

      if (scene.obstructionMap?.length) {
        drawObstructionPoints({
          ...cameraState,
          ...obstructionStream.props(scene.obstructionMap),
        });
      }

      scene.layers.forEach((layer) => {
        if (!layer.points?.length) {
          return;
        }
        drawLayerPoints({
          ...cameraState,
          ...layerStream.props(layer.points),
          color: layer.color,
        });
      });

      scene.lineLayers?.forEach((lineLayer) => {
        drawLineBatch(
          cameraState,
          lineLayer.points,
          lineLayer.color || [1, 1, 1],
          lineLayer.primitive || "line strip",
        );
      });

      if (scene.satellites?.length) {
        drawSatellites({
          ...cameraState,
          ...satelliteStream.props(scene.satellites),
        });
      }
    },

    tick() {
      return camera.tick();
    },

    resetCamera() {
      camera.reset();
    },

    getCameraState() {
      const aspect = Math.max(canvas.clientWidth / Math.max(canvas.clientHeight, 1), 1e-6);
      return camera.getMatrices(aspect);
    },

    destroy() {
      camera.destroy();
      guideGeometry.destroy();
      layerStream.destroy();
      obstructionStream.destroy();
      solidStream.destroy();
      satelliteStream.destroy();
      lineStream.destroy();
      regl.destroy();
    },
  };
}
