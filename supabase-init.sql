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
