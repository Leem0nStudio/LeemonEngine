import express from "express";
import { WebSocketServer } from "ws";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = 3000;

// Supabase Setup
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

// In-memory sync
let players: Map<string, any> = new Map();
const collisionMap = JSON.parse(fs.readFileSync("./backend/collisions/collisionMap.json", "utf-8"));

async function startServer() {
  // API routes
  app.get("/api/health", (req, res) => res.json({ status: "ok" }));

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => res.sendFile(path.join(process.cwd(), "dist/index.html")));
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: any) => {
    ws.on("message", async (data: any) => {
      const message = JSON.parse(data);

      if (message.type === "join") {
        const { userId, characterId } = message;
        const { data: charData } = await supabase.from("characters").select("*").eq("id", characterId).single();
        
        const player = { ...charData, socketId: ws };
        players.set(ws, player);
        
        ws.send(JSON.stringify({ type: "init", player, players: Array.from(players.values()) }));
      }
      
      if (message.type === "move") {
        const { x, z } = message;
        // Basic collision check
        if (!collisionMap[z]?.[x]) {
          const player = players.get(ws);
          if (player) {
            player.x = x;
            player.z = z;
            players.set(ws, player);
            wss.clients.forEach(c => c.send(JSON.stringify({ type: "moved", id: player.id, x, z })));
          }
        }
      }
    });

    ws.on("close", () => {
      players.delete(ws);
      wss.clients.forEach(c => c.send(JSON.stringify({ type: "left", ws })));
    });
  });
}

startServer();
