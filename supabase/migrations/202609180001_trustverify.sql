-- Visitor evidence never contains images, OCR, dates of birth, or exact ages.
create table public.tv_accounts (
  id uuid primary key default gen_random_uuid(), email text not null unique,
  name text not null, password_hash text not null, recovery_hash text not null,
  created_at timestamptz not null default now()
);
create table public.tv_sites (
  id uuid primary key default gen_random_uuid(), account_id uuid references public.tv_accounts(id) on delete cascade,
  name text not null, origin text not null, return_url text not null,
  environment text not null check (environment in ('test','live')),
  policy jsonb not null, branding jsonb not null default '{}',
  webhook_url text, webhook_secret text, enabled boolean not null default true,
  is_demo boolean not null default false, created_at timestamptz not null default now()
);
create index on public.tv_sites(account_id);
create table public.tv_api_keys (
  id uuid primary key default gen_random_uuid(), site_id uuid not null references public.tv_sites(id) on delete cascade,
  name text not null, prefix text not null, key_hash text not null unique,
  revoked_at timestamptz, created_at timestamptz not null default now()
);
create table public.tv_visitors (
  id uuid primary key default gen_random_uuid(), recovery_hash text not null,
  created_at timestamptz not null default now()
);
create table public.tv_passkeys (
  id text primary key, visitor_id uuid not null references public.tv_visitors(id) on delete cascade,
  public_key text not null, counter bigint not null default 0,
  transports text[] not null default '{}', name text not null default 'My passkey',
  device_type text not null, backed_up boolean not null,
  created_at timestamptz not null default now(), last_used_at timestamptz
);
create index on public.tv_passkeys(visitor_id);
create table public.tv_proofs (
  id uuid primary key default gen_random_uuid(), visitor_id uuid references public.tv_visitors(id) on delete set null,
  token_hash text not null unique, min_age integer not null check(min_age between 18 and 99),
  environment text not null check(environment in ('test','live')),
  method text not null check(method in ('selfie','document')),
  assurance text not null default 'browser_asserted' check(assurance='browser_asserted'),
  verified_at timestamptz not null default now(), expires_at timestamptz not null,
  revoked_at timestamptz, created_at timestamptz not null default now()
);
create index on public.tv_proofs(visitor_id);
create table public.tv_sessions (
  id uuid primary key default gen_random_uuid(), site_id uuid not null references public.tv_sites(id) on delete cascade,
  status text not null default 'created' check(status in ('created','in_progress','completed','expired','cancelled')),
  outcome text check(outcome in ('passed','not_passed','inconclusive')),
  environment text not null check(environment in ('test','live')),
  min_age integer not null check(min_age between 18 and 99), policy jsonb not null,
  cap_hash text not null, state_nonce text not null, return_url text not null,
  idempotency_key text, request_hash text,
  country text, region text, ip_hash text,
  method text, assurance text not null default 'browser_asserted', source text,
  proof_id uuid references public.tv_proofs(id),
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  completed_at timestamptz, verified_at timestamptz, valid_until timestamptz,
  unique(site_id,idempotency_key)
);
create index on public.tv_sessions(site_id,created_at desc);
create index on public.tv_sessions(proof_id);
create table public.tv_tokens (
  hash text primary key, kind text not null, owner_id uuid, data jsonb not null default '{}',
  expires_at timestamptz not null, created_at timestamptz not null default now()
);
create index on public.tv_tokens(expires_at);
create table public.tv_webhooks (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.tv_sessions(id) on delete cascade,
  site_id uuid not null references public.tv_sites(id) on delete cascade,
  event_type text not null, payload jsonb not null,
  status text not null default 'pending' check(status in ('pending','processing','delivered','failed')),
  attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
  lease_until timestamptz, delivered_at timestamptz, http_status integer, error_code text,
  created_at timestamptz not null default now(), unique(session_id,event_type)
);
create index on public.tv_webhooks(status,next_attempt_at);
create table public.tv_audit (
  id uuid primary key default gen_random_uuid(), account_id uuid references public.tv_accounts(id) on delete cascade,
  action text not null, resource_id text, created_at timestamptz not null default now()
);

-- No browser, anonymous, or dashboard JWT can bypass the Node API's tenant checks.
do $$ declare t text; begin
  foreach t in array array['tv_accounts','tv_sites','tv_api_keys','tv_visitors','tv_passkeys','tv_proofs','tv_sessions','tv_tokens','tv_webhooks','tv_audit'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;

create function public.tv_consume_token(p_hash text, p_kind text) returns jsonb
language plpgsql set search_path=public as $$
declare r public.tv_tokens; begin
  delete from public.tv_tokens where hash=p_hash and kind=p_kind and expires_at>now() returning * into r;
  return case when r.hash is null then null else to_jsonb(r) end;
end $$;

-- Completion, reusable proof, and delivery event are one atomic transaction.
create function public.tv_finish_session(p_id uuid,p_cap_hash text,p_outcome text,p_method text,p_proof_id uuid default null,p_proof_token_hash text default null)
returns jsonb language plpgsql set search_path=public as $$
declare s public.tv_sessions; site public.tv_sites; proof public.tv_proofs; until_time timestamptz; result jsonb;
begin
  select * into s from public.tv_sessions where id=p_id for update;
  if s.id is null or s.cap_hash<>p_cap_hash then raise exception 'Invalid session capability'; end if;
  if s.status not in ('created','in_progress') or s.expires_at<=now() then raise exception 'Session is not active'; end if;
  if p_outcome not in ('passed','not_passed','inconclusive') or p_method not in ('selfie','document') then raise exception 'Invalid outcome'; end if;
  select * into site from public.tv_sites where id=s.site_id;
  if not site.enabled then raise exception 'Site disabled'; end if;
  if not (s.policy->'methods' ? p_method) then raise exception 'Method not permitted'; end if;
  if p_outcome='passed' then
    if p_proof_id is not null then
      select * into proof from public.tv_proofs where id=p_proof_id for share;
      if proof.id is null or proof.revoked_at is not null or proof.expires_at<=now() or proof.min_age<s.min_age
        or proof.environment<>s.environment or proof.method<>p_method
        or proof.verified_at + make_interval(secs => (s.policy->>'maxAgeHours')::int*3600) <= now()
        then raise exception 'Proof does not meet policy'; end if;
    else
      if p_proof_token_hash is null then raise exception 'Proof token required'; end if;
      insert into public.tv_proofs(token_hash,min_age,environment,method,expires_at)
      values(p_proof_token_hash,s.min_age,s.environment,p_method,now()+interval '365 days') returning * into proof;
    end if;
    until_time := least(proof.expires_at, proof.verified_at + make_interval(secs => (s.policy->>'maxAgeHours')::int*3600));
  end if;
  update public.tv_sessions set status='completed',outcome=p_outcome,method=p_method,
    source=case when p_proof_id is null then 'browser' else 'reused' end,
    proof_id=proof.id,verified_at=proof.verified_at,valid_until=until_time,completed_at=now()
    where id=s.id returning * into s;
  result := jsonb_build_object('session_id',s.id,'site_id',s.site_id,'status',s.status,'outcome',s.outcome,
    'environment',s.environment,'age_over',s.min_age,'method',s.method,'assurance',s.assurance,'source',s.source,
    'verified_at',s.verified_at,'valid_until',s.valid_until,'completed_at',s.completed_at);
  if site.webhook_url is not null then
    insert into public.tv_webhooks(session_id,site_id,event_type,payload)
    values(s.id,s.site_id,'verification.completed',result);
  end if;
  return to_jsonb(s);
end $$;

create function public.tv_claim_webhooks(p_limit integer default 10) returns setof public.tv_webhooks
language sql set search_path=public as $$
  update public.tv_webhooks set status='processing',lease_until=now()+interval '90 seconds',attempts=attempts+1
  where id in (select id from public.tv_webhooks
    where (status='pending' and next_attempt_at<=now()) or (status='processing' and lease_until<now())
    order by created_at for update skip locked limit least(p_limit,20)) returning *;
$$;

create function public.tv_cleanup() returns void language plpgsql set search_path=public as $$ begin
  delete from public.tv_tokens where expires_at<now();
  update public.tv_sessions set status='expired' where status in ('created','in_progress') and expires_at<now();
  update public.tv_sessions set ip_hash=null where created_at<now()-interval '7 days' and ip_hash is not null;
  delete from public.tv_webhooks where created_at<now()-interval '30 days';
  delete from public.tv_sessions where created_at<now()-interval '90 days' and coalesce(valid_until,expires_at)<now();
  delete from public.tv_proofs where expires_at<now()-interval '7 days' and not exists(select 1 from public.tv_sessions where proof_id=tv_proofs.id);
  delete from public.tv_audit where created_at<now()-interval '90 days';
end $$;
revoke all on function public.tv_consume_token(text,text),public.tv_finish_session(uuid,text,text,text,uuid,text),public.tv_claim_webhooks(integer),public.tv_cleanup() from public,anon,authenticated;
grant execute on function public.tv_consume_token(text,text),public.tv_finish_session(uuid,text,text,text,uuid,text),public.tv_claim_webhooks(integer),public.tv_cleanup() to service_role;
