/**
 * mapModifications.js – API for designer overrides (height/biome/object changes).
 *
 * Stores modifications in Supabase or in-memory mock DB.
 * Each modification is tied to a seed and has a position (cx, cz).
 *
 * GET  /api/modifications?seed=42         → returns all mods for seed
 * POST /api/modifications                  → create a new modification
 * DELETE /api/modifications/:id            → delete a modification
 *
 * Modification shape:
 * {
 *   id: string,
 *   seed: number,
 *   cx: number, cz: number,
 *   type: "height" | "biome" | "object_place" | "object_remove",
 *   data: any,        // type-specific payload
 *   createdBy: string,
 *   createdAt: string
 * }
 */
import express from "express";

/**
 * Create the Express router for map modifications.
 * @param {import("@supabase/supabase-js").SupabaseClient | null} supabase
 * @param {boolean} useMockDb
 * @param {Map} mockDb
 * @returns {express.Router}
 */
export function createMapModificationsRouter(supabase, useMockDb, mockDb) {
  const router = express.Router();

  // ─── GET /api/modifications ────────────────────────────────────────────
  router.get("/", async (req, res) => {
    const seed = parseInt(String(req.query.seed), 10) || 42;

    if (useMockDb) {
      const mods = (mockDb.modifications || []).filter((m) => m.seed === seed);
      return res.json({ modifications: mods });
    }

    try {
      const { data, error } = await supabase
        .from("map_modifications")
        .select("*")
        .eq("seed", seed)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Error fetching modifications:", error);
        return res.status(500).json({ error: "Failed to fetch modifications" });
      }

      return res.json({ modifications: data });
    } catch (err) {
      console.error("Exception fetching modifications:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ─── POST /api/modifications ───────────────────────────────────────────
  router.post("/", async (req, res) => {
    const { seed, cx, cz, type, data: modData, createdBy } = req.body;

    if (seed == null || cx == null || cz == null || !type || !modData) {
      return res.status(400).json({ error: "Missing required fields: seed, cx, cz, type, data" });
    }

    const mod = {
      id: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      seed,
      cx,
      cz,
      type,
      data: modData,
      createdBy: createdBy || "designer",
      createdAt: new Date().toISOString(),
    };

    if (useMockDb) {
      if (!mockDb.modifications) mockDb.modifications = [];
      mockDb.modifications.push(mod);
      return res.status(201).json({ modification: mod });
    }

    try {
      const { data, error } = await supabase
        .from("map_modifications")
        .insert({
          id: mod.id,
          seed: mod.seed,
          cx: mod.cx,
          cz: mod.cz,
          type: mod.type,
          data: mod.data,
          created_by: mod.createdBy,
          created_at: mod.createdAt,
        })
        .select()
        .single();

      if (error) {
        console.error("Error creating modification:", error);
        return res.status(500).json({ error: "Failed to create modification" });
      }

      return res.status(201).json({ modification: data });
    } catch (err) {
      console.error("Exception creating modification:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ─── POST /api/modifications/batch ─────────────────────────────────────
  router.post("/batch", async (req, res) => {
    const { modifications } = req.body;

    if (!Array.isArray(modifications) || modifications.length === 0) {
      return res.status(400).json({ error: "Missing or empty modifications array" });
    }

    const now = new Date().toISOString();
    const mods = modifications.map((m, i) => ({
      id: m.id || `mod-${Date.now()}-${i}`,
      seed: m.seed,
      cx: m.cx,
      cz: m.cz,
      type: m.type,
      data: m.data,
      createdBy: m.createdBy || "designer",
      createdAt: now,
    }));

    if (useMockDb) {
      if (!mockDb.modifications) mockDb.modifications = [];
      mockDb.modifications.push(...mods);
      return res.status(201).json({ count: mods.length });
    }

    try {
      const rows = mods.map((m) => ({
        id: m.id,
        seed: m.seed,
        cx: m.cx,
        cz: m.cz,
        type: m.type,
        data: m.data,
        created_by: m.createdBy,
        created_at: m.createdAt,
      }));

      const { data, error } = await supabase
        .from("map_modifications")
        .insert(rows)
        .select();

      if (error) {
        console.error("Error batch creating modifications:", error);
        return res.status(500).json({ error: "Failed to batch create modifications" });
      }

      return res.status(201).json({ count: data.length });
    } catch (err) {
      console.error("Exception batch creating modifications:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ─── DELETE /api/modifications/:id ─────────────────────────────────────
  router.delete("/:id", async (req, res) => {
    const { id } = req.params;

    if (useMockDb) {
      if (!mockDb.modifications) mockDb.modifications = [];
      mockDb.modifications = mockDb.modifications.filter((m) => m.id !== id);
      return res.json({ deleted: id });
    }

    try {
      const { error } = await supabase
        .from("map_modifications")
        .delete()
        .eq("id", id);

      if (error) {
        console.error("Error deleting modification:", error);
        return res.status(500).json({ error: "Failed to delete modification" });
      }

      return res.json({ deleted: id });
    } catch (err) {
      console.error("Exception deleting modification:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  return router;
}

/**
 * Apply modifications to chunk data.
 * Call this after generating a chunk to overlay designer changes.
 *
 * @param {object} chunkData - Chunk from generateChunk()
 * @param {object[]} modifications - Modifications for this chunk
 * @returns {object} Modified chunk data (mutates in place)
 */
export function applyModifications(chunkData, modifications) {
  if (!modifications || modifications.length === 0) return chunkData;

  for (const mod of modifications) {
    switch (mod.type) {
      case "height":
        if (mod.data && mod.data.heights) {
          for (const { li, lj, h } of mod.data.heights) {
            if (li >= 0 && li < chunkData.heightmap.length && lj >= 0 && lj < chunkData.heightmap[0].length) {
              chunkData.heightmap[li][lj] = h;
            }
          }
        }
        break;

      case "biome":
        if (mod.data && mod.data.biomes) {
          for (const { li, lj, biome } of mod.data.biomes) {
            if (li >= 0 && li < chunkData.biomeMap.length && lj >= 0 && lj < chunkData.biomeMap[0].length) {
              chunkData.biomeMap[li][lj] = biome;
            }
          }
        }
        break;

      case "object_place":
        if (mod.data && mod.data.decoration) {
          chunkData.decorations.push(mod.data.decoration);
        }
        break;

      case "object_remove":
        if (mod.data && mod.data.x != null && mod.data.z != null) {
          chunkData.decorations = chunkData.decorations.filter(
            (d) => !(Math.abs(d.x - mod.data.x) < 0.5 && Math.abs(d.z - mod.data.z) < 0.5)
          );
        }
        break;
    }
  }

  return chunkData;
}
