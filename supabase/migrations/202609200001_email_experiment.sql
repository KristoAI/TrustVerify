-- Experimental address-history + mailbox-control checks. Never age proofs.
create table public.tv_email_checks (
  id uuid primary key, session_id uuid not null unique references public.tv_sessions(id) on delete cascade,
  status text not null default 'queued' check(status in ('queued','checking','eligible','send_requested','sending','sent','verified','not_eligible','unavailable','expired','locked')),
  email_cipher text, email_hash text not null, minimum_years integer not null check(minimum_years between 1 and 99),
  code_cipher text, code_hash text, payload_hash text, attempts integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  expires_at timestamptz not null, code_expires_at timestamptz, worker_claimed_at timestamptz
);
create table public.tv_email_budget (bucket text not null, at timestamptz not null default clock_timestamp());
create index on public.tv_email_budget(bucket,at);
create table public.tv_email_catalog (id integer primary key check(id=1), data jsonb, expires_at timestamptz, lease_until timestamptz, email_pause_until timestamptz);
insert into public.tv_email_catalog(id) values(1);
alter table public.tv_email_checks enable row level security;
alter table public.tv_email_budget enable row level security;
alter table public.tv_email_catalog enable row level security;
revoke all on public.tv_email_checks,public.tv_email_budget,public.tv_email_catalog from public,anon,authenticated;
grant all on public.tv_email_checks,public.tv_email_budget,public.tv_email_catalog to service_role;

-- Rolling windows and a shared lock survive restarts and concurrent processes.
create function public.tv_email_reserve(p_bucket text,p_second int,p_hour int,p_day int) returns boolean
language plpgsql set search_path=public as $$
declare stamp timestamptz; begin
  perform pg_advisory_xact_lock(hashtextextended('email-budget:'||p_bucket,0));
  stamp:=clock_timestamp();
  if (select count(*) from tv_email_budget where bucket=p_bucket and at>stamp-interval '1 second')>=p_second
    or (select count(*) from tv_email_budget where bucket=p_bucket and at>stamp-interval '1 hour')>=p_hour
    or (select count(*) from tv_email_budget where bucket=p_bucket and at>stamp-interval '24 hours')>=p_day then return false; end if;
  insert into tv_email_budget(bucket,at) values(p_bucket,stamp);
  return true;
end $$;

create function public.tv_email_action(p_action text,p_id uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql set search_path=public as $$
declare c public.tv_email_checks; s public.tv_sessions; catalog public.tv_email_catalog; result jsonb; begin
  if p_action='cleanup' then
    update tv_email_checks set status='expired',email_cipher=null,code_cipher=null,code_hash=null,payload_hash=null,updated_at=now()
      where (expires_at<=now() or (status in ('checking','sending','send_requested') and updated_at<now()-interval '2 minutes')
        or (status='sent' and code_expires_at<=now())) and status not in ('verified','not_eligible','unavailable','expired','locked');
    delete from tv_email_checks where created_at<now()-interval '24 hours';
    delete from tv_email_budget where at<now()-interval '24 hours';
    return '{"ok":true}';
  elsif p_action='metrics' then
    return jsonb_build_object('usage',(select coalesce(jsonb_object_agg(bucket,total),'{}') from
      (select bucket,count(*) total from tv_email_budget where bucket in ('xon-email','xon-catalog','ses-send') and at>now()-interval '24 hours' group by bucket) x),
      'checks',(select coalesce(jsonb_object_agg(status,total),'{}') from (select status,count(*) total from tv_email_checks group by status) x));
  elsif p_action='catalog_claim' then
    select * into catalog from tv_email_catalog where id=1 for update;
    if catalog.expires_at>now() then return jsonb_build_object('data',catalog.data); end if;
    if catalog.lease_until>now() then return '{"wait":true}'; end if;
    if not tv_email_reserve('xon-catalog',1,50,100) then return '{"unavailable":true}'; end if;
    update tv_email_catalog set lease_until=now()+interval '2 minutes' where id=1;
    return '{"fetch":true}';
  elsif p_action='catalog_save' then
    update tv_email_catalog set data=p_data->'catalog',expires_at=now()+interval '24 hours',lease_until=null where id=1;
    return '{"ok":true}';
  elsif p_action='catalog_failed' then
    -- Back off after upstream errors/429 rather than burning the daily quota.
    update tv_email_catalog set lease_until=now()+interval '1 hour' where id=1;
    return '{"ok":true}';
  elsif p_action='pause' then
    update tv_email_catalog set email_pause_until=now()+interval '1 hour' where id=1;
    return '{"ok":true}';
  elsif p_action='claim_send' then
    select * into c from tv_email_checks where exists(select 1 from tv_sessions ss join tv_sites site on site.id=ss.site_id where ss.id=tv_email_checks.session_id and ss.environment='test' and ss.status in ('created','in_progress') and ss.expires_at>now() and site.enabled) and status='send_requested' and worker_claimed_at is null and expires_at>now() and code_expires_at>now() order by created_at for update skip locked limit 1;
    if c.id is null then return null; end if;
    update tv_email_checks set worker_claimed_at=now(),updated_at=now() where id=c.id returning * into c;
    return to_jsonb(c);
  elsif p_action='claim' then
    select * into c from tv_email_checks where exists(select 1 from tv_sessions ss join tv_sites site on site.id=ss.site_id where ss.id=tv_email_checks.session_id and ss.environment='test' and ss.status in ('created','in_progress') and ss.expires_at>now() and site.enabled) and status='queued' and expires_at>now() order by created_at for update skip locked limit 1;
    if c.id is null then return null; end if;
    if exists(select 1 from tv_email_catalog where id=1 and email_pause_until>now()) or not tv_email_reserve('xon-email',1,25,100) then
      update tv_email_checks set status='unavailable',email_cipher=null,updated_at=now() where id=c.id;
      return null;
    end if;
    update tv_email_checks set status='checking',updated_at=now() where id=c.id returning * into c;
    return to_jsonb(c);
  elsif p_action='create' then
    select * into s from tv_sessions where id=(p_data->>'session_id')::uuid for update;
    if s.id is null or s.environment<>'test' or s.status not in ('created','in_progress') or s.expires_at<=now() then return '{"error":"inactive"}'; end if;
    select * into c from tv_email_checks where session_id=s.id;
    if c.id is not null then
      if c.email_hash<>p_data->>'email_hash' then return '{"error":"existing"}'; end if;
      return jsonb_build_object('id',c.id,'status',c.status);
    end if;
    if not tv_email_reserve('ip:'||(p_data->>'ip_hash'),1,5,20)
      or not tv_email_reserve('recipient:'||(p_data->>'email_hash'),1,3,5) then return '{"error":"limited"}'; end if;
    insert into tv_email_checks(id,session_id,email_cipher,email_hash,minimum_years,expires_at)
      values(p_id,s.id,p_data->>'email_cipher',p_data->>'email_hash',(p_data->>'minimum_years')::int,least(s.expires_at,now()+interval '20 minutes')) returning * into c;
    return jsonb_build_object('id',c.id,'status',c.status);
  end if;
  select * into c from tv_email_checks where id=p_id for update;
  if c.id is null then return '{"error":"missing"}'; end if;
  select * into s from tv_sessions where id=c.session_id;
  if c.expires_at<=now() or s.environment<>'test' or s.status not in ('created','in_progress') or s.expires_at<=now()
    or not exists(select 1 from tv_sites where id=s.site_id and enabled) then
    update tv_email_checks set status='expired',email_cipher=null,code_cipher=null,code_hash=null,payload_hash=null where id=c.id;
    return '{"error":"inactive"}';
  end if;
  if p_action='lookup_done' and c.status='checking' then
    if p_data->>'status' not in ('eligible','not_eligible','unavailable') then return '{"error":"invalid"}'; end if;
    update tv_email_checks set status=p_data->>'status',email_cipher=case when p_data->>'status'='eligible' then email_cipher else null end,updated_at=now() where id=c.id;
  elsif p_action='send' and c.status='eligible' then
    update tv_email_checks set status='send_requested',code_cipher=p_data->>'code_cipher',code_hash=p_data->>'code_hash',payload_hash=p_data->>'payload_hash',code_expires_at=least(expires_at,now()+interval '10 minutes'),updated_at=now() where id=c.id;
  elsif p_action='dispatch' and c.status='send_requested' and c.code_expires_at>now() and c.payload_hash=p_data->>'payloadHash' then
    if not tv_email_reserve('ses-send',1,25,100) then return '{"error":"limited"}'; end if;
    update tv_email_checks set status='sending',updated_at=now() where id=c.id;
    return '{"ok":true}';
  elsif p_action='sent' and c.status='sending' then
    update tv_email_checks set status='sent',email_cipher=null,code_cipher=null,payload_hash=null,updated_at=now() where id=c.id;
  elsif p_action='send_failed' and c.status in ('send_requested','sending') then
    update tv_email_checks set status='unavailable',email_cipher=null,code_cipher=null,code_hash=null,payload_hash=null,updated_at=now() where id=c.id;
  elsif p_action='verify' and c.status='sent' and c.code_expires_at>now() then
    update tv_email_checks set attempts=attempts+1,
      status=case when code_hash=p_data->>'code_hash' then 'verified' when attempts>=4 then 'locked' else 'sent' end,
      code_hash=case when code_hash=p_data->>'code_hash' or attempts>=4 then null else code_hash end,updated_at=now() where id=c.id;
  else return '{"error":"state"}'; end if;
  select * into c from tv_email_checks where id=p_id;
  return jsonb_build_object('id',c.id,'status',c.status);
end $$;
revoke all on function public.tv_email_reserve(text,int,int,int),public.tv_email_action(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.tv_email_action(text,uuid,jsonb) to service_role;
-- The bridge role invokes helpers as invoker; untrusted roles have no grants.
grant execute on function public.tv_email_reserve(text,int,int,int) to service_role;
