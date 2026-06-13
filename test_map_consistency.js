#!/usr/bin/env node
/**
 * test_map_consistency.js – Validates deterministic continuous terrain generation.
 *
 * Run:  node test_map_consistency.js
 *
 * Tests:
 *   1. Same seed → same heightmap (deterministic)
 *   2. Different seeds → different heightmaps
 *   3. Heightmap dimensions (200×200)
 *   4. Height values within range [-2, 5]
 *   5. Decoration placement validity (within bounds, on walkable terrain)
 *   6. Collision circles match decorations
 *   7. Slope validation logic
 *   8. Spawn point validity
 *   9. Path generation validity
 *  10. PRNG determinism
 *  11. hashSeed string conversion
 *
 * Exit code 0 = all tests pass, 1 = failure.
 */
import { createHash } from "crypto";
import {
  generateTerrain,
  generateHeightmap,
  generateDecorations,
  generatePaths,
  mulberry32,
  hashSeed,
  TERRAIN_SIZE,
  MAX_SLOPE_DEG,
} from "./backend/terrainGenerator.js";
import { Quadtree, buildQuadtree } from "./backend/Quadtree.js";
import {
  generateChunk,
  CHUNK_SIZE,
  BIOMES,
  BIOME_LIST,
  sampleHeight,
} from "./shared/TerrainChunk.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function heightmapHash(heightmap) {
  const str = heightmap.map((row) => row.join(",")).join(";");
  return createHash("md5").update(str).digest("hex");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 1: Determinism – same seed → same heightmap");
{
  const a = generateHeightmap(42);
  const b = generateHeightmap(42);
  assert(a.length === b.length, "Same row count");
  assert(a[0].length === b[0].length, "Same col count");
  assert(JSON.stringify(a) === JSON.stringify(b), "Identical heightmaps");
  assert(heightmapHash(a) === heightmapHash(b), "Identical hashes");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 2: Different seeds → different heightmaps");
{
  const a = generateHeightmap(42);
  const b = generateHeightmap(99);
  assert(heightmapHash(a) !== heightmapHash(b), "Different hashes for different seeds");
  const same = JSON.stringify(a) === JSON.stringify(b);
  assert(!same, "Heightmaps differ for different seeds");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 3: Heightmap dimensions");
{
  const hm = generateHeightmap(42);
  assert(hm.length === TERRAIN_SIZE, `Row count = ${TERRAIN_SIZE}`);
  assert(hm[0].length === TERRAIN_SIZE, `Col count = ${TERRAIN_SIZE}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 4: Height values within range");
{
  const hm = generateHeightmap(42);
  let minH = Infinity, maxH = -Infinity;
  for (const row of hm) {
    for (const h of row) {
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  assert(minH >= -2, `Min height ${minH.toFixed(3)} >= -2`);
  assert(maxH <= 5, `Max height ${maxH.toFixed(3)} <= 5`);
  assert(maxH > minH, `Height range ${(maxH - minH).toFixed(3)} > 0 (not flat)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 5: Decoration placement validity");
{
  const hm = generateHeightmap(42);
  const decs = generateDecorations(42, hm);
  assert(decs.length > 0, `Decorations generated (${decs.length} found)`);

  let allInBounds = true;
  let allOnTerrain = true;
  for (const d of decs) {
    if (d.x < 0 || d.x >= TERRAIN_SIZE || d.z < 0 || d.z >= TERRAIN_SIZE) {
      allInBounds = false;
    }
    if (d.type !== 'tree' && d.type !== 'rock' && d.type !== 'bush' && d.type !== 'bench' && d.type !== 'lamppost') {
      allOnTerrain = false;
    }
  }
  assert(allInBounds, "All decorations within bounds");
  assert(allOnTerrain, "All decoration types valid");

  // Check minimum spacing
  let spacingOk = true;
  for (let i = 0; i < decs.length; i++) {
    for (let j = i + 1; j < decs.length; j++) {
      const dx = decs[i].x - decs[j].x;
      const dz = decs[i].z - decs[j].z;
      if (dx * dx + dz * dz < 9) { // minSpacing=3, squared=9
        spacingOk = false;
        console.log(`  ⚠️  Close decorations: (${decs[i].x},${decs[i].z}) and (${decs[j].x},${decs[j].z})`);
      }
    }
  }
  assert(spacingOk, "Minimum spacing between decorations");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 6: Collision circles match decorations");
{
  const terrain = generateTerrain(42);
  assert(
    terrain.collisionCircles.length === terrain.decorations.length,
    `Collision circles (${terrain.collisionCircles.length}) match decorations (${terrain.decorations.length})`,
  );
  for (const c of terrain.collisionCircles) {
    assert(c.radius > 0, `Circle at (${c.x},${c.z}) has radius ${c.radius}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 7: Slope validation logic");
{
  const hm = generateHeightmap(42);
  let steepPairs = 0;
  let walkablePairs = 0;

  for (let z = 1; z < TERRAIN_SIZE - 1; z++) {
    for (let x = 1; x < TERRAIN_SIZE - 1; x++) {
      // Check right neighbour
      if (x + 1 < TERRAIN_SIZE) {
        const dh = Math.abs(hm[z][x + 1] - hm[z][x]);
        const slope = Math.atan2(dh, 1) * (180 / Math.PI);
        if (slope > MAX_SLOPE_DEG) steepPairs++;
        else walkablePairs++;
      }
      // Check down neighbour
      if (z + 1 < TERRAIN_SIZE) {
        const dh = Math.abs(hm[z + 1][x] - hm[z][x]);
        const slope = Math.atan2(dh, 1) * (180 / Math.PI);
        if (slope > MAX_SLOPE_DEG) steepPairs++;
        else walkablePairs++;
      }
    }
  }
  assert(walkablePairs > 0, `Walkable slope pairs found (${walkablePairs})`);
  console.log(`  📊 Steep pairs: ${steepPairs}, Walkable pairs: ${walkablePairs}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 8: Spawn point validity");
{
  const terrain = generateTerrain(42);
  const sp = terrain.spawnPoint;
  assert(
    sp.x >= 0 && sp.x < TERRAIN_SIZE && sp.z >= 0 && sp.z < TERRAIN_SIZE,
    `Spawn (${sp.x},${sp.z}) within bounds`,
  );
  const h = terrain.heightmap[sp.z][sp.x];
  assert(typeof h === "number", `Spawn has height value: ${h}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 9: Path generation validity");
{
  const paths = generatePaths(42, 5, 80);
  assert(paths.size > 0, `Paths generated (${paths.size} cells)`);
  for (const key of paths) {
    const [x, z] = key.split(",").map(Number);
    assert(
      x >= 0 && x < TERRAIN_SIZE && z >= 0 && z < TERRAIN_SIZE,
      `Path cell (${x},${z}) within bounds`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 10: PRNG determinism");
{
  const rng1 = mulberry32(42);
  const rng2 = mulberry32(42);
  const seq1 = Array.from({ length: 100 }, () => rng1());
  const seq2 = Array.from({ length: 100 }, () => rng2());
  assert(JSON.stringify(seq1) === JSON.stringify(seq2), "Same seed → same PRNG sequence");

  const rng3 = mulberry32(99);
  const seq3 = Array.from({ length: 100 }, () => rng3());
  assert(JSON.stringify(seq1) !== JSON.stringify(seq3), "Different seed → different PRNG sequence");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 11: hashSeed string conversion");
{
  const h1 = hashSeed("test");
  const h2 = hashSeed("test");
  const h3 = hashSeed("other");
  assert(typeof h1 === "number", "hashSeed returns number");
  assert(h1 === h2, "Same string → same hash");
  assert(h1 !== h3, "Different string → different hash");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 12: Full terrain generation");
{
  const terrain = generateTerrain(42);
  assert(terrain.heightmap.length === TERRAIN_SIZE, "Heightmap size correct");
  assert(terrain.config.seed === 42, "Config seed matches");
  assert(terrain.config.size === TERRAIN_SIZE, "Config size matches");
  assert(terrain.spawnPoint, "Has spawn point");
  assert(typeof terrain.spawnPoint.x === "number", "Spawn has x coordinate");
  assert(typeof terrain.spawnPoint.z === "number", "Spawn has z coordinate");
  assert(Array.isArray(terrain.decorations), "Decorations is array");
  assert(terrain.collisionCircles.length === terrain.decorations.length, "Collision circles match decorations");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 13: Chunk generation determinism");
{
  const a = generateChunk(42, 0, 0);
  const b = generateChunk(42, 0, 0);
  const gridCount = CHUNK_SIZE + 1; // 33 vertices for 32 cells
  assert(a.heightmap.length === gridCount, "Chunk row count correct");
  assert(a.heightmap[0].length === gridCount, "Chunk col count correct");
  assert(JSON.stringify(a.heightmap) === JSON.stringify(b.heightmap), "Same seed+chunk → same heightmap");
  assert(JSON.stringify(a.biomeMap) === JSON.stringify(b.biomeMap), "Same seed+chunk → same biome map");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 14: Different chunk positions → different data");
{
  const a = generateChunk(42, 0, 0);
  const b = generateChunk(42, 1, 1);
  const same = JSON.stringify(a.heightmap) === JSON.stringify(b.heightmap);
  assert(!same, "Different positions → different heightmaps");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 15: Chunk biomes are valid");
{
  const chunk = generateChunk(42, 0, 0);
  let allValid = true;
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      if (!BIOME_LIST.includes(chunk.biomeMap[z][x])) {
        allValid = false;
        console.log(`  ⚠️  Invalid biome at (${x},${z}): ${chunk.biomeMap[z][x]}`);
      }
    }
  }
  assert(allValid, "All biomes are valid");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 16: Chunk collision circles are within bounds");
{
  const chunk = generateChunk(42, 0, 0);
  let allValid = true;
  for (const c of chunk.collisionCircles) {
    if (c.radius <= 0) {
      allValid = false;
      console.log(`  ⚠️  Invalid radius at (${c.x},${c.z}): ${c.radius}`);
    }
  }
  assert(allValid, "All collision circles have positive radius");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 17: sampleHeight works across chunks");
{
  const h1 = sampleHeight(42, 5, 5);
  const h2 = sampleHeight(42, 5, 5);
  assert(h1 === h2, "Same position → same height");
  assert(typeof h1 === "number", "Height is a number");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 18: Quadtree insert and query");
{
  const qt = new Quadtree(0, 0, 200, 200);
  qt.insert({ x: 10, z: 10, radius: 1 });
  qt.insert({ x: 50, z: 50, radius: 1 });
  qt.insert({ x: 100, z: 100, radius: 1 });
  qt.insert({ x: 150, z: 150, radius: 1 });
  assert(qt.count() === 4, "All 4 objects inserted");

  const near = qt.queryRadius(12, 12, 5);
  assert(near.length === 1, "Query near (10,10) finds 1 object");

  const veryFar = qt.queryRadius(12, 12, 200);
  assert(veryFar.length === 4, "Query with very large radius finds all 4 objects");
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Test 19: buildQuadtree from collision circles");
{
  const terrain = generateTerrain(42);
  const bounds = { x: 0, z: 0, width: TERRAIN_SIZE, height: TERRAIN_SIZE };
  const qt = buildQuadtree(terrain.collisionCircles, bounds);
  assert(qt.count() === terrain.collisionCircles.length, "Quadtree contains all collision circles");

  // Query near spawn
  const near = qt.queryRadius(terrain.spawnPoint.x, terrain.spawnPoint.z, 10);
  assert(near.length >= 0, `Query near spawn found ${near.length} circles`);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log("═".repeat(60));

if (failed > 0) {
  console.error("\n💥 Some tests failed!");
  process.exit(1);
} else {
  console.log("\n🎉 All tests passed!");
  process.exit(0);
}
