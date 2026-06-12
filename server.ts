import express from "express";
import { WebSocketServer } from "ws";
import { createServer as createViteServer } from "vite";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  generateTerrain,
  generateHeightmap,
  TERRAIN_SIZE,
  MAX_SLOPE_DEG,
} from "./backend/terrainGenerator.js";
import { Quadtree, buildQuadtree } from "./backend/Quadtree.js";
import { createMapModificationsRouter } from "./backend/routes/mapModifications.js";

dotenv.config();

const app = express();
const PORT = 3000;

// ─── Supabase Setup ─────────────────────────────────────────────────────────
let supabase: SupabaseClient | null = null;
let useMockDb = false;

const mockDb = {
  characters: new Map<string, { id: string; user_id: string; name: string; pos_x: number; pos_z: number }>(),
  modifications: [] as any[],
};

if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  try {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    console.log("Supabase client initialized successfully.");
  } catch (err) {
    console.warn("Failed to initialize Supabase. Falling back to mock database.", err);
    useMockDb = true;
  }
} else {
  console.warn("SUPABASE_URL or SUPABASE_KEY missing. Falling back to mock database.");
  useMockDb = true;
}

// ─── Active Maps ────────────────────────────────────────────────────────────
// Each map instance is keyed by its seed so that multiple maps can coexist.
// The terrain data is generated once and reused for every player on that map.
interface MapInstance {
  seed: number;
  data: ReturnType<typeof generateTerrain>;
  quadtree: Quadtree;
}
const activeMaps = new Map<number, MapInstance>();

function getOrGenerateMap(seed: number): MapInstance {
  if (activeMaps.has(seed)) return activeMaps.get(seed)!;
  const data = generateTerrain(seed);

  // Build quadtree for efficient collision queries
  const bounds = { x: 0, z: 0, width: data.config.size, height: data.config.size };
  const quadtree = buildQuadtree(data.collisionCircles, bounds);

  const instance: MapInstance = { seed, data, quadtree };
  activeMaps.set(seed, instance);
  console.log(`Generated terrain: seed=${seed} ${data.config.size}x${data.config.size} (${data.collisionCircles.length} collision objects in quadtree)`);
  return instance;
}

// ─── In-memory Player Sync ──────────────────────────────────────────────────
interface Player {
  id: string;
  name: string;
  x: number;
  z: number;
  socketId: any;
  mapSeed: number;
}
let players: Map<any, Player> = new Map();

// ─── Start Server ───────────────────────────────────────────────────────────
async function startServer() {
  app.use(express.json());
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

  // ── Map modifications routes (designer overrides) ──────────────────────
  app.use("/api/modifications", createMapModificationsRouter(supabase, useMockDb, mockDb));

  // ── Map hash endpoint ────────────────────────────────────────────────────
  // Returns an MD5 hash of the heightmap for deterministic verification.
  app.get("/api/map/hash", (req, res) => {
    const seed = parseInt(req.query.seed as string, 10) || 42;
    const terrain = generateTerrain(seed);
    const heightStr = terrain.heightmap.map((row: number[]) => row.join(",")).join(";");
    const hash = crypto.createHash("md5").update(heightStr).digest("hex");

    res.json({
      seed,
      hash,
      size: terrain.config.size,
      spawnPoint: terrain.spawnPoint,
      decorationCount: terrain.decorations.length,
    });
  });

  // Legacy validate endpoint (redirects to hash)
  app.get("/api/map/validate", (req, res) => {
    const seed = parseInt(req.query.seed as string, 10) || 42;
    const terrain = generateTerrain(seed);
    const heightStr = terrain.heightmap.map((row: number[]) => row.join(",")).join(";");
    const hash = crypto.createHash("md5").update(heightStr).digest("hex");

    res.json({
      seed,
      type: "field",
      hash,
      config: terrain.config,
      spawnPoints: [terrain.spawnPoint],
      gridSize: { w: terrain.config.size, h: terrain.config.size },
    });
  });

  if (process.env.NODE_ENV === "production") {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (_req, res) => res.sendFile(path.join(process.cwd(), "dist/index.html")));
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: any) => {
    ws.on("message", async (data: any) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch (e) {
        console.error("Failed to parse incoming WS message:", e);
        return;
      }

      // ── JOIN ─────────────────────────────────────────────────────────────
      if (message.type === "join") {
        const { token, characterId } = message;
        if (!token || !characterId) {
          ws.send(JSON.stringify({ type: "error", message: "Missing token or characterId" }));
          return;
        }
        let charData: any = null;

        if (useMockDb) {
          const userId = token || "mock-user-id";
          if (!mockDb.characters.has(characterId)) {
            mockDb.characters.set(characterId, {
              id: characterId,
              user_id: userId,
              name: characterId ? `Novice ${characterId.substring(0, 5)}` : "Novice Player",
              pos_x: 100,
              pos_z: 100
            });
          }
          const char = mockDb.characters.get(characterId);
          if (!char || char.user_id !== userId) {
            ws.send(JSON.stringify({ type: "error", message: "Unauthorized character selection" }));
            return;
          }
          charData = char;
        } else {
          try {
            const { data: { user }, error: authError } = await supabase.auth.getUser(token);
            if (authError || !user) {
              ws.send(JSON.stringify({ type: "error", message: "Authentication failed." }));
              return;
            }
            const { data: char, error: dbError } = await supabase
              .from("characters")
              .select("*")
              .eq("id", characterId)
              .eq("user_id", user.id)
              .single();
            if (dbError || !char) {
              ws.send(JSON.stringify({ type: "error", message: "Unauthorized character selection" }));
              return;
            }
            charData = char;
          } catch (err) {
            ws.send(JSON.stringify({ type: "error", message: "Server database validation exception" }));
            return;
          }
        }

        // Determine starting map
        const startSeed = 42;
        const mapInstance = getOrGenerateMap(startSeed);
        const { spawnPoint } = mapInstance.data;

        // New characters (pos_x=2, pos_z=2) start at spawn point
        // Returning characters use their saved position
        const isNewCharacter = (charData.pos_x === 2 && charData.pos_z === 2);
        const startX = isNewCharacter ? spawnPoint.x : (charData.pos_x ?? spawnPoint.x);
        const startZ = isNewCharacter ? spawnPoint.z : (charData.pos_z ?? spawnPoint.z);

        const player: Player = {
          id: charData.id,
          name: charData.name,
          x: startX,
          z: startZ,
          socketId: ws,
          mapSeed: startSeed,
        };
        players.set(ws, player);

        // Build serialisable player list (exclude socketId)
        const serializedPlayers = Array.from(players.values())
          .filter((p) => p.mapSeed === player.mapSeed)
          .map((p) => ({ id: p.id, name: p.name, x: p.x, z: p.z }));

        // Send init with terrain data so the client can build the world
        ws.send(JSON.stringify({
          type: "init",
          player: { id: player.id, name: player.name, x: player.x, z: player.z },
          players: serializedPlayers,
          map: mapInstance.data,
        }));

        // Broadcast spawn to other players on the same map
        wss.clients.forEach((c: any) => {
          if (c !== ws && c.readyState === 1) {
            c.send(JSON.stringify({
              type: "moved",
              id: player.id,
              name: player.name,
              x: player.x,
              z: player.z,
            }));
          }
        });
      }

      // ── MOVE ─────────────────────────────────────────────────────────────
      if (message.type === "move") {
        const { x, z } = message;
        const player = players.get(ws);
        if (!player) return;

        const mapInstance = activeMaps.get(player.mapSeed);
        if (!mapInstance) return;

        const { heightmap, config } = mapInstance.data;
        const size = config.size;

        // 1. Bounds check
        if (x < 0 || x >= size || z < 0 || z >= size) return;

        // 2. Slope check – prevent walking up impossibly steep terrain
        const currentH = heightmap[player.z]?.[player.x] ?? 0;
        const targetH = heightmap[z]?.[x] ?? 0;
        const heightDiff = Math.abs(targetH - currentH);
        const dx = Math.abs(x - player.x);
        const dz = Math.abs(z - player.z);
        const horizDist = (dx > 0 && dz > 0)
          ? config.cellSize * Math.SQRT2
          : config.cellSize;
        const slopeDeg = Math.atan2(heightDiff, horizDist) * (180 / Math.PI);
        if (slopeDeg > MAX_SLOPE_DEG) return;

        // 3. Decoration collision check via quadtree (O(log n) instead of O(n))
        const nearby = mapInstance.quadtree.queryRadius(x, z, 3);
        for (const circle of nearby) {
          const cdx = x - circle.x;
          const cdz = z - circle.z;
          const dist = Math.sqrt(cdx * cdx + cdz * cdz);
          if (dist < circle.radius) return;
        }

        // 4. Apply movement
        player.x = x;
        player.z = z;
        players.set(ws, player);

        // Broadcast to all clients on the same map
        wss.clients.forEach((c: any) => {
          if (c.readyState === 1) {
            const targetPlayer = players.get(c);
            if (targetPlayer && targetPlayer.mapSeed === player.mapSeed) {
              c.send(JSON.stringify({ type: "moved", id: player.id, x, z }));
            }
          }
        });

        persistPosition(player);
      }
    });

    ws.on("close", () => {
      const player = players.get(ws);
      if (player) {
        players.delete(ws);
        // Notify players on the same map
        wss.clients.forEach((c: any) => {
          if (c.readyState === 1) {
            const target = players.get(c);
            if (target && target.mapSeed === player.mapSeed) {
              c.send(JSON.stringify({ type: "left", id: player.id }));
            }
          }
        });
      }
    });
  });
}

function persistPosition(player: Player) {
  if (useMockDb) {
    const mockChar = mockDb.characters.get(player.id);
    if (mockChar) {
      mockChar.pos_x = player.x;
      mockChar.pos_z = player.z;
    }
  } else {
    supabase
      .from("characters")
      .update({ pos_x: player.x, pos_z: player.z })
      .eq("id", player.id)
      .then(({ error }: any) => {
        if (error) console.error(`Error saving position for ${player.id}:`, error);
      });
  }
}

startServer();
