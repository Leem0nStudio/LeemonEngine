import express from "express";
import { WebSocketServer } from "ws";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateMap } from "./backend/mapGenerator.js";

dotenv.config();

const app = express();
const PORT = 3000;

// ─── Supabase Setup ─────────────────────────────────────────────────────────
let supabase: SupabaseClient | null = null;
let useMockDb = false;

const mockDb = {
  characters: new Map<string, { id: string; user_id: string; name: string; pos_x: number; pos_z: number }>()
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
// The obstacle/height data is generated once and reused for every player on
// that map, keeping CPU usage low even with many connections.
interface MapInstance {
  seed: number;
  type: string;
  data: ReturnType<typeof generateMap>;
}
const activeMaps = new Map<number, MapInstance>();

function getOrGenerateMap(seed: number, type: string): MapInstance {
  if (activeMaps.has(seed)) return activeMaps.get(seed)!;
  const data = generateMap(seed, type as "field" | "dungeon");
  const instance: MapInstance = { seed, type, data };
  activeMaps.set(seed, instance);
  console.log(`Generated map: seed=${seed} type=${type} ${data.config.width}x${data.config.height}`);
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
  mapType: string;
}
let players: Map<any, Player> = new Map();

// ─── Maximum slope the player can walk up (in height units per cell) ────────
const MAX_SLOPE = 1.5;

// ─── Start Server ───────────────────────────────────────────────────────────
async function startServer() {
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

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
              pos_x: 2,
              pos_z: 2
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

        // Determine starting map (use field by default)
        const startSeed = 42;
        const startType = "field";
        const mapInstance = getOrGenerateMap(startSeed, startType);
        const { obstacleMap, heightMap, spawnPoints } = mapInstance.data;
        const spawn = spawnPoints[0] || { x: 2, z: 2 };

        const player: Player = {
          id: charData.id,
          name: charData.name,
          x: charData.pos_x ?? spawn.x,
          z: charData.pos_z ?? spawn.z,
          socketId: ws,
          mapSeed: startSeed,
          mapType: startType,
        };
        players.set(ws, player);

        // Build serialisable player list (exclude socketId)
        const serializedPlayers = Array.from(players.values())
          .filter((p) => p.mapSeed === player.mapSeed) // Only players on the same map
          .map((p) => ({ id: p.id, name: p.name, x: p.x, z: p.z }));

        // Send init with map data so the client can build the terrain
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

        const { obstacleMap, heightMap, config } = mapInstance.data;
        const { width, height } = config;

        // 1. Bounds check
        if (x < 0 || x >= width || z < 0 || z >= height) return;

        // 2. Obstacle check (0 = walkable)
        if (obstacleMap[z]?.[x] !== 0) return;

        // 3. Slope check – prevent walking up impossibly steep terrain
        const currentH = heightMap[player.z]?.[player.x] ?? 0;
        const targetH = heightMap[z]?.[x] ?? 0;
        if (Math.abs(targetH - currentH) > MAX_SLOPE) return;

        // 4. Portal check – if the target cell has a portal, trigger map change
        const portal = mapInstance.data.portals.find(
          (p: any) => p.x === x && p.z === z,
        );
        if (portal) {
          const targetMap = getOrGenerateMap(portal.targetSeed, portal.targetMap);
          const targetSpawn = targetMap.data.spawnPoints[0] || { x: 2, z: 2 };

          player.mapSeed = portal.targetSeed;
          player.mapType = portal.targetMap;
          player.x = targetSpawn.x;
          player.z = targetSpawn.z;

          players.set(ws, player);

          // Send map_change to the player with the new map data
          ws.send(JSON.stringify({
            type: "map_change",
            player: { id: player.id, name: player.name, x: player.x, z: player.z },
            map: targetMap.data,
          }));

          // Re-send all players on the new map as moved messages
          const playersOnMap = Array.from(players.values())
            .filter((p) => p.mapSeed === player.mapSeed && p.id !== player.id);
          for (const p of playersOnMap) {
            ws.send(JSON.stringify({
              type: "moved", id: p.id, name: p.name, x: p.x, z: p.z,
            }));
          }

          // Persist position
          persistPosition(player);
          return;
        }

        // 5. Apply movement
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
