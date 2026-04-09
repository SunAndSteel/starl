const EMPTY_VERTICES = new Float32Array(0);

export function createPackedVertexStream(regl) {
  const buffer = regl.buffer({
    usage: "dynamic",
    type: "float",
    data: EMPTY_VERTICES,
  });

  return {
    props(vertices) {
      const packed = vertices?.length ? vertices : EMPTY_VERTICES;
      buffer({
        usage: "dynamic",
        type: "float",
        data: packed,
      });
      return {
        buffer,
        count: Math.floor(packed.length / 6),
      };
    },
    destroy() {
      buffer.destroy();
    },
  };
}
