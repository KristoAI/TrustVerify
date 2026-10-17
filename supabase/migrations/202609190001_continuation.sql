-- Device delegation stores capabilities and bounded metadata, never verification inputs.
alter table public.tv_sessions add column desktop_hash text;
create function public.tv_bind_desktop(p_id uuid,p_cap_hash text,p_desktop_hash text)
returns jsonb language plpgsql set search_path=public as $$
declare s public.tv_sessions;
begin
  select * into s from public.tv_sessions where id=p_id for update;
  if s.id is null or s.cap_hash is distinct from p_cap_hash or coalesce(length(p_desktop_hash),0)<>64 then raise exception 'Invalid desktop binding'; end if;
  if s.desktop_hash is not null and s.desktop_hash is distinct from p_desktop_hash then raise exception 'Different desktop'; end if;
  if s.status='completed' then
    if s.desktop_hash is null or s.expires_at+interval '10 minutes'<=now() then raise exception 'Recovery expired'; end if;
  elsif s.status not in ('created','in_progress') or s.expires_at<=now() then raise exception 'Session inactive'; end if;
  update public.tv_sessions set desktop_hash=p_desktop_hash where id=s.id returning * into s;
  return to_jsonb(s);
end $$;
revoke all on function public.tv_bind_desktop(uuid,text,text) from public,anon,authenticated;
grant execute on function public.tv_bind_desktop(uuid,text,text) to service_role;

create table public.tv_continuations (
  id uuid primary key references public.tv_sessions(id) on delete cascade,
  generation integer not null default 1,
  desktop_hash text not null,
  invitation_hash text not null unique,
  phone_hash text,
  visitor_id uuid references public.tv_visitors(id) on delete set null,
  state text not null check(state in ('offered','awaiting_approval','active','completed','cancelled','expired')),
  pairing_phrase text,
  invitation_expires_at timestamptz not null,
  approval_expires_at timestamptz,
  expires_at timestamptz not null,
  handoff_hash text,
  handoff_cipher text,
  handoff_expires_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.tv_continuations enable row level security;
revoke all on public.tv_continuations from anon, authenticated;
grant all on public.tv_continuations to service_role;

-- Both direct and delegated completion lock the SESSION first. This common lock
-- makes approval vs direct finish and cancellation vs phone finish deterministic.
alter function public.tv_finish_session(uuid,text,text,text,uuid,text) rename to tv_finish_session_core;
create function public.tv_finish_session(p_id uuid,p_cap_hash text,p_outcome text,p_method text,p_proof_id uuid default null,p_proof_token_hash text default null)
returns jsonb language plpgsql set search_path=public as $$
declare result jsonb; s public.tv_sessions;
begin
  select * into s from public.tv_sessions where id=p_id for update;
  if s.id is null or s.cap_hash is distinct from p_cap_hash then raise exception 'Invalid session capability'; end if;
  if exists(select 1 from public.tv_continuations where id=p_id and state in ('active','completed')) then
    raise exception 'Verification delegated to phone';
  end if;
  if s.status='completed' then
    if s.expires_at+interval '10 minutes'<=now() or s.outcome is distinct from p_outcome or s.method is distinct from p_method
      or (p_proof_id is null and s.source<>'browser')
      or (p_proof_id is not null and (s.source<>'reused' or s.proof_id is distinct from p_proof_id))
      then raise exception 'Conflicting or expired completed result'; end if;
    return to_jsonb(s);
  end if;
  result := public.tv_finish_session_core(p_id,p_cap_hash,p_outcome,p_method,p_proof_id,p_proof_token_hash);
  update public.tv_continuations set state='cancelled',phone_hash=null,updated_at=now()
    where id=p_id and state in ('offered','awaiting_approval');
  return result;
end $$;

create function public.tv_continuation(p_action text,p_args jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare s public.tv_sessions; c public.tv_continuations; result jsonb;
  desktop boolean; phone boolean; fresh_until timestamptz;
begin
  select * into s from public.tv_sessions where id=(p_args->>'id')::uuid for update;
  if s.id is null then raise exception 'Unknown session'; end if;
  select * into c from public.tv_continuations where id=s.id for update;
  desktop := c.id is not null and c.desktop_hash is not distinct from p_args->>'desktop_hash';
  phone := c.phone_hash is not null and c.phone_hash is not distinct from p_args->>'phone_hash';
  if p_action='invite' then
    if s.cap_hash is distinct from p_args->>'cap_hash' or s.status not in ('created','in_progress') or s.expires_at<=now()
      then raise exception 'Invalid launch'; end if;
    if s.desktop_hash is null or s.desktop_hash is distinct from p_args->>'desktop_hash' then raise exception 'Original desktop required'; end if;
    if c.id is not null and (not desktop or c.state in ('active','completed')) then raise exception 'Cannot replace delegation'; end if;
    if coalesce(length(p_args->>'desktop_hash'),0)<>64 or coalesce(length(p_args->>'invitation_hash'),0)<>64 then raise exception 'Invalid capability'; end if;
    insert into public.tv_continuations(id,desktop_hash,invitation_hash,visitor_id,state,invitation_expires_at,expires_at)
      values(s.id,p_args->>'desktop_hash',p_args->>'invitation_hash',(p_args->>'visitor_id')::uuid,'offered',least(s.expires_at,now()+interval '2 minutes'),s.expires_at+interval '10 minutes')
    on conflict(id) do update set generation=tv_continuations.generation+1, invitation_hash=excluded.invitation_hash,
      phone_hash=null,state='offered',pairing_phrase=null,invitation_expires_at=excluded.invitation_expires_at,
      approval_expires_at=null,updated_at=now()
    returning * into c;
    return to_jsonb(c);
  end if;
  if c.id is null then raise exception 'Unknown continuation'; end if;
  if p_action='claim' then
    if c.invitation_hash is distinct from p_args->>'invitation_hash' then raise exception 'Invalid invitation'; end if;
    -- A lost response can be retried by the same phone; another phone cannot claim it.
    if c.state in ('awaiting_approval','active') and phone then
      if s.expires_at<=now() or (c.state='awaiting_approval' and c.approval_expires_at<=now()) then raise exception 'Expired'; end if;
      return to_jsonb(c);
    end if;
    if c.state<>'offered' or c.invitation_expires_at<=now() or s.expires_at<=now() or s.status not in ('created','in_progress')
      then raise exception 'Invitation unavailable'; end if;
    if coalesce(length(p_args->>'phone_hash'),0)<>64 then raise exception 'Invalid phone'; end if;
    update public.tv_continuations set state='awaiting_approval',phone_hash=p_args->>'phone_hash',
      pairing_phrase=p_args->>'pairing_phrase',approval_expires_at=least(s.expires_at,now()+interval '2 minutes'),updated_at=now()
      where id=s.id returning * into c;
    return to_jsonb(c);
  end if;
  if p_action='finish' then
    if not phone then raise exception 'Wrong phone'; end if;
    if c.expires_at<=now() then raise exception 'Recovery expired'; end if;
    if c.state='completed' then
      if s.outcome is distinct from p_args->>'outcome' or s.method is distinct from p_args->>'method' then raise exception 'Conflicting result'; end if;
      return jsonb_build_object('state','completed','outcome',s.outcome);
    end if;
    if c.state<>'active' or s.expires_at<=now() then raise exception 'Phone not active'; end if;
    -- The locked generation/phone capability above is current. Core completion
    -- creates exactly one proof and outbox event in this same transaction.
    result := public.tv_finish_session_core(s.id,s.cap_hash,p_args->>'outcome',p_args->>'method',null,p_args->>'proof_token_hash');
    if c.visitor_id is not null and result->>'proof_id' is not null then
      update public.tv_proofs set visitor_id=c.visitor_id where id=(result->>'proof_id')::uuid and visitor_id is null;
    end if;
    update public.tv_continuations set state='completed',updated_at=now() where id=s.id;
    return jsonb_build_object('state','completed','outcome',result->>'outcome');
  end if;
  if p_action='status' then
    if not desktop and not phone then raise exception 'Wrong device'; end if;
    if c.expires_at<=now() then raise exception 'Recovery expired'; end if;
    if c.state in ('offered','awaiting_approval','active') and
      (s.expires_at<=now() or s.status not in ('created','in_progress') or
       (c.state='offered' and c.invitation_expires_at<=now()) or
       (c.state='awaiting_approval' and c.approval_expires_at<=now())) then
      update public.tv_continuations set state='expired',phone_hash=null,updated_at=now() where id=s.id returning * into c;
    end if;
    return to_jsonb(c);
  end if;
  if not desktop then raise exception 'Original desktop required'; end if;
  if c.expires_at<=now() then raise exception 'Recovery expired'; end if;
  if p_action='complete' then
    if c.state<>'completed' or s.status<>'completed' then raise exception 'Not completed'; end if;
    -- Retry-safe while the handoff remains redeemable. Consumed/expired handoffs
    -- can be reissued only to the same desktop, without another verification.
    if c.handoff_expires_at>now() and exists(select 1 from public.tv_tokens where hash=c.handoff_hash and kind='completion-handoff' and expires_at>now()) then return to_jsonb(c); end if;
    fresh_until := least(c.expires_at,now()+interval '2 minutes');
    insert into public.tv_tokens(hash,kind,owner_id,data,expires_at) values(p_args->>'handoff_hash','completion-handoff',s.id,jsonb_build_object('desktop_hash',c.desktop_hash),fresh_until);
    update public.tv_continuations set handoff_hash=p_args->>'handoff_hash',handoff_cipher=p_args->>'handoff_cipher',handoff_expires_at=fresh_until,updated_at=now() where id=s.id returning * into c;
    return to_jsonb(c);
  end if;
  if s.status not in ('created','in_progress') or s.expires_at<=now() then raise exception 'Session inactive'; end if;
  if p_action='approve' then
    if c.state='active' then return to_jsonb(c); end if;
    if c.state<>'awaiting_approval' or c.approval_expires_at<=now() then raise exception 'Pairing unavailable'; end if;
    update public.tv_continuations set state='active',updated_at=now() where id=s.id returning * into c;
    return to_jsonb(c);
  elsif p_action='cancel' then
    if c.state='completed' then raise exception 'Already completed'; end if;
    -- Rotation also rejects direct capture requests already in flight with the old cap.
    if coalesce(length(p_args->>'cap_hash'),0)<>64 or p_args->>'launch_cipher' is null then raise exception 'Invalid launch'; end if;
    update public.tv_sessions set cap_hash=p_args->>'cap_hash',launch_cipher=p_args->>'launch_cipher' where id=s.id;
    update public.tv_continuations set state='cancelled',phone_hash=null,generation=generation+1,updated_at=now() where id=s.id returning * into c;
    return to_jsonb(c);
  end if;
  raise exception 'Unknown continuation action';
end $$;

-- The core is deliberately inaccessible to browser roles and the HTTP bridge.
revoke all on function public.tv_finish_session_core(uuid,text,text,text,uuid,text),public.tv_finish_session(uuid,text,text,text,uuid,text),public.tv_continuation(text,jsonb) from public,anon,authenticated;
grant execute on function public.tv_finish_session_core(uuid,text,text,text,uuid,text),public.tv_finish_session(uuid,text,text,text,uuid,text),public.tv_continuation(text,jsonb) to service_role;

-- Reuse the existing scheduled cleanup entry point and bound device metadata to
-- the recovery deadline rather than retaining it for the session's 90 days.
alter function public.tv_cleanup() rename to tv_cleanup_core;
create function public.tv_cleanup() returns void language plpgsql set search_path=public as $$
begin
  delete from public.tv_continuations where expires_at<now();
  perform public.tv_cleanup_core();
end $$;
revoke all on function public.tv_cleanup(),public.tv_cleanup_core() from public,anon,authenticated;
grant execute on function public.tv_cleanup(),public.tv_cleanup_core() to service_role;
