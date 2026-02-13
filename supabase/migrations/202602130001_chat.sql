create table if not exists public.chat_mutes (
  room text not null default 'pine-grove',
  name text not null,
  muted_until timestamptz not null,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (room, name)
);

create index if not exists chat_mutes_room_muted_until_idx
  on public.chat_mutes (room, muted_until);

alter table public.chat_mutes enable row level security;

grant select on table public.chat_mutes to anon, authenticated;

drop policy if exists "chat_mutes_select_all" on public.chat_mutes;
create policy "chat_mutes_select_all"
  on public.chat_mutes
  for select
  to anon, authenticated
  using (true);
