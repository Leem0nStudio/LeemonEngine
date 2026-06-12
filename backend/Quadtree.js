/**
 * Quadtree.js – Spatial partitioning for efficient collision queries.
 *
 * Stores objects with bounding circles. Queries return all objects
 * within a rectangular region or near a point.
 * Rebuilt when the map changes (generating initial or after modifications).
 */

const MAX_OBJECTS = 10;
const MAX_LEVELS = 6;

export class Quadtree {
  /**
   * @param {number} x - Top-left X of this node
   * @param {number} z - Top-left Z of this node
   * @param {number} width - Width of this node
   * @param {number} height - Height of this node
   * @param {number} [level=0] - Current depth
   */
  constructor(x, z, width, height, level = 0) {
    this.x = x;
    this.z = z;
    this.width = width;
    this.height = height;
    this.level = level;
    this.objects = [];
    this.nodes = []; // NW, NE, SW, SE
  }

  /**
   * Clear all objects and sub-nodes.
   */
  clear() {
    this.objects = [];
    for (const node of this.nodes) {
      if (node) node.clear();
    }
    this.nodes = [];
  }

  /**
   * Split into 4 sub-nodes.
   */
  split() {
    const hw = this.width / 2;
    const hh = this.height / 2;
    this.nodes = [
      new Quadtree(this.x, this.z, hw, hh, this.level + 1),               // NW
      new Quadtree(this.x + hw, this.z, hw, hh, this.level + 1),          // NE
      new Quadtree(this.x, this.z + hh, hw, hh, this.level + 1),          // SW
      new Quadtree(this.x + hw, this.z + hh, hw, hh, this.level + 1),     // SE
    ];
  }

  /**
   * Determine which sub-node an object belongs to.
   * Returns index (0-3) or -1 if it spans multiple nodes.
   */
  getIndex(obj) {
    const verticalMid = this.x + this.width / 2;
    const horizontalMid = this.z + this.height / 2;

    const fitsTop = obj.x - obj.radius >= this.x && obj.x + obj.radius < verticalMid;
    const fitsBottom = obj.x - obj.radius >= verticalMid && obj.x + obj.radius <= this.x + this.width;
    const fitsLeft = obj.z - obj.radius >= this.z && obj.z + obj.radius < horizontalMid;
    const fitsRight = obj.z - obj.radius >= horizontalMid && obj.z + obj.radius <= this.z + this.height;

    if (fitsTop && fitsLeft) return 0; // NW
    if (fitsTop && fitsRight) return 1; // NE
    if (fitsBottom && fitsLeft) return 2; // SW
    if (fitsBottom && fitsRight) return 3; // SE
    return -1; // Spans multiple nodes
  }

  /**
   * Insert an object into the quadtree.
   * @param {{ x: number, z: number, radius: number }} obj
   */
  insert(obj) {
    // Try to insert into sub-node
    if (this.nodes.length > 0) {
      const idx = this.getIndex(obj);
      if (idx >= 0) {
        this.nodes[idx].insert(obj);
        return;
      }
    }

    this.objects.push(obj);

    // Split if over capacity and not at max depth
    if (this.objects.length > MAX_OBJECTS && this.level < MAX_LEVELS && this.nodes.length === 0) {
      this.split();

      // Re-insert objects into sub-nodes
      let i = 0;
      while (i < this.objects.length) {
        const o = this.objects[i];
        const idx = this.getIndex(o);
        if (idx >= 0) {
          this.nodes[idx].insert(o);
          this.objects.splice(i, 1);
        } else {
          i++;
        }
      }
    }
  }

  /**
   * Retrieve all objects that could collide with the given area.
   * @param {{ x: number, z: number, width: number, height: number }} rect
   * @returns {object[]}
   */
  retrieve(rect) {
    const result = [];

    // Check if rect intersects this node
    if (
      rect.x > this.x + this.width ||
      rect.x + rect.width < this.x ||
      rect.z > this.z + this.height ||
      rect.z + rect.height < this.z
    ) {
      return result;
    }

    // Check objects in this node
    for (const obj of this.objects) {
      if (
        obj.x + obj.radius >= rect.x &&
        obj.x - obj.radius <= rect.x + rect.width &&
        obj.z + obj.radius >= rect.z &&
        obj.z - obj.radius <= rect.z + rect.height
      ) {
        result.push(obj);
      }
    }

    // Check sub-nodes
    for (const node of this.nodes) {
      if (node) {
        result.push(...node.retrieve(rect));
      }
    }

    return result;
  }

  /**
   * Find all objects near a point within a radius.
   * @param {number} px - Point X
   * @param {number} pz - Point Z
   * @param {number} radius - Search radius
   * @returns {object[]}
   */
  queryRadius(px, pz, radius) {
    return this.retrieve({
      x: px - radius,
      z: pz - radius,
      width: radius * 2,
      height: radius * 2,
    }).filter((obj) => {
      const dx = obj.x - px;
      const dz = obj.z - pz;
      return dx * dx + dz * dz <= (obj.radius + radius) * (obj.radius + radius);
    });
  }

  /**
   * Count total objects in the tree.
   */
  count() {
    let count = this.objects.length;
    for (const node of this.nodes) {
      if (node) count += node.count();
    }
    return count;
  }
}

/**
 * Build a quadtree from an array of collision circles.
 * @param {{ x: number, z: number, radius: number }[]} circles
 * @param {{ x: number, z: number, width: number, height: number }} bounds
 * @returns {Quadtree}
 */
export function buildQuadtree(circles, bounds) {
  const qt = new Quadtree(bounds.x, bounds.z, bounds.width, bounds.height);
  for (const c of circles) {
    qt.insert(c);
  }
  return qt;
}
