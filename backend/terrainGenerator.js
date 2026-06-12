/**
 * terrainGenerator.js – Continuous terrain generation using simplex noise.
 *
 * Generates a 200×200 heightmap with rolling hills, deterministic decorations
 * (trees, rocks, bushes, benches, lampposts), random-walk dirt paths,
 * and collision data for server-side validation.
 *
 * Shared between server and client for deterministic generation from a seed.
 */
import { createNoise2D } from "simplex-noise";

// ─── PRNG ────────────────────────────────────────────────────────────────────
// Mulberry32: fast 32-bit PRNG, period ~4B. Used for decoration placement.
export function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** DJB2-style hash: converts a string seed to a signed 32-bit integer. */
export function hashSeed(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

// ─── Terrain Constants ────────────────────────────────────────────────────────
export const TERRAIN_SIZE = 200;   // 200×200 vertices
export const CELL_SIZE = 1;       // 1 unit between vertices
export const MIN_HEIGHT = -2;
export const MAX_HEIGHT = 5;
export const MAX_SLOPE_DEG = 45;

// ─── Heightmap Generation ────────────────────────────────────────────────────
/**
 * Generates a 200×200 heightmap using simplex noise.
 * Low frequency (0.01) for smooth rolling hills.
 * Amplitude range: [-2, 5].
 *
 * @param {number} seed - Deterministic seed
 * @returns {number[][]} heightmap[z][x] with values in [MIN_HEIGHT, MAX_HEIGHT]
 */
export function generateHeightmap(seed) {
  const rng = mulberry32(seed);
  const noise2D = createNoise2D(rng);

  const heightmap = [];
  for (let z = 0; z < TERRAIN_SIZE; z++) {
    heightmap[z] = [];
    for (let x = 0; x < TERRAIN_SIZE; x++) {
      // Primary rolling hills
      const nx = x / TERRAIN_SIZE;
      const nz = z / TERRAIN_SIZE;
      let h = noise2D(nx * 6, nz * 6) * 3;

      // Secondary detail layer
      h += noise2D(nx * 12, nz * 12) * 1;

      // Ridge noise for more interesting formations
      const ridge = 1 - Math.abs(noise2D(nx * 4 + 100, nz * 4 + 100));
      h += ridge * 1;

      // Edge falloff: lower terrain near borders for natural edges
      const edgeX = Math.min(x, TERRAIN_SIZE - 1 - x) / (TERRAIN_SIZE * 0.1);
      const edgeZ = Math.min(z, TERRAIN_SIZE - 1 - z) / (TERRAIN_SIZE * 0.1);
      const edgeFalloff = Math.min(1, edgeX, edgeZ);
      h *= edgeFalloff;

      // Normalize to [MIN_HEIGHT, MAX_HEIGHT]
      const normalized = (h + 3) / 6;
      heightmap[z][x] = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, MIN_HEIGHT + normalized * (MAX_HEIGHT - MIN_HEIGHT)));
    }
  }
  return heightmap;
}

// ─── Decoration Generation ───────────────────────────────────────────────────
/**
 * Decoration types with their collision radii (bounding circles).
 */
export const DECORATION_TYPES = {
  tree:       { radius: 1.2, probability: 0.02 },
  rock:       { radius: 0.8, probability: 0.015 },
  bush:       { radius: 0.5, probability: 0.015 },
  bench:      { radius: 1.0, probability: 0.003 },
  lamppost:   { radius: 0.4, probability: 0.003 },
};

/**
 * Generates N decorations placed deterministically on the terrain.
 * Objects avoid steep slopes, water areas, and each other.
 *
 * @param {number} seed - Deterministic seed
 * @param {number[][]} heightmap - The heightmap to place decorations on
 * @returns {{ type: string, x: number, z: number, ry: number, radius: number }[]}
 */
export function generateDecorations(seed, heightmap) {
  const rng = mulberry32(seed + 1000);
  const decorations = [];
  const minSpacing = 3;
  const clearRadius = 8; // Clear area around spawn point

  for (let z = 2; z < TERRAIN_SIZE - 2; z++) {
    for (let x = 2; x < TERRAIN_SIZE - 2; x++) {
      // Skip cells near the center spawn point
      const dxCenter = x - Math.floor(TERRAIN_SIZE / 2);
      const dzCenter = z - Math.floor(TERRAIN_SIZE / 2);
      if (dxCenter * dxCenter + dzCenter * dzCenter < clearRadius * clearRadius) continue;

      for (const [type, cfg] of Object.entries(DECORATION_TYPES)) {
        if (rng() > cfg.probability) continue;

        const h = heightmap[z][x];
        // Skip steep slopes (simple slope check using neighbors)
        if (z > 0 && z < TERRAIN_SIZE - 1 && x > 0 && x < TERRAIN_SIZE - 1) {
          const slopeX = Math.abs(heightmap[z][x + 1] - heightmap[z][x - 1]) / 2;
          const slopeZ = Math.abs(heightmap[z + 1][x] - heightmap[z - 1][x]) / 2;
          if (slopeX > 1.5 || slopeZ > 1.5) continue;
        }
        // Skip low-lying areas (potential water)
        if (h < -0.5) continue;

        // Check minimum spacing from other decorations
        let tooClose = false;
        for (const d of decorations) {
          const dx = d.x - x;
          const dz = d.z - z;
          if (dx * dx + dz * dz < minSpacing * minSpacing) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;

        decorations.push({
          type,
          x,
          z,
          ry: rng() * Math.PI * 2,
          radius: cfg.radius,
        });
        break; // One decoration per cell max
      }
    }
  }
  return decorations;
}

// ─── Path Generation ─────────────────────────────────────────────────────────
/**
 * Generates dirt paths using random walks.
 * Returns a set of grid coordinates that are "path" cells.
 *
 * @param {number} seed - Deterministic seed
 * @param {number} numPaths - Number of random walks
 * @param {number} walkLength - Steps per walk
 * @returns {Set<string>} Set of "x,z" strings for path cells
 */
export function generatePaths(seed, numPaths = 5, walkLength = 80) {
  const rng = mulberry32(seed + 2000);
  const paths = new Set();
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];

  for (let p = 0; p < numPaths; p++) {
    let x = Math.floor(TERRAIN_SIZE * 0.2 + rng() * TERRAIN_SIZE * 0.6);
    let z = Math.floor(TERRAIN_SIZE * 0.2 + rng() * TERRAIN_SIZE * 0.6);

    for (let s = 0; s < walkLength; s++) {
      // Mark path (3-wide)
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = x + dx;
          const pz = z + dz;
          if (px >= 0 && px < TERRAIN_SIZE && pz >= 0 && pz < TERRAIN_SIZE) {
            paths.add(`${px},${pz}`);
          }
        }
      }

      // biased random walk: 70% continue same direction, 30% turn
      const dir = dirs[Math.floor(rng() * 4)];
      x += dir[0];
      z += dir[1];
      x = Math.max(1, Math.min(TERRAIN_SIZE - 2, x));
      z = Math.max(1, Math.min(TERRAIN_SIZE - 2, z));
    }
  }
  return paths;
}

// ─── Main Generator ──────────────────────────────────────────────────────────
/**
 * Generates complete terrain data for a field map.
 *
 * @param {number} seed - Deterministic seed
 * @returns {{
 *   heightmap: number[][],
 *   decorations: object[],
 *   paths: Set<string>,
 *   collisionCircles: { x: number, z: number, radius: number }[],
 *   spawnPoint: { x: number, z: number },
 *   config: object
 * }}
 */
export function generateTerrain(seed) {
  const heightmap = generateHeightmap(seed);
  const decorations = generateDecorations(seed, heightmap);
  const paths = generatePaths(seed);

  // Collision circles for server-side validation
  const collisionCircles = decorations.map((d) => ({
    x: d.x,
    z: d.z,
    radius: d.radius,
  }));

  // Spawn near center on flat ground
  const cx = Math.floor(TERRAIN_SIZE / 2);
  const cz = Math.floor(TERRAIN_SIZE / 2);
  // Find nearest walkable point to center
  let spawnX = cx;
  let spawnZ = cz;
  let bestH = heightmap[cz][cx];
  for (let r = 0; r < 10; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = cx + dx;
        const tz = cz + dz;
        if (tx < 0 || tx >= TERRAIN_SIZE || tz < 0 || tz >= TERRAIN_SIZE) continue;
        const h = heightmap[tz][tx];
        if (Math.abs(h) < Math.abs(bestH)) {
          bestH = h;
          spawnX = tx;
          spawnZ = tz;
        }
      }
    }
  }

  return {
    heightmap,
    decorations,
    paths,
    collisionCircles,
    spawnPoint: { x: spawnX, z: spawnZ },
    config: {
      seed,
      size: TERRAIN_SIZE,
      cellSize: CELL_SIZE,
      minHeight: MIN_HEIGHT,
      maxHeight: MAX_HEIGHT,
    },
  };
}
