-- SQL script for Supabase
create table characters (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid, -- Reference to auth.users (can be linked later once auth is implemented)
  name text not null,
  pos_x float not null default 0,
  pos_z float not null default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- RLS policies
alter table characters enable row level security;
create policy "Users can view their own characters" on characters for select using (auth.uid() = user_id);
create policy "Users can update their own characters" on characters for update using (auth.uid() = user_id);

-- Insert dummy data for demo: 
-- Replace '00000000-0000-0000-0000-000000000000' with your actual user ID from Supabase Auth.
insert into characters (user_id, name, pos_x, pos_z) 
values ('00000000-0000-0000-0000-000000000000', 'Novice Player', 0, 0);
