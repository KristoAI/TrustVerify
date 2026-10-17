-- Revocation and its notification are atomic; notifications carry no visitor identifier.
create function public.tv_revoke_session(p_session_id uuid,p_site_id uuid) returns jsonb
language plpgsql set search_path=public as $$
declare s public.tv_sessions; site public.tv_sites; begin
 select * into s from public.tv_sessions where id=p_session_id and site_id=p_site_id for update;
 if s.id is null then raise exception 'Session not found'; end if;
 update public.tv_sessions set valid_until=least(coalesce(valid_until,now()),now()) where id=s.id returning * into s;
 select * into site from public.tv_sites where id=s.site_id;
 if site.webhook_url is not null then
  insert into public.tv_webhooks(session_id,site_id,event_type,payload) values(s.id,s.site_id,'verification.revoked',jsonb_build_object('session_id',s.id,'site_id',s.site_id,'environment',s.environment,'outcome',s.outcome,'valid',false,'valid_until',s.valid_until)) on conflict(session_id,event_type) do nothing;
 end if;
 return to_jsonb(s);
end $$;
create function public.tv_forget_proofs(p_visitor_id uuid default null,p_proof_ids uuid[] default '{}') returns integer
language plpgsql set search_path=public as $$
declare s public.tv_sessions; ids uuid[]; n integer; begin
 with revoked as (update public.tv_proofs set revoked_at=coalesce(revoked_at,now()) where (p_visitor_id is not null and visitor_id=p_visitor_id) or id=any(p_proof_ids) returning id) select array_agg(id) into ids from revoked;
 n:=coalesce(array_length(ids,1),0);
 for s in select * from public.tv_sessions where proof_id=any(ids) and outcome='passed' loop
  perform public.tv_revoke_session(s.id,s.site_id);
 end loop;
 return n;
end $$;
revoke all on function public.tv_revoke_session(uuid,uuid),public.tv_forget_proofs(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.tv_revoke_session(uuid,uuid),public.tv_forget_proofs(uuid,uuid[]) to service_role;
create index if not exists tv_tokens_owner_kind_idx on public.tv_tokens(owner_id,kind);
create unique index if not exists tv_visitors_recovery_unique on public.tv_visitors(recovery_hash);
