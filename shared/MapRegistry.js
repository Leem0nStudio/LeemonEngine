const MAP_NAMES = [
  'prontera', 'geffen', 'morroc', 'payon', 'aldebaran',
  'izlude', 'einbroch', 'comodo', 'umbala', 'rachel',
];

const MAP_PAIRS = [
  ['prontera', 'geffen'],
  ['geffen', 'morroc'],
  ['morroc', 'payon'],
  ['payon', 'aldebaran'],
  ['aldebaran', 'izlude'],
  ['izlude', 'einbroch'],
  ['einbroch', 'comodo'],
  ['comodo', 'umbala'],
  ['umbala', 'rachel'],
  ['rachel', 'prontera'],
];

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function hashSeed(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) & 0x7fffffff;
  }
  return h;
}

export function generateMaps() {
  const maps = {};
  const usedSeeds = new Set();

  MAP_NAMES.forEach((name) => {
    let seed = hashSeed(name);
    while (usedSeeds.has(seed)) seed = (seed + 1) & 0x7fffffff;
    usedSeeds.add(seed);

    maps[name] = {
      id: name,
      seed,
      name: capitalize(name),
      description: `The realm of ${capitalize(name)}`,
      spawnPoint: { x: 100, z: 100 },
      size: 200,
      portals: [],
      terrainTexture: null,
      prefabs: [],
      blockedDecorations: [],
    };
  });

  MAP_PAIRS.forEach(([a, b], idx) => {
    const zOffset = (idx - Math.floor(MAP_PAIRS.length / 2)) * 15;
    maps[a].portals.push({
      x: 197,
      z: 100 + zOffset,
      targetMap: b,
      targetX: 3,
      targetZ: 100 + zOffset,
    });
    maps[b].portals.push({
      x: 3,
      z: 100 + idx * 12 - 50,
      targetMap: a,
      targetX: 197,
      targetZ: 100 + idx * 12 - 50,
    });
  });

  return maps;
}

export const MAPS = generateMaps();

export function getMap(mapId) {
  return MAPS[mapId] || null;
}

export const DEFAULT_MAP = 'prontera';
