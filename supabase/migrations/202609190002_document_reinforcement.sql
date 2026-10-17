-- Interpret legacy selfie-only policies as Live AI with document reinforcement.
-- No site or session policy rows are rewritten. Both direct and phone completion
-- already share this core function; their locking/device checks are unchanged.
create or replace function public.tv_finish_session_core(p_id uuid,p_cap_hash text,p_outcome text,p_method text,p_proof_id uuid default null,p_proof_token_hash text default null)
returns jsonb language plpgsql set search_path=public as $$
declare s public.tv_sessions; site public.tv_sites; proof public.tv_proofs; until_time timestamptz; result jsonb;
begin
  select * into s from public.tv_sessions where id=p_id for update;
  if s.id is null or s.cap_hash<>p_cap_hash then raise exception 'Invalid session capability'; end if;
  if s.status not in ('created','in_progress') or s.expires_at<=now() then raise exception 'Session is not active'; end if;
  if p_outcome not in ('passed','not_passed','inconclusive') or p_method not in ('selfie','document') then raise exception 'Invalid outcome'; end if;
  select * into site from public.tv_sites where id=s.site_id;
  if not site.enabled then raise exception 'Site disabled'; end if;
  -- Live AI always supports document reinforcement, including old snapshots.
  -- Keep document-only policies restrictive and leave persisted policies intact.
  if not ((s.policy->'methods' ? p_method)
    or (p_method='document' and s.policy->'methods' ? 'selfie'))
    then raise exception 'Method not permitted'; end if;
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

revoke all on function public.tv_finish_session_core(uuid,text,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.tv_finish_session_core(uuid,text,text,text,uuid,text) to service_role;
