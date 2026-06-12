/**
 * TerrainBuilder – Client-side Three.js terrain construction.
 *
 * Receives the same map data the server generated (via the 'init' message)
 * and builds a matching visual scene so that collision checks stay in sync.
 *
 * Usage:
 *   const builder = new TerrainBuilder(scene, mapData, textureLoader);
 *   builder.build();
 *   // …later…
 *   builder.dispose();   // clean up GPU resources
 *
 * The builder stores a public `heightMap` array so callers can query the
 * terrain height at any grid cell (e.g. for character Y positioning).
 */

// ─── Noise utilities (duplicated here to keep the client bundle self-contained) ─

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise2D(x, y, rng) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);

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

function fbm(x, y, rng, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;
  for (let i = 0; i < octaves; i++) {
    const layerRng = mulberry32((rng() * 2147483647) | 0);
    value += amplitude * valueNoise2D(x * frequency, y * frequency, layerRng);
    maxValue += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return value / maxValue;
}

// ─── TerrainBuilder Class ────────────────────────────────────────────────────
export class TerrainBuilder {
  /**
   * @param {THREE.Scene} scene
   * @param {MapData}     mapData        – From generateMap() / server init
   * @param {THREE.TextureLoader} textureLoader
   */
  constructor(scene, mapData, textureLoader) {
    this.scene = scene;
    this.mapData = mapData;
    this.textureLoader = textureLoader;

    /** Public height map – callers use getHeight(gridX, gridZ) */
    this.heightMap = mapData.heightMap;
    this.obstacleMap = mapData.obstacleMap;
    this.portals = mapData.portals || [];
    this.config = mapData.config;

    /** Internal references for disposal */
    this._objects = [];
    this._portalMeshes = [];
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Build the entire terrain and add it to the scene. */
  build() {
    if (this.config.type === 'field') {
      this._buildField();
    } else if (this.config.type === 'dungeon') {
      this._buildDungeon();
    }
    this._buildPortals();
  }

  /** Remove all Three.js objects from the scene and dispose GPU resources. */
  dispose() {
    for (const obj of this._objects) {
      this.scene.remove(obj);
      obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
    }
    this._objects = [];
    this._portalMeshes = [];
  }

  /** Get the terrain height at a grid position (for character Y placement). */
  getHeight(gridX, gridZ) {
    const h = this.heightMap?.[gridZ]?.[gridX];
    return h !== undefined ? h : 0;
  }

  /** Check if a grid cell is an obstacle (returns the obstacle type or 0). */
  getObstacle(gridX, gridZ) {
    return this.obstacleMap?.[gridZ]?.[gridX] ?? 1; // Default to blocked
  }

  /** Get the world-space position for a grid cell. */
  gridToWorld(gridX, gridZ) {
    const cs = this.config.cellSize || 5;
    return {
      x: (gridX + 0.5) * cs,
      z: (gridZ + 0.5) * cs,
    };
  }

  // ── Field Terrain ───────────────────────────────────────────────────────

  _buildField() {
    const { width, height, cellSize } = this.config;

    // 1. Ground plane with vertex displacement ──────────────────────────────
    const segments = Math.max(width, height) * 2; // 2 verts per cell for smooth hills
    const totalW = width * cellSize;
    const totalH = height * cellSize;
    const geometry = new THREE.PlaneGeometry(totalW, totalH, segments, segments);

    // Displace vertices according to the height map
    const posAttr = geometry.getAttribute('position');
    for (let i = 0; i < posAttr.count; i++) {
      const vx = posAttr.getX(i);
      const vy = posAttr.getY(i); // This is Z after rotation

      // Convert world coord back to grid coord
      const gx = Math.floor((vx + totalW / 2) / cellSize);
      const gz = Math.floor((vy + totalH / 2) / cellSize);

      if (gx >= 0 && gx < width && gz >= 0 && gz < height) {
        posAttr.setZ(i, this.heightMap[gz][gx]);
      }
    }
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();

    // Green ground material
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x3a7d44,
      roughness: 0.9,
      metalness: 0.0,
      flatShading: true,
    });

    const ground = new THREE.Mesh(geometry, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(totalW / 2, 0, totalH / 2);
    this.scene.add(ground);
    this._objects.push(ground);

    // 2. Grid overlay ───────────────────────────────────────────────────────
    const gridHelper = new THREE.GridHelper(
      Math.max(totalW, totalH),
      Math.max(width, height),
      0x2d5a30,
      0x1a3d1e,
    );
    gridHelper.position.set(totalW / 2, 0.02, totalH / 2);
    this.scene.add(gridHelper);
    this._objects.push(gridHelper);

    // 3. Obstacles (trees + rocks) ──────────────────────────────────────────
    const treeTrunkGeo = new THREE.CylinderGeometry(0.2, 0.3, 1.5, 6);
    const treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3a1e, roughness: 0.9 });
    const treeLeafGeo = new THREE.ConeGeometry(1.0, 2.0, 6);
    const treeLeafMat = new THREE.MeshStandardMaterial({ color: 0x2d6b2e, roughness: 0.8 });

    const rockGeo = new THREE.DodecahedronGeometry(0.5, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x6b6b6b, roughness: 0.95 });

    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        const cell = this.obstacleMap[z]?.[x];
        if (cell === 0) continue;

        const wx = (x + 0.5) * cellSize;
        const wz = (z + 0.5) * cellSize;
        const h = this.heightMap[z][x];

        if (cell === 2) {
          // Tree: trunk + cone canopy
          const trunk = new THREE.Mesh(treeTrunkGeo, treeTrunkMat);
          trunk.position.set(wx, h + 0.75, wz);
          this.scene.add(trunk);
          this._objects.push(trunk);

          const canopy = new THREE.Mesh(treeLeafGeo, treeLeafMat);
          canopy.position.set(wx, h + 2.5, wz);
          this.scene.add(canopy);
          this._objects.push(canopy);
        } else if (cell === 3) {
          // Rock
          const rock = new THREE.Mesh(rockGeo, rockMat);
          rock.position.set(wx, h + 0.3, wz);
          rock.scale.set(0.8 + Math.random() * 0.4, 0.6 + Math.random() * 0.3, 0.8 + Math.random() * 0.4);
          this.scene.add(rock);
          this._objects.push(rock);
        } else {
          // Generic obstacle – stone block
          const block = new THREE.Mesh(
            new THREE.BoxGeometry(cellSize * 0.9, 1.2, cellSize * 0.9),
            new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.8 }),
          );
          block.position.set(wx, h + 0.6, wz);
          this.scene.add(block);
          this._objects.push(block);
        }
      }
    }

    // 4. Border walls ───────────────────────────────────────────────────────
    const wallGeo = new THREE.BoxGeometry(cellSize, 2, cellSize);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a3728, roughness: 0.85 });
    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        if (this.obstacleMap[z][x] === 1) {
          // Only render border walls (row/col 0 or max)
          const isBorder = x === 0 || x === width - 1 || z === 0 || z === height - 1;
          if (!isBorder) continue;

          const wx = (x + 0.5) * cellSize;
          const wz = (z + 0.5) * cellSize;
          const h = this.heightMap[z][x];
          const wall = new THREE.Mesh(wallGeo, wallMat);
          wall.position.set(wx, h + 1, wz);
          this.scene.add(wall);
          this._objects.push(wall);
        }
      }
    }
  }

  // ── Dungeon Terrain ─────────────────────────────────────────────────────

  _buildDungeon() {
    const { width, height, cellSize } = this.config;

    // 1. Floor quads for walkable cells ─────────────────────────────────────
    const floorGeo = new THREE.PlaneGeometry(cellSize * 0.98, cellSize * 0.98);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x4a4a5a,
      roughness: 0.95,
      metalness: 0.05,
    });

    // Merge all floor quads into one geometry for a single draw call
    const floorGroup = new THREE.Group();
    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        if (this.obstacleMap[z][x] !== 0) continue;
        const floor = new THREE.Mesh(floorGeo, floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set((x + 0.5) * cellSize, 0, (z + 0.5) * cellSize);
        floorGroup.add(floor);
      }
    }
    this.scene.add(floorGroup);
    this._objects.push(floorGroup);

    // 2. Wall blocks ────────────────────────────────────────────────────────
    const wallGeo = new THREE.BoxGeometry(cellSize * 0.98, cellSize * 0.8, cellSize * 0.98);
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x3a3a4a,
      roughness: 0.85,
      metalness: 0.1,
    });

    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        if (this.obstacleMap[z][x] !== 1) continue;

        // Only render walls adjacent to walkable cells (optimisation)
        let adjacent = false;
        for (let dz = -1; dz <= 1 && !adjacent; dz++) {
          for (let dx = -1; dx <= 1 && !adjacent; dx++) {
            const nz = z + dz;
            const nx = x + dx;
            if (nz >= 0 && nz < height && nx >= 0 && nx < width) {
              if (this.obstacleMap[nz][nx] === 0) adjacent = true;
            }
          }
        }
        if (!adjacent) continue;

        const wall = new THREE.Mesh(wallGeo, wallMat);
        wall.position.set((x + 0.5) * cellSize, cellSize * 0.4, (z + 0.5) * cellSize);
        this.scene.add(wall);
        this._objects.push(wall);
      }
    }

    // 3. Ceiling (dark) ─────────────────────────────────────────────────────
    const ceilGeo = new THREE.PlaneGeometry(width * cellSize, height * cellSize);
    const ceilMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a2e,
      roughness: 1.0,
      side: THREE.DoubleSide,
    });
    const ceiling = new THREE.Mesh(ceilGeo, ceilMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(
      (width * cellSize) / 2,
      cellSize * 0.8,
      (height * cellSize) / 2,
    );
    this.scene.add(ceiling);
    this._objects.push(ceiling);
  }

  // ── Portals ─────────────────────────────────────────────────────────────

  _buildPortals() {
    for (const portal of this.portals) {
      const { x, z } = portal;
      const cs = this.config.cellSize || 5;
      const wx = (x + 0.5) * cs;
      const wz = (z + 0.5) * cs;
      const h = this.heightMap?.[z]?.[x] ?? 0;

      // Glowing red circle on the ground
      const portalGeo = new THREE.CylinderGeometry(cs * 0.35, cs * 0.35, 0.15, 24);
      const portalMat = new THREE.MeshStandardMaterial({
        color: 0xff3333,
        emissive: 0xff1111,
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.85,
        roughness: 0.2,
        metalness: 0.5,
      });
      const portalMesh = new THREE.Mesh(portalGeo, portalMat);
      portalMesh.position.set(wx, h + 0.1, wz);
      this.scene.add(portalMesh);
      this._objects.push(portalMesh);
      this._portalMeshes.push(portalMesh);

      // Pulsing ring effect
      const ringGeo = new THREE.RingGeometry(cs * 0.38, cs * 0.45, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xff6600,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(wx, h + 0.12, wz);
      this.scene.add(ring);
      this._objects.push(ring);
      this._portalMeshes.push(ring);
    }
  }
}
