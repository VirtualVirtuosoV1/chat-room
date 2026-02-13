create table if not exists public.chat_name_claims (
  room text not null,
  client_id text not null,
  name text not null,
  last_seen timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (room, client_id),
  unique (room, name)
);

create index if not exists chat_name_claims_room_last_seen_idx
  on public.chat_name_claims (room, last_seen);

create index if not exists chat_name_claims_client_last_seen_idx
  on public.chat_name_claims (client_id, last_seen);

alter table public.chat_name_claims enable row level security;
