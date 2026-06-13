/**
 * chunkWorker.js – Web Worker for chunk geometry generation.
 *
 * Receives chunk generation requests and returns vertex data
 * (positions, colors, indices) that can be used to build BufferGeometry.
 *
 * Message format:
 *   { type: "generate", seed, cx, cz }
 *
 * Response format:
 *   { type: "result", cx, cz, positions, colors, indices, decorations }
 */
import { createNoise2D } from "simplex-noise";

// ─── Constants (mirrored from TerrainChunk.js) ─────────────────────────────
const CHUNK_SIZE = 32;

const BIOMES = {
  prairie: { amplitude: 2.5, frequency: 0.015 },
  forest: { amplitude: 3.5, frequency: 0.02 },
  desert: { amplitude: 1.5, frequency: 0.008 },
  snow: { amplitude: 4.0, frequency: 0.018 },
  swamp: { amplitude: 0.8, frequency: 0.025 },
};

// ─── PRNG ──────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Biome Selection ──────────────────────────────────────────────────────
function getBiomeAt(wx, wz, biomeNoise) {
  const n1 = biomeNoise(wx * 0.003, wz * 0.003);
  const n2 = biomeNoise(wx * 0.006 + 500, wz * 0.006 + 500);
  const combined = (n1 + n2) / 2;

  if (combined < -0.4) return "swamp";
  if (combined < -0.1) return "forest";
  if (combined < 0.2) return "prairie";
  if (combined < 0.5) return "snow";
  return "desert";
}

function getBiomeWeights(wx, wz, biomeNoise) {
  const n1 = biomeNoise(wx * 0.003, wz * 0.003);
  const n2 = biomeNoise(wx * 0.006 + 500, wz * 0.006 + 500);
  const v = (n1 + n2) / 2;

  const weights = {};
  const thresholds = [
    { biome: "swamp", center: -0.55 },
    { biome: "forest", center: -0.25 },
    { biome: "prairie", center: 0.05 },
    { biome: "snow", center: 0.35 },
    { biome: "desert", center: 0.65 },
  ];

  for (const t of thresholds) {
    const dist = Math.abs(v - t.center);
    const w = Math.max(0, 1 - dist / 0.25);
    if (w > 0) weights[t.biome] = w;
  }

  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (const k in weights) weights[k] /= total;
  } else {
    weights.prairie = 1;
  }
  return weights;
}

// ─── Biome Colors ─────────────────────────────────────────────────────────
const BIOME_COLORS = {
  prairie: { grass: [0.35, 0.65, 0.25], dirt: [0.55, 0.42, 0.28], stone: [0.62, 0.62, 0.62] },
  forest: { grass: [0.2, 0.5, 0.15], dirt: [0.45, 0.35, 0.22], stone: [0.5, 0.5, 0.5] },
  desert: { grass: [0.85, 0.78, 0.55], dirt: [0.75, 0.65, 0.42], stone: [0.69, 0.63, 0.5] },
  snow: { grass: [0.92, 0.95, 0.98], dirt: [0.7, 0.72, 0.75], stone: [0.56, 0.58, 0.6] },
  swamp: { grass: [0.3, 0.45, 0.25], dirt: [0.4, 0.38, 0.2], stone: [0.44, 0.46, 0.38] },
};

// ─── Generate Geometry Data ───────────────────────────────────────────────
function generateGeometry(seed, cx, cz) {
  // Use a slightly larger grid (CHUNK_SIZE + 1) to eliminate gaps between chunks
  const gridCount = CHUNK_SIZE + 1;
  const vertexCount = gridCount * gridCount;

  const chunkSeed = seed + cx * 73856093 ^ cz * 19349669;
  const heightNoise = createNoise2D(mulberry32(chunkSeed));
  const biomeNoise = createNoise2D(mulberry32(seed + 9999));
  const detailNoise = createNoise2D(mulberry32(chunkSeed + 1));

  const worldOffsetX = cx * CHUNK_SIZE;
  const worldOffsetZ = cz * CHUNK_SIZE;

  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const biomeMap = new Array(gridCount);
  const heightmap = new Array(gridCount);

  for (let lz = 0; lz < gridCount; lz++) {
    heightmap[lz] = new Float32Array(gridCount);
    biomeMap[lz] = new Array(gridCount);

    for (let lx = 0; lx < gridCount; lx++) {
      const wx = worldOffsetX + lx;
      const wz = worldOffsetZ + lz;
      const i = lz * gridCount + lx;

      const weights = getBiomeWeights(wx, wz, biomeNoise);
      let h = 0;
      let primaryBiome = "prairie";
      let maxWeight = 0;

      for (const [biomeName, weight] of Object.entries(weights)) {
        if (weight <= 0) continue;
        const b = BIOMES[biomeName];
        const nx = wx * b.frequency;
        const nz = wz * b.frequency;
        let biomeH = heightNoise(nx, nz) * b.amplitude;
        biomeH += detailNoise(nx * 3, nz * 3) * (b.amplitude * 0.15);
        h += biomeH * weight;
        if (weight > maxWeight) {
          maxWeight = weight;
          primaryBiome = biomeName;
        }
      }

      heightmap[lz][lx] = h;
      biomeMap[lz][lx] = primaryBiome;

      positions[i * 3] = wx;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = wz;

      // Slope-based coloring
      const palette = BIOME_COLORS[primaryBiome] || BIOME_COLORS.prairie;
      let slope = 0;
      if (lz > 0 && lz < gridCount - 1 && lx > 0 && lx < gridCount - 1) {
        const sx = Math.abs(heightmap[lz][lx + 1] - heightmap[lz][lx - 1]) / 2;
        const sz = Math.abs(heightmap[lz + 1]?.[lx] - heightmap[lz - 1]?.[lx]) / 2 || 0;
        slope = Math.sqrt(sx * sx + sz * sz);
      }

      let r, g, b2;
      if (slope > 1.5) {
        [r, g, b2] = palette.stone;
      } else if (slope > 0.8) {
        [r, g, b2] = palette.dirt;
      } else {
        [r, g, b2] = palette.grass;
        const v = Math.sin(wx * 0.2) * Math.cos(wz * 0.2) * 0.08;
        r += v; g += v;
      }

      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b2;
    }
  }

  // Indices
  const indexCount = CHUNK_SIZE * CHUNK_SIZE * 6;
  const indices = new Uint32Array(indexCount);
  let idx = 0;
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const tl = lz * gridCount + lx;
      const tr = tl + 1;
      const bl = (lz + 1) * gridCount + lx;
      const br = bl + 1;
      indices[idx++] = tl;
      indices[idx++] = bl;
      indices[idx++] = tr;
      indices[idx++] = tr;
      indices[idx++] = bl;
      indices[idx++] = br;
    }
  }

  return { positions, colors, indices, heightmap, biomeMap };
}

// ─── Message Handler ──────────────────────────────────────────────────────
self.onmessage = function (e) {
  const { type, seed, cx, cz, id } = e.data;

  if (type === "generate") {
    try {
      const result = generateGeometry(seed, cx, cz);
      self.postMessage({
        type: "result",
        id,
        cx,
        cz,
        positions: result.positions,
        colors: result.colors,
        indices: result.indices,
      }, [result.positions.buffer, result.colors.buffer, result.indices.buffer]);
    } catch (err) {
      self.postMessage({ type: "error", id, cx, cz, error: err.message });
    }
  }
};
