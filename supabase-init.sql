-- SQL script for Supabase with Auth integrations

-- Create characters table with reference to auth.users
create table if not exists characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  pos_x float not null default 5,
  pos_z float not null default 5,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row-Level Security
alter table characters enable row level security;

-- Drop existing policies if any to prevent conflicts
drop policy if exists "Users can view their own characters" on characters;
drop policy if exists "Users can insert their own characters" on characters;
drop policy if exists "Users can update their own characters" on characters;

-- Create policies for RLS
create policy "Users can view their own characters" 
  on characters for select 
  using (auth.uid() = user_id);

create policy "Users can insert their own characters" 
  on characters for insert 
  with check (auth.uid() = user_id);

create policy "Users can update their own characters" 
  on characters for update 
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─── Map Modifications (Designer Overrides) ──────────────────────────────────
-- Stores terrain edits, biome paints, and object placements made by designers.
-- These are applied on top of procedural generation per chunk.

create table if not exists map_modifications (
  id text primary key,
  seed integer not null,
  cx integer not null,
  cz integer not null,
  type text not null check (type in ('height', 'biome', 'object_place', 'object_remove')),
  data jsonb not null,
  created_by text not null default 'designer',
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Index for fast lookups by seed
create index if not exists idx_map_modifications_seed on map_modifications (seed);
-- Index for chunk-based queries
create index if not exists idx_map_modifications_chunk on map_modifications (seed, cx, cz);

-- Enable RLS (designers only)
alter table map_modifications enable row level security;

drop policy if exists "Designers can read modifications" on map_modifications;
drop policy if exists "Designers can write modifications" on map_modifications;

create policy "Designers can read modifications"
  on map_modifications for select
  using (true);

create policy "Designers can insert modifications"
  on map_modifications for insert
  with check (true);

create policy "Designers can delete modifications"
  on map_modifications for delete
  using (true);
