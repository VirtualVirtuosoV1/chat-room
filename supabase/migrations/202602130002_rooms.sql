create table if not exists public.chat_room_members (
  client_id text primary key,
  room text not null,
  last_seen timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists chat_room_members_room_last_seen_idx
  on public.chat_room_members (room, last_seen);

alter table public.chat_room_members enable row level security;
