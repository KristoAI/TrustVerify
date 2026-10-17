alter table public.tv_sessions add column launch_cipher text;
create unique index on public.tv_sessions(cap_hash);
