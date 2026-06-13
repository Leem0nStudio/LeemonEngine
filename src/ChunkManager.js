/**
 * ChunkManager.js – Client-side chunk streaming, LOD, and InstancedMesh.
 *
 * Loads/unloads chunks based on player position.
 * Uses InstancedMesh for efficient decoration rendering.
 * Offloads geometry generation to Web Worker when available.
 */
import * as THREE from "three";
import {
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  VIEW_RADIUS,
  LOD_LEVELS,
  BIOMES,
  generateChunk,
  generateUVs,
  mulberry32,
} from "../shared/TerrainChunk.js";
import { PREFABS } from "../shared/PrefabLibrary.js";

// ─── Web Worker Setup ─────────────────────────────────────────────────────
let chunkWorker = null;
let workerCallbacks = new Map();
let workerIdCounter = 0;

try {
  chunkWorker = new Worker(
    new URL("./workers/chunkWorker.js", import.meta.url),
    { type: "module" }
  );
  chunkWorker.onmessage = (e) => {
    const { id, type } = e.data;
    const cb = workerCallbacks.get(id);
    if (cb) {
      workerCallbacks.delete(id);
      if (type === "result") cb.resolve(e.data);
      else cb.reject(new Error(e.data.error));
    }
  };
  chunkWorker.onerror = (err) => {
    console.warn("[ChunkManager] Worker error, falling back to main thread:", err);
    chunkWorker = null;
  };
} catch (e) {
  console.warn("[ChunkManager] Web Workers not available, using main thread");
}

function generateChunkAsync(seed, cx, cz) {
  return new Promise((resolve, reject) => {
    if (chunkWorker) {
      const id = workerIdCounter++;
      workerCallbacks.set(id, { resolve, reject });
      chunkWorker.postMessage({ type: "generate", seed, cx, cz, id });
    } else {
      // Fallback: generate on main thread
      try {
        const data = generateChunk(seed, cx, cz);
        resolve({
          cx, cz,
          positions: null, // Will be built by _buildTerrainMesh
          colors: null,
          indices: null,
        });
      } catch (err) {
        reject(err);
      }
    }
  });
}

// ─── Color Palettes per Biome ───────────────────────────────────────────────
let _colors = null;
function getBiomeColors() {
  if (!_colors) {
    _colors = {
      prairie: {
        grass: new THREE.Color(0x5daa35),
        dirt: new THREE.Color(0x8c6e42),
        stone: new THREE.Color(0x9e9e9e),
      },
      forest: {
        grass: new THREE.Color(0x2e7d32),
        dirt: new THREE.Color(0x6d4c2a),
        stone: new THREE.Color(0x808080),
      },
      desert: {
        grass: new THREE.Color(0xd4c573),
        dirt: new THREE.Color(0xc4a84a),
        stone: new THREE.Color(0xb0a080),
      },
      snow: {
        grass: new THREE.Color(0xe8edf2),
        dirt: new THREE.Color(0xb0b5ba),
        stone: new THREE.Color(0x90959a),
      },
      swamp: {
        grass: new THREE.Color(0x4a7035),
        dirt: new THREE.Color(0x665c33),
        stone: new THREE.Color(0x707560),
      },
    };
  }
  return _colors;
}

// ─── Decoration Templates ───────────────────────────────────────────────────
const TREE_CONFIGS = {
  oak: { trunkH: 2, trunkR: 0.2, canopyR: 1.2, canopyH: 1.5, trunkColor: 0x6d4c2a, canopyColor: 0x2e7d32 },
  birch: { trunkH: 2.5, trunkR: 0.12, canopyR: 0.8, canopyH: 1.8, trunkColor: 0xd4c8b0, canopyColor: 0x4caf50 },
  pine: { trunkH: 3, trunkR: 0.15, canopyR: 0.9, canopyH: 2.2, trunkColor: 0x5d4037, canopyColor: 0x1b5e20 },
  pine_snow: { trunkH: 3, trunkR: 0.15, canopyR: 0.9, canopyH: 2.2, trunkColor: 0x5d4037, canopyColor: 0xcfd8dc },
  cactus: { trunkH: 2, trunkR: 0.3, canopyR: 0, canopyH: 0, trunkColor: 0x558b2f, canopyColor: 0 },
  dead_tree: { trunkH: 2.5, trunkR: 0.18, canopyR: 0, canopyH: 0, trunkColor: 0x795548, canopyColor: 0 },
  willow: { trunkH: 2.2, trunkR: 0.2, canopyR: 1.5, canopyH: 1.2, trunkColor: 0x5d4037, canopyColor: 0x689f38 },
};

const ROCK_COLORS = [0x78909c, 0x607d8b, 0x90a4ae, 0x546e7a];

export class ChunkManager {
  /**
   * @param {THREE.Scene} scene
   * @param {number} seed - Global world seed
   */
  constructor(scene, seed, mapConfig = null) {
    this.scene = scene;
    this.seed = seed;
    this.mapConfig = mapConfig;
    this.chunks = new Map();
    this.lastPlayerChunk = { cx: -999, cz: -999 };
    this._prefabGroups = [];

    // Resource cache to prevent redundant GPU uploads and GC pressure
    this._materials = new Map();
    this._geometries = new Map();

    // Shared geometries for instancing
    this._rockGeo = this._getSharedGeometry('rock_base', () => new THREE.DodecahedronGeometry(0.5, 0));
    this._bushGeo = this._getSharedGeometry('bush_base', () => new THREE.SphereGeometry(0.4, 5, 4));
    this._flowerGeo = this._getSharedGeometry('flower_base', () => new THREE.ConeGeometry(0.1, 0.3, 4));
  }

  /**
   * Build prefabs from map config.
   */
  buildPrefabs() {
    const cfg = this.mapConfig;
    if (!cfg || !cfg.prefabs || cfg.prefabs.length === 0) return;
    for (const pf of cfg.prefabs) {
      const h = this.getHeight(pf.x, pf.z);
      const group = this._buildSinglePrefab(pf, h);
      if (group) {
        this.scene.add(group);
        this._prefabGroups.push(group);
      }
    }
  }

  _buildSinglePrefab(pf, h) {
    const def = PREFABS[pf.model];
    if (!def) return null;
    if (def.build) {
      try {
        return def.build(this.scene, { x: pf.x, z: pf.z, h, scale: pf.scale || 1 });
      } catch (e) {
        console.warn(`[ChunkManager] Failed to build prefab ${pf.model}:`, e);
        return null;
      }
    }
    return null;
  }

  /**
   * Helper to get or create a shared material.
   */
  _getSharedMaterial(key, createFn) {
    if (!this._materials.has(key)) {
      this._materials.set(key, createFn());
    }
    return this._materials.get(key);
  }

  /**
   * Helper to get or create a shared geometry.
   */
  _getSharedGeometry(key, createFn) {
    if (!this._geometries.has(key)) {
      this._geometries.set(key, createFn());
    }
    return this._geometries.get(key);
  }

  /**
   * Call when player moves. Loads/unloads chunks as needed.
   * @param {number} playerX - World X
   * @param {number} playerZ - World Z
   */
  update(playerX, playerZ) {
    const pcx = Math.floor(playerX / CHUNK_SIZE);
    const pcz = Math.floor(playerZ / CHUNK_SIZE);

    if (pcx === this.lastPlayerChunk.cx && pcz === this.lastPlayerChunk.cz) return;
    this.lastPlayerChunk = { cx: pcx, cz: pcz };

    // Determine which chunks should be loaded
    const needed = new Set();
    for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
      for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
        needed.add(`${pcx + dx},${pcz + dz}`);
      }
    }

    // Unload chunks no longer needed
    for (const [key, chunk] of this.chunks) {
      if (!needed.has(key)) {
        this._unloadChunk(chunk);
        this.chunks.delete(key);
      }
    }

    // Load new chunks (using requestIdleCallback for non-blocking)
    for (const key of needed) {
      if (!this.chunks.has(key)) {
        const [cx, cz] = key.split(",").map(Number);
        this._loadChunkAsync(cx, cz);
      }
    }
  }

  /**
   * Load a chunk asynchronously using Web Worker or requestIdleCallback.
   */
  _loadChunkAsync(cx, cz) {
    const key = `${cx},${cz}`;
    if (this.chunks.has(key)) return;

    // Reserve the slot immediately to prevent double-loading
    this.chunks.set(key, { data: null, meshes: [], loading: true });

    const buildFromData = (data) => {
      const chunkEntry = this._buildChunkMeshes(data);
      this.chunks.set(key, chunkEntry);
    };

    const loadFn = async () => {
      try {
        const blocked = this.mapConfig?.blockedDecorations || null;
        const workerResult = await generateChunkAsync(this.seed, cx, cz);

        if (workerResult.positions) {
          const data = generateChunk(this.seed, cx, cz, null, blocked);
          const chunkEntry = this._buildChunkMeshesFromWorker(data, workerResult);
          this.chunks.set(key, chunkEntry);
        } else {
          const data = generateChunk(this.seed, cx, cz, null, blocked);
          buildFromData(data);
        }
      } catch (err) {
        console.error(`[ChunkManager] Failed to load chunk (${cx},${cz}):`, err);
        this.chunks.delete(key);
      }
    };

    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(loadFn, { timeout: 150 });
    } else {
      setTimeout(loadFn, 0);
    }
  }

  /**
   * Build Three.js meshes for a chunk.
   */
  _buildChunkMeshes(data) {
    const meshes = [];
    const worldOffsetX = data.cx * CHUNK_SIZE;
    const worldOffsetZ = data.cz * CHUNK_SIZE;

    // 1. Terrain mesh (with vertex colors)
    const terrainMesh = this._buildTerrainMesh(data);
    meshes.push(terrainMesh);

    // 2. Decoration instances
    const decMeshes = this._buildDecorationMeshes(data);
    meshes.push(...decMeshes);

    // Add all to scene
    for (const m of meshes) this.scene.add(m);

    return { data, meshes };
  }

  /**
   * Build meshes using pre-computed worker geometry data.
   */
  _buildChunkMeshesFromWorker(data, workerData) {
    const meshes = [];
    const atlasMat = this._getOrCreateTerrainAtlas();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(workerData.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(workerData.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(workerData.indices, 1));
    geometry.computeVertexNormals();

    if (atlasMat) {
      const heightMapping = this.mapConfig?.terrainTexture?.heightMapping || null;
      if (heightMapping) {
        const uvs = generateUVs(data.heightmap, data.biomeMap, heightMapping);
        if (uvs) {
          geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
          geometry.deleteAttribute("color");
        }
      }
    }

    const material = atlasMat || this._getSharedMaterial('terrain_mat', () => new THREE.MeshLambertMaterial({
      vertexColors: !atlasMat,
      side: THREE.FrontSide,
    }));

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.userData.isTerrain = true;
    mesh.userData.chunkCx = data.cx;
    mesh.userData.chunkCz = data.cz;
    meshes.push(mesh);

    // 2. Decoration instances
    const decMeshes = this._buildDecorationMeshes(data);
    meshes.push(...decMeshes);

    // Add all to scene
    for (const m of meshes) this.scene.add(m);

    return { data, meshes };
  }

  _getOrCreateTerrainAtlas() {
    const cfg = this.mapConfig;
    if (!cfg || !cfg.terrainTexture) return null;
    const key = `atlas_${this.seed}`;
    if (this._materials.has(key)) return this._materials.get(key);

    const tiles = cfg.terrainTexture.tiles || ['#5daa35','#8c6e42','#9e9e9e','#42a5f5','#e8edf2'];
    const tileSize = 64;
    const cols = 4;
    const rows = Math.ceil(tiles.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = cols * tileSize;
    canvas.height = rows * tileSize;
    const ctx = canvas.getContext('2d');

    tiles.forEach((color, i) => {
      const tx = (i % cols) * tileSize;
      const ty = Math.floor(i / cols) * tileSize;
      ctx.fillStyle = color;
      ctx.fillRect(tx, ty, tileSize, tileSize);
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tx, ty, tileSize, tileSize);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;

    const mat = new THREE.MeshLambertMaterial({
      map: texture,
      side: THREE.FrontSide,
    });
    this._materials.set(key, mat);
    return mat;
  }

  _buildTerrainMesh(data) {
    const { heightmap, biomeMap } = data;
    const gridCount = CHUNK_SIZE + 1;
    const useTexture = this.mapConfig?.terrainTexture !== null && this.mapConfig?.terrainTexture !== undefined;
    const atlasMat = useTexture ? this._getOrCreateTerrainAtlas() : null;
    const heightMapping = useTexture ? this.mapConfig.terrainTexture.heightMapping : null;

    const geometry = new THREE.BufferGeometry();
    const vertexCount = gridCount * gridCount;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const tmpColor = new THREE.Color();

    let uvs = null;
    if (useTexture && atlasMat && heightMapping) {
      uvs = generateUVs(heightmap, biomeMap, heightMapping);
    }

    for (let lz = 0; lz < gridCount; lz++) {
      for (let lx = 0; lx < gridCount; lx++) {
        const i = lz * gridCount + lx;
        const h = heightmap[lz][lx];
        const biome = biomeMap[lz][lx];
        const biomeColors = getBiomeColors();
        const palette = biomeColors[biome] || biomeColors.prairie;

        positions[i * 3] = data.worldOffsetX + lx;
        positions[i * 3 + 1] = h;
        positions[i * 3 + 2] = data.worldOffsetZ + lz;

        let slope = 0;
        if (lz > 0 && lz < gridCount - 1 && lx > 0 && lx < gridCount - 1) {
          const sx = Math.abs(heightmap[lz][lx + 1] - heightmap[lz][lx - 1]) / 2;
          const sz = Math.abs(heightmap[lz + 1][lx] - heightmap[lz - 1][lx]) / 2;
          slope = Math.sqrt(sx * sx + sz * sz);
        }

        if (slope > 1.5) {
          tmpColor.copy(palette.stone);
        } else if (slope > 0.8) {
          tmpColor.copy(palette.dirt);
        } else {
          tmpColor.copy(palette.grass);
          const v = Math.sin((data.worldOffsetX + lx) * 0.2) * Math.cos((data.worldOffsetZ + lz) * 0.2) * 0.08;
          tmpColor.r += v;
          tmpColor.g += v;
        }

        colors[i * 3] = tmpColor.r;
        colors[i * 3 + 1] = tmpColor.g;
        colors[i * 3 + 2] = tmpColor.b;
      }
    }

    const indices = [];
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const tl = lz * gridCount + lx;
        const tr = tl + 1;
        const bl = (lz + 1) * gridCount + lx;
        const br = bl + 1;
        indices.push(tl, bl, tr, tr, bl, br);
      }
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    if (uvs) {
      geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    } else {
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    }

    const material = atlasMat || this._getSharedMaterial('terrain_mat', () => new THREE.MeshLambertMaterial({
      vertexColors: !uvs,
      side: THREE.FrontSide,
    }));

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.userData.isTerrain = true;
    mesh.userData.chunkCx = data.cx;
    mesh.userData.chunkCz = data.cz;
    return mesh;
  }

  /**
   * Build InstancedMesh decorations for a chunk.
   */
  _buildDecorationMeshes(data) {
    const result = [];

    // Group decorations by type
    const groups = {};
    for (const dec of data.decorations) {
      const key = `${dec.type}_${dec.subType || ""}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(dec);
    }

    for (const [key, decs] of Object.entries(groups)) {
      if (decs.length === 0) continue;
      const first = decs[0];

      if (first.type === "tree") {
        const cfg = TREE_CONFIGS[first.subType] || TREE_CONFIGS.oak;

        // Trunk instances
        const trunkGeo = this._getSharedGeometry(`tree_trunk_${first.subType}`, () =>
          new THREE.CylinderGeometry(cfg.trunkR * 0.7, cfg.trunkR, cfg.trunkH, 6));
        const trunkMat = this._getSharedMaterial(`tree_trunk_mat_${cfg.trunkColor}`, () =>
          new THREE.MeshLambertMaterial({ color: cfg.trunkColor }));
        const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, decs.length);
        trunkMesh.castShadow = true;

        const dummy = new THREE.Object3D();
        for (let i = 0; i < decs.length; i++) {
          const d = decs[i];
          dummy.position.set(d.x, d.h + cfg.trunkH / 2, d.z);
          dummy.rotation.y = d.ry;
          dummy.updateMatrix();
          trunkMesh.setMatrixAt(i, dummy.matrix);
        }
        trunkMesh.instanceMatrix.needsUpdate = true;
        result.push(trunkMesh);

        // Canopy instances (if tree has canopy)
        if (cfg.canopyR > 0) {
          const canopyGeo = this._getSharedGeometry(`tree_canopy_${first.subType}`, () =>
            new THREE.SphereGeometry(cfg.canopyR, 6, 5));
          const canopyMat = this._getSharedMaterial(`tree_canopy_mat_${cfg.canopyColor}`, () =>
            new THREE.MeshLambertMaterial({ color: cfg.canopyColor }));
          const canopyMesh = new THREE.InstancedMesh(canopyGeo, canopyMat, decs.length);
          canopyMesh.castShadow = true;

          for (let i = 0; i < decs.length; i++) {
            const d = decs[i];
            dummy.position.set(d.x, d.h + cfg.trunkH + cfg.canopyH * 0.4, d.z);
            dummy.scale.set(1, cfg.canopyH / cfg.canopyR / 2, 1);
            dummy.rotation.set(0, d.ry, 0);
            dummy.updateMatrix();
            canopyMesh.setMatrixAt(i, dummy.matrix);
          }
          canopyMesh.instanceMatrix.needsUpdate = true;
          result.push(canopyMesh);
        }
      } else if (first.type === "rock") {
        const mat = this._getSharedMaterial(`rock_mat_${ROCK_COLORS[0]}`, () =>
          new THREE.MeshLambertMaterial({ color: ROCK_COLORS[0] }));
        const mesh = new THREE.InstancedMesh(this._rockGeo, mat, decs.length);
        mesh.castShadow = true;

        const dummy = new THREE.Object3D();
        for (let i = 0; i < decs.length; i++) {
          const d = decs[i];
          const s = 0.7 + (d.ry / (Math.PI * 2)) * 0.6;
          dummy.position.set(d.x, d.h + s * 0.3, d.z);
          dummy.scale.set(s, s * 0.7, s);
          dummy.rotation.set(0, d.ry, 0);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        result.push(mesh);
      } else if (first.type === "bush") {
        const mat = this._getSharedMaterial('bush_mat', () =>
          new THREE.MeshLambertMaterial({ color: 0x388e3c }));
        const mesh = new THREE.InstancedMesh(this._bushGeo, mat, decs.length);
        mesh.castShadow = true;

        const dummy = new THREE.Object3D();
        for (let i = 0; i < decs.length; i++) {
          const d = decs[i];
          dummy.position.set(d.x, d.h + 0.3, d.z);
          dummy.scale.set(1, 0.7, 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        result.push(mesh);
      } else if (first.type === "flower") {
        const colors = [0xff69b4, 0xffeb3b, 0xe91e63, 0x9c27b0, 0xff5722];
        const mat = this._getSharedMaterial(`flower_mat_${colors[0]}`, () =>
          new THREE.MeshBasicMaterial({ color: colors[0] }));
        const mesh = new THREE.InstancedMesh(this._flowerGeo, mat, decs.length);

        const dummy = new THREE.Object3D();
        for (let i = 0; i < decs.length; i++) {
          const d = decs[i];
          dummy.position.set(d.x, d.h + 0.15, d.z);
          dummy.rotation.set(0, d.ry, 0);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        result.push(mesh);
      }
    }

    return result;
  }

  /**
   * Unload a chunk and dispose its GPU resources.
   * Only disposes of unique resources (like terrain geometry).
   * Shared materials and decoration geometries are kept in the cache.
   */
  _unloadChunk(chunk) {
    if (!chunk || !chunk.meshes) return;
    for (const mesh of chunk.meshes) {
      this.scene.remove(mesh);

      // Only dispose of unique geometry (terrain mesh geometry is unique per chunk)
      if (mesh.userData.isTerrain && mesh.geometry) {
        mesh.geometry.dispose();
      }

      // Shared materials and geometries (used by InstancedMesh decorations)
      // are NOT disposed here because they are managed by the resource cache
      // and will be reused by other chunks.
    }
  }

  /**
   * Dispose all chunks and worker.
   */
  dispose() {
    for (const [, chunk] of this.chunks) {
      this._unloadChunk(chunk);
    }
    this.chunks.clear();

    // Remove prefabs
    for (const g of this._prefabGroups) {
      this.scene.remove(g);
    }
    this._prefabGroups = [];

    // Dispose cached materials
    for (const mat of this._materials.values()) {
      mat.dispose();
    }
    this._materials.clear();

    // Dispose cached geometries
    for (const geo of this._geometries.values()) {
      geo.dispose();
    }
    this._geometries.clear();

    // Terminate worker
    if (chunkWorker) {
      chunkWorker.terminate();
      chunkWorker = null;
    }
    workerCallbacks.clear();
  }

  /**
   * Get the heightmap at a world position (from loaded chunk).
   */
  getHeight(wx, wz) {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    const chunk = this.chunks.get(key);
    if (!chunk || !chunk.data) return 0;

    const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((wz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return chunk.data.heightmap[Math.floor(lz)]?.[Math.floor(lx)] ?? 0;
  }

  /**
   * Get collision circles for loaded chunks near a position.
   */
  getCollisionCircles(wx, wz, radius) {
    const circles = [];
    const minCx = Math.floor((wx - radius) / CHUNK_SIZE);
    const maxCx = Math.floor((wx + radius) / CHUNK_SIZE);
    const minCz = Math.floor((wz - radius) / CHUNK_SIZE);
    const maxCz = Math.floor((wz + radius) / CHUNK_SIZE);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const chunk = this.chunks.get(`${cx},${cz}`);
        if (chunk?.data) {
          circles.push(...chunk.data.collisionCircles);
        }
      }
    }
    return circles;
  }

  /**
   * Get loaded chunk count.
   */
  get loadedChunkCount() {
    return this.chunks.size;
  }
}
