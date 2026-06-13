/**
 * TerrainChunk.js – Shared chunk generation logic (server + client).
 *
 * A chunk is a 32×32 vertex grid. The world is divided into chunks
 * identified by (cx, cz). Each chunk generates its own heightmap,
 * biome, decorations, and collision data using the global seed.
 *
 * Biomes: prairie, forest, desert, snow, swamp.
 * Rivers carved via noise-guided random walk.
 * Deterministic: same seed + chunk coords = same chunk.
 */
import { createNoise2D } from "simplex-noise";

// ─── Constants ───────────────────────────────────────────────────────────────
export const CHUNK_SIZE = 32;       // vertices per chunk side
export const CHUNK_WORLD_SIZE = 32; // world units per chunk (1 unit/vertex)
export const VIEW_RADIUS = 3;       // chunks around player to load
export const LOD_LEVELS = [1, 2, 4]; // vertex step for LOD 0/1/2

// ─── PRNG ────────────────────────────────────────────────────────────────────
export function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Biome Definitions ──────────────────────────────────────────────────────
export const BIOMES = {
  prairie: {
    name: "prairie",
    groundColor: [0.35, 0.65, 0.25],
    dirtColor: [0.55, 0.42, 0.28],
    amplitude: 2.5,
    frequency: 0.015,
    treeProbability: 0.005,
    rockProbability: 0.003,
    bushProbability: 0.008,
    flowerProbability: 0.012,
    treeTypes: ["oak", "birch"],
    extraObjects: [],
  },
  forest: {
    name: "forest",
    groundColor: [0.2, 0.5, 0.15],
    dirtColor: [0.45, 0.35, 0.22],
    amplitude: 3.5,
    frequency: 0.02,
    treeProbability: 0.04,
    rockProbability: 0.005,
    bushProbability: 0.02,
    flowerProbability: 0.005,
    treeTypes: ["pine", "oak", "birch"],
    extraObjects: ["stump"],
  },
  desert: {
    name: "desert",
    groundColor: [0.85, 0.78, 0.55],
    dirtColor: [0.75, 0.65, 0.42],
    amplitude: 1.5,
    frequency: 0.008,
    treeProbability: 0.001,
    rockProbability: 0.008,
    bushProbability: 0.001,
    flowerProbability: 0.0,
    treeTypes: ["cactus"],
    extraObjects: ["cactus", "sand_dune"],
  },
  snow: {
    name: "snow",
    groundColor: [0.92, 0.95, 0.98],
    dirtColor: [0.7, 0.72, 0.75],
    amplitude: 4.0,
    frequency: 0.018,
    treeProbability: 0.008,
    rockProbability: 0.006,
    bushProbability: 0.002,
    flowerProbability: 0.0,
    treeTypes: ["pine_snow"],
    extraObjects: ["snowman"],
  },
  swamp: {
    name: "swamp",
    groundColor: [0.3, 0.45, 0.25],
    dirtColor: [0.4, 0.38, 0.2],
    amplitude: 0.8,
    frequency: 0.025,
    treeProbability: 0.015,
    rockProbability: 0.002,
    bushProbability: 0.01,
    flowerProbability: 0.0,
    treeTypes: ["dead_tree", "willow"],
    extraObjects: ["mushroom", "puddle"],
  },
};

export const BIOME_LIST = Object.keys(BIOMES);

// ─── Biome Selection ────────────────────────────────────────────────────────
/**
 * Returns the biome name for a world position using warped noise.
 */
export function getBiomeAt(wx, wz, biomeNoise) {
  const n1 = biomeNoise(wx * 0.003, wz * 0.003);
  const n2 = biomeNoise(wx * 0.006 + 500, wz * 0.006 + 500);
  const combined = (n1 + n2) / 2;

  if (combined < -0.4) return "swamp";
  if (combined < -0.1) return "forest";
  if (combined < 0.2) return "prairie";
  if (combined < 0.5) return "snow";
  return "desert";
}

/**
 * Returns the biome blend weights at a world position.
 * Used for smooth transitions at chunk borders.
 */
export function getBiomeWeights(wx, wz, biomeNoise) {
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

  // Normalize
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (const k in weights) weights[k] /= total;
  } else {
    weights.prairie = 1;
  }
  return weights;
}

// ─── River Generation ───────────────────────────────────────────────────────
const riverCache = new Map(); // seed -> Set

/**
 * Generates river paths as a set of "x,z" strings.
 * Rivers flow from north to south using noise-guided random walk.
 */
export function generateRivers(seed, numRivers = 3) {
  if (riverCache.has(seed)) return riverCache.get(seed);

  const rng = mulberry32(seed + 5000);
  const rivers = new Set();
  const worldSize = 256; // reasonable world size for chunk-based system

  for (let r = 0; r < numRivers; r++) {
    let x = Math.floor(rng() * worldSize);
    let z = 0;
    const riverWidth = 2 + Math.floor(rng() * 2);

    while (z < worldSize) {
      // Mark river cells (width)
      for (let dz = 0; dz < riverWidth; dz++) {
        for (let dx = 0; dx < riverWidth; dx++) {
          rivers.add(`${x + dx},${z + dz}`);
        }
      }

      // Noise-guided walk: bias toward flowing south (z+)
      const noiseVal = Math.sin(x * 0.05 + seed) * 2;
      x += Math.round(noiseVal + (rng() - 0.5) * 2);
      x = Math.max(1, Math.min(worldSize - 2, x));
      z += 1;
    }
  }
  riverCache.set(seed, rivers);
  return rivers;
}

/**
 * Check if a world position is in a river.
 */
function isRiver(wx, wz, riverSet) {
  return riverSet.has(`${wx},${wz}`);
}

// ─── Chunk Generation ───────────────────────────────────────────────────────
/**
 * Generates a single chunk's data: heightmap, biome, decorations, collisions.
 *
 * @param {number} seed - Global world seed
 * @param {number} cx - Chunk X coordinate
 * @param {number} cz - Chunk Z coordinate
 * @param {object} [overrides] - Map modifications to apply
 * @returns {object} Chunk data
 */
export function generateChunk(seed, cx, cz, overrides = null, blockedDecorations = null) {
  // Create deterministic RNG for this chunk
  const chunkSeed = seed + cx * 73856093 ^ cz * 19349669;
  const rng = mulberry32(chunkSeed);

  // Noise generators for this chunk
  const heightNoise = createNoise2D(mulberry32(seed));
  const biomeNoise = createNoise2D(mulberry32(seed + 9999));
  const detailNoise = createNoise2D(mulberry32(seed + 1));

  const worldOffsetX = cx * CHUNK_SIZE;
  const worldOffsetZ = cz * CHUNK_SIZE;

  // Generate rivers once per seed (cached)
  const riverSet = generateRivers(seed, 3);

  // Determine dominant biome for this chunk
  const centerX = worldOffsetX + CHUNK_SIZE / 2;
  const centerZ = worldOffsetZ + CHUNK_SIZE / 2;
  const dominantBiome = getBiomeAt(centerX, centerZ, biomeNoise);

  // Generate heightmap
  const gridCount = CHUNK_SIZE + 1;
  const heightmap = [];
  const biomeMap = [];

  for (let lz = 0; lz < gridCount; lz++) {
    heightmap[lz] = [];
    biomeMap[lz] = [];

    for (let lx = 0; lx < gridCount; lx++) {
      const wx = worldOffsetX + lx;
      const wz = worldOffsetZ + lz;

      // Get biome weights for smooth transitions
      const weights = getBiomeWeights(wx, wz, biomeNoise);

      // Blend height from all contributing biomes
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

      // River carving: lower terrain where rivers flow
      if (isRiver(wx, wz, riverSet)) {
        h = Math.min(h, -0.5); // Carve river bed
        primaryBiome = "swamp"; // Rivers count as swamp biome
      }

      heightmap[lz][lx] = h;
      biomeMap[lz][lx] = primaryBiome;
    }
  }

  // Generate decorations
  const decorations = [];
  const collisionCircles = [];
  const decRng = mulberry32(chunkSeed + 2000);

  for (let lz = 2; lz < CHUNK_SIZE - 2; lz++) {
    for (let lx = 2; lx < CHUNK_SIZE - 2; lx++) {
      const wx = worldOffsetX + lx;
      const wz = worldOffsetZ + lz;
      const biome = biomeMap[lz][lx];
      const b = BIOMES[biome];

      // Trees
      if (decRng() < b.treeProbability) {
        const h = heightmap[lz][lx];
        if (h > -0.3) {
          const treeType = b.treeTypes[Math.floor(decRng() * b.treeTypes.length)];
          decorations.push({
            type: "tree",
            subType: treeType,
            x: wx, z: wz,
            h,
            ry: decRng() * Math.PI * 2,
            radius: 1.2,
          });
          collisionCircles.push({ x: wx, z: wz, radius: 1.2 });
        }
      }

      // Rocks
      if (decRng() < b.rockProbability) {
        const h = heightmap[lz][lx];
        decorations.push({
          type: "rock",
          x: wx, z: wz, h,
          ry: decRng() * Math.PI * 2,
          radius: 0.8,
        });
        collisionCircles.push({ x: wx, z: wz, radius: 0.8 });
      }

      // Bushes
      if (decRng() < b.bushProbability) {
        const h = heightmap[lz][lx];
        if (h > -0.2) {
          decorations.push({
            type: "bush",
            x: wx, z: wz, h,
            ry: decRng() * Math.PI * 2,
            radius: 0.5,
          });
          collisionCircles.push({ x: wx, z: wz, radius: 0.5 });
        }
      }

      // Flowers (client-side only, no collision)
      if (decRng() < b.flowerProbability) {
        const h = heightmap[lz][lx];
        if (h > 0) {
          decorations.push({
            type: "flower",
            x: wx, z: wz, h,
            ry: decRng() * Math.PI * 2,
            radius: 0,
          });
        }
      }
    }
  }

  // Filter decorations blocked by map-defined areas
  if (blockedDecorations && blockedDecorations.length > 0) {
    for (const block of blockedDecorations) {
      const bx = block.x;
      const bz = block.z;
      const br = block.radius || 3;
      const br2 = br * br;
      for (let i = decorations.length - 1; i >= 0; i--) {
        const d = decorations[i];
        const dx = d.x - bx;
        const dz = d.z - bz;
        if (dx * dx + dz * dz < br2) {
          decorations.splice(i, 1);
        }
      }
      for (let i = collisionCircles.length - 1; i >= 0; i--) {
        const c = collisionCircles[i];
        const dx = c.x - bx;
        const dz = c.z - bz;
        if (dx * dx + dz * dz < br2) {
          collisionCircles.splice(i, 1);
        }
      }
    }
  }

  // Apply overrides
  if (overrides && overrides.length > 0) {
    for (const ov of overrides) {
      const lx = ov.x - worldOffsetX;
      const lz = ov.z - worldOffsetZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) continue;

      if (ov.type === "height") {
        heightmap[lz][lx] = ov.value;
      } else if (ov.type === "remove_object") {
        const idx = decorations.findIndex(
          (d) => Math.floor(d.x) === ov.x && Math.floor(d.z) === ov.z,
        );
        if (idx >= 0) {
          decorations.splice(idx, 1);
          // Remove corresponding collision circle
          const cIdx = collisionCircles.findIndex(
            (c) => Math.floor(c.x) === ov.x && Math.floor(c.z) === ov.z,
          );
          if (cIdx >= 0) collisionCircles.splice(cIdx, 1);
        }
      } else if (ov.type === "place_object") {
        decorations.push({
          type: ov.objectType,
          subType: ov.subType || ov.objectType,
          x: ov.x, z: ov.z,
          h: heightmap[lz]?.[lx] ?? 0,
          ry: ov.ry || 0,
          radius: ov.radius || 1,
        });
        if (ov.radius > 0) {
          collisionCircles.push({ x: ov.x, z: ov.z, radius: ov.radius });
        }
      }
    }
  }

  return {
    cx, cz,
    heightmap,
    biomeMap,
    dominantBiome,
    decorations,
    collisionCircles,
    worldOffsetX,
    worldOffsetZ,
  };
}

/**
 * Sample terrain height at any world position.
 */
export function sampleHeight(seed, wx, wz) {
  const cx = Math.floor(wx / CHUNK_SIZE);
  const cz = Math.floor(wz / CHUNK_SIZE);
  const chunk = generateChunk(seed, cx, cz);
  const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const lz = ((wz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return chunk.heightmap[Math.floor(lz)]?.[Math.floor(lx)] ?? 0;
}

/**
 * Generate UV coordinates for texture atlas based on height and biome.
 * Each tile is a 64x64 region in the atlas (256x256 atlas = 4x4 grid).
 * heightMapping: [{ min, max, tileIndex }]
 */
export function generateUVs(heightmap, biomeMap, heightMapping) {
  if (!heightMapping || heightMapping.length === 0) return null;

  const gridCount = heightmap.length;
  const uv = new Float32Array(gridCount * gridCount * 2);
  const tileSize = 1 / 4;

  for (let lz = 0; lz < gridCount; lz++) {
    for (let lx = 0; lx < gridCount; lx++) {
      const i = lz * gridCount + lx;
      const h = heightmap[lz][lx];
      let tile = 0;

      for (const mapping of heightMapping) {
        if (h >= mapping.min && h < mapping.max) {
          tile = mapping.tileIndex;
          break;
        }
      }

      const tx = tile % 4;
      const ty = Math.floor(tile / 4);
      const u0 = tx * tileSize;
      const v0 = 1 - (ty + 1) * tileSize;
      const u1 = (tx + 1) * tileSize;
      const v1 = 1 - ty * tileSize;

      const margin = 0.003;
      uv[i * 2] = u0 + margin + (lx % 2) * (u1 - u0 - margin * 2);
      uv[i * 2 + 1] = v0 + margin + (lz % 2) * (v1 - v0 - margin * 2);
    }
  }

  return uv;
}
