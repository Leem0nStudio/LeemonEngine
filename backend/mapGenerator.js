/**
 * Procedural Map Generator — Shared between server and client.
 *
 * Uses deterministic seed-based PRNG + value noise so that both sides
 * produce identical height maps, obstacle maps, and portal positions.
 *
 * Supported map types:
 *   'field'   – rolling hills via 2D value noise, scattered trees/rocks
 *   'dungeon' – BSP room-and-corridor layout with stone walls
 *
 * Both generators return the same MapData shape:
 *   { obstacleMap, heightMap, spawnPoints, portals, config }
 */

// ─── Seeded PRNG (Mulberry32) ───────────────────────────────────────────────
// Period ≈ 2^32, good enough for procedural generation.
export function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Simple hash for string seeds ───────────────────────────────────────────
export function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

// ─── 2D Value Noise ─────────────────────────────────────────────────────────
// Produces smooth, deterministic height fields from a seed.
// Uses bilinear interpolation of a seeded random grid.
export function valueNoise2D(x, y, rng) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  // Smoothstep interpolation (Hermite)
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);

  // Deterministic corner hashes from the RNG sequence
  const seed = rng();
  const hash = (cx, cy) => {
    const s2 = mulberry32(seed + cx * 374761393 + cy * 668265263);
    return s2();
  };

  const n00 = hash(ix, iy);
  const n10 = hash(ix + 1, iy);
  const n01 = hash(ix, iy + 1);
  const n11 = hash(ix + 1, iy + 1);

  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return nx0 + (nx1 - nx0) * v;
}

// ─── Multi-octave noise ─────────────────────────────────────────────────────
// Stacks multiple频率 layers for natural-looking terrain.
function fbm(x, y, rng, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    // Each octave uses a different slice of the RNG sequence
    const layerRng = mulberry32((rng() * 2147483647) | 0);
    value += amplitude * valueNoise2D(x * frequency, y * frequency, layerRng);
    maxValue += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return value / maxValue; // Normalise to [0, 1]
}

// ─── Field Generator ────────────────────────────────────────────────────────
// Generates a natural outdoor terrain with:
//   • Smooth height map via multi-octave value noise
//   • Trees (cones + cylinders) placed pseudo-randomly
//   • Rocks scattered on flat areas
//   • Border walls around the perimeter
//   • A portal at a fixed position for dungeon transition
export function generateField(seed, width = 40, height = 40) {
  const rng = mulberry32(seed);

  const obstacleMap = [];
  const heightMap = [];

  // Initialise grids
  for (let z = 0; z < height; z++) {
    obstacleMap[z] = new Array(width).fill(0);
    heightMap[z] = new Array(width).fill(0);
  }

  // 1. Generate height map ──────────────────────────────────────────────────
  // Scale controls how "zoomed in" the noise is; lower = smoother hills.
  const heightScale = 0.08;
  const minHeight = -2;
  const maxHeight = 5;
  const range = maxHeight - minHeight;

  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      const nx = x * heightScale;
      const ny = z * heightScale;
      const noiseVal = fbm(nx, ny, rng, 4, 2.0, 0.5);
      heightMap[z][x] = minHeight + noiseVal * range;
    }
  }

  // 2. Border walls ─────────────────────────────────────────────────────────
  for (let x = 0; x < width; x++) {
    obstacleMap[0][x] = 1;
    obstacleMap[height - 1][x] = 1;
  }
  for (let z = 0; z < height; z++) {
    obstacleMap[z][0] = 1;
    obstacleMap[z][width - 1] = 1;
  }

  // 3. Trees ────────────────────────────────────────────────────────────────
  // Place pseudo-randomly with a density governed by the seed.
  const treeRng = mulberry32(seed + 9999);
  const treeSpacing = 4; // Minimum gap between trees in grid cells

  for (let z = 2; z < height - 2; z += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      if (obstacleMap[z][x] !== 0) continue;
      if (treeRng() > 0.04) continue; // ~4% chance per cell

      // Enforce minimum spacing from other trees
      let tooClose = false;
      for (let dz = -treeSpacing; dz <= treeSpacing && !tooClose; dz++) {
        for (let dx = -treeSpacing; dx <= treeSpacing && !tooClose; dx++) {
          const nz = z + dz;
          const nx = x + dx;
          if (nz >= 0 && nz < height && nx >= 0 && nx < width) {
            if (obstacleMap[nz][nx] === 2) tooClose = true; // 2 = tree
          }
        }
      }
      if (tooClose) continue;

      // Avoid placing trees at the spawn point (grid 2,2)
      if (x <= 3 && z <= 3) continue;

      obstacleMap[z][x] = 2; // 2 = tree
    }
  }

  // 4. Rocks ────────────────────────────────────────────────────────────────
  const rockRng = mulberry32(seed + 7777);
  for (let z = 2; z < height - 2; z++) {
    for (let x = 2; x < width - 2; x++) {
      if (obstacleMap[z][x] !== 0) continue;
      if (rockRng() > 0.008) continue; // ~0.8% chance
      if (x <= 3 && z <= 3) continue; // Keep spawn clear
      obstacleMap[z][x] = 3; // 3 = rock
    }
  }

  // 5. Portal to dungeon ────────────────────────────────────────────────────
  // Place near the far corner, cleared of obstacles
  const portalX = width - 5;
  const portalZ = height - 5;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const pz = portalZ + dz;
      const px = portalX + dx;
      if (pz >= 0 && pz < height && px >= 0 && px < width) {
        obstacleMap[pz][px] = 0;
      }
    }
  }

  return {
    obstacleMap,
    heightMap,
    spawnPoints: [{ x: 2, z: 2 }],
    portals: [{ x: portalX, z: portalZ, targetMap: 'dungeon', targetSeed: seed + 1 }],
    config: { seed, type: 'field', width, height, cellSize: 5 },
  };
}

// ─── Dungeon Generator ──────────────────────────────────────────────────────
// Uses Binary Space Partitioning to carve rooms connected by corridors.
//   • Rooms are rectangular open areas
//   • Corridors connect room centres (L-shaped paths)
//   • Walls surround all walkable cells
//   • Spawn in first room, portal in last room
export function generateDungeon(seed, gridW = 30, gridH = 30) {
  const rng = mulberry32(seed);

  const obstacleMap = [];
  const heightMap = [];

  for (let z = 0; z < gridH; z++) {
    obstacleMap[z] = new Array(gridW).fill(1); // Start fully walled
    heightMap[z] = new Array(gridW).fill(0);
  }

  // ── BSP Tree ─────────────────────────────────────────────────────────────
  const MIN_LEAF = 6;

  class Leaf {
    constructor(x, y, w, h) {
      this.x = x;
      this.y = y;
      this.w = w;
      this.h = h;
      this.left = null;
      this.right = null;
      this.room = null;
    }

    split() {
      if (this.left || this.right) return false;
      if (this.w < MIN_LEAF * 2 && this.h < MIN_LEAF * 2) return false;

      const splitH = this.w > this.h
        ? false
        : this.h > this.w
          ? true
          : rng() > 0.5;

      const max = (splitH ? this.h : this.w) - MIN_LEAF;
      if (max <= MIN_LEAF) return false;

      const split = MIN_LEAF + Math.floor(rng() * (max - MIN_LEAF));

      if (splitH) {
        this.left = new Leaf(this.x, this.y, this.w, split);
        this.right = new Leaf(this.x, this.y + split, this.w, this.h - split);
      } else {
        this.left = new Leaf(this.x, this.y, split, this.h);
        this.right = new Leaf(this.x + split, this.y, this.w - split, this.h);
      }
      return true;
    }

    createRooms() {
      if (this.left || this.right) {
        if (this.left) this.left.createRooms();
        if (this.right) this.right.createRooms();
        if (this.left && this.right) {
          const la = this.left.getRoom();
          const ra = this.right.getRoom();
          if (la && ra) connectRooms(la, ra);
        }
      } else {
        const rw = Math.floor(this.w * (0.5 + rng() * 0.3));
        const rh = Math.floor(this.h * (0.5 + rng() * 0.3));
        const rx = this.x + Math.floor(rng() * (this.w - rw));
        const ry = this.y + Math.floor(rng() * (this.h - rh));
        this.room = { x: rx, y: ry, w: rw, h: rh };

        // Carve the room into the grid
        for (let dz = 0; dz < rh; dz++) {
          for (let dx = 0; dx < rw; dx++) {
            const gz = ry + dz;
            const gx = rx + dx;
            if (gz >= 0 && gz < gridH && gx >= 0 && gx < gridW) {
              obstacleMap[gz][gx] = 0;
            }
          }
        }
      }
    }

    getRoom() {
      if (this.room) return this.room;
      const lr = this.left?.getRoom();
      const rr = this.right?.getRoom();
      if (lr && rr) return rng() > 0.5 ? lr : rr;
      return lr || rr;
    }
  }

  // Carve an L-shaped corridor between two room centres
  function connectRooms(a, b) {
    const ax = Math.floor(a.x + a.w / 2);
    const az = Math.floor(a.y + a.h / 2);
    const bx = Math.floor(b.x + b.w / 2);
    const bz = Math.floor(b.y + b.h / 2);

    let cx = ax;
    let cz = az;

    // Horizontal segment
    while (cx !== bx) {
      if (cz >= 0 && cz < gridH && cx >= 0 && cx < gridW) {
        obstacleMap[cz][cx] = 0;
      }
      cx += cx < bx ? 1 : -1;
    }
    // Vertical segment
    while (cz !== bz) {
      if (cz >= 0 && cz < gridH && cx >= 0 && cx < gridW) {
        obstacleMap[cz][cx] = 0;
      }
      cz += cz < bz ? 1 : -1;
    }
  }

  // Run BSP subdivision
  const root = new Leaf(1, 1, gridW - 2, gridH - 2);
  const leaves = [root];
  let didSplit = true;
  while (didSplit) {
    didSplit = false;
    const len = leaves.length;
    for (let i = 0; i < len; i++) {
      if (!leaves[i].left && !leaves[i].right) {
        if (leaves[i].split()) {
          leaves.push(leaves[i].left, leaves[i].right);
          didSplit = true;
        }
      }
    }
  }
  root.createRooms();

  // Add walls around every walkable cell (8-neighbour check)
  const wallMap = [];
  for (let z = 0; z < gridH; z++) {
    wallMap[z] = new Array(gridW).fill(0);
  }
  for (let z = 0; z < gridH; z++) {
    for (let x = 0; x < gridW; x++) {
      if (obstacleMap[z][x] === 0) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nz = z + dz;
            const nx = x + dx;
            if (nz >= 0 && nz < gridH && nx >= 0 && nx < gridW) {
              if (obstacleMap[nz][nx] === 1) wallMap[nz][nx] = 1;
            }
          }
        }
      }
    }
  }
  for (let z = 0; z < gridH; z++) {
    for (let x = 0; x < gridW; x++) {
      if (wallMap[z][x] === 1) obstacleMap[z][x] = 1;
    }
  }

  // Collect room centres for spawn/portal placement
  const roomCentres = [];
  function collectRooms(leaf) {
    if (leaf.room) {
      roomCentres.push({
        x: Math.floor(leaf.room.x + leaf.room.w / 2),
        z: Math.floor(leaf.room.y + leaf.room.h / 2),
      });
    }
    if (leaf.left) collectRooms(leaf.left);
    if (leaf.right) collectRooms(leaf.right);
  }
  collectRooms(root);

  const spawn = roomCentres[0] || { x: Math.floor(gridW / 2), z: Math.floor(gridH / 2) };
  const portalPos = roomCentres.length > 1
    ? roomCentres[roomCentres.length - 1]
    : { x: Math.min(spawn.x + 5, gridW - 2), z: Math.min(spawn.z + 5, gridH - 2) };

  // Clear the portal cell
  if (portalPos.z >= 0 && portalPos.z < gridH && portalPos.x >= 0 && portalPos.x < gridW) {
    obstacleMap[portalPos.z][portalPos.x] = 0;
  }

  return {
    obstacleMap,
    heightMap,
    spawnPoints: [spawn],
    portals: [{ x: portalPos.x, z: portalPos.z, targetMap: 'field', targetSeed: seed - 1 }],
    config: { seed, type: 'dungeon', width: gridW, height: gridH, cellSize: 10 },
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────
/**
 * Generate a procedural map.
 *
 * @param {number|string} seed  – Numeric seed or string (auto-hashed)
 * @param {'field'|'dungeon'} type – Map type
 * @param {object} [overrides]  – Optional { width, height } overrides
 * @returns {MapData}
 */
export function generateMap(seed, type = 'field', overrides = {}) {
  const numericSeed = typeof seed === 'string' ? hashSeed(seed) : seed;

  switch (type) {
    case 'field':
      return generateField(numericSeed, overrides.width || 40, overrides.height || 40);
    case 'dungeon':
      return generateDungeon(numericSeed, overrides.width || 30, overrides.height || 30);
    default:
      throw new Error(`Unknown map type: ${type}. Use 'field' or 'dungeon'.`);
  }
}
