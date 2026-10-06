alter table public.settings
  add column policy_version text,
  add column policy_accepted_at timestamptz,
  add column youtube_visibility text not null default 'public' check(youtube_visibility in ('public','private','unlisted')),
  add column youtube_revoke_requested_at timestamptz;
alter table public.credentials add column api_checked_at timestamptz not null default now();
alter table public.publications
  add column api_checked_at timestamptz not null default now(),
  add column youtube_visibility text check(youtube_visibility in ('public','private','unlisted'));

-- Keep preference validation and the worker lock in the existing implementation.
alter function public.save_preferences(jsonb) rename to save_base_preferences;
revoke all on function public.save_base_preferences(jsonb) from public,anon,authenticated,service_role;
create function public.save_preferences(p_patch jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare previous text; target text;
begin
  perform 1 from worker_lease where singleton and expires_at<clock_timestamp() for update;
  if not found then raise exception 'Worker busy; try again after it finishes'; end if;
  select youtube_visibility into previous from settings where singleton for update;
  target:=coalesce(p_patch->>'youtube_visibility',previous);
  if target not in ('public','private','unlisted') then raise exception 'Invalid YouTube visibility'; end if;
  perform save_base_preferences(p_patch);
  update settings set youtube_visibility=target,
    paused=case when target<>previous then true else paused end,
    integrations_verified=case when target<>previous then false else integrations_verified end where singleton;
end; $$;

create function public.accept_policy(p_version text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if p_version<>'2026-10-06' then raise exception 'Unsupported policy version'; end if;
  update settings set policy_version=p_version,policy_accepted_at=now(),paused=true where singleton;
end; $$;

-- Delete identifiers, account data and upload sessions, but retain TikTok IDs and
-- Relay's own completion facts to prevent duplicates and preserve hourly spacing.
create function public.clear_youtube_data(p_holder uuid,p_credentials boolean default true) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform assert_lease(p_holder);
  update videos v set state='attention',reason='youtube_data_deleted_review_required'
    where v.state not in ('published','skipped') and exists(
      select 1 from publications p where p.video_id=v.id and p.platform='youtube'
      and p.state<>'published' and (p.external_id is not null or p.encrypted_session is not null or p.state<>'pending'));
  update publications set
    state=case when state='published' then state
      when external_id is not null or encrypted_session is not null or state<>'pending' then 'attention' else 'pending' end,
    error_code=case when state<>'published' and (external_id is not null or encrypted_session is not null or state<>'pending')
      then 'youtube_data_deleted_review_required' else null end,
    resume_state=null,external_id=null,encrypted_session=null,rendered_metadata=null,
    public_url=null,youtube_visibility=null,next_retry_at=null,attempts=0,api_checked_at=now()
    where platform='youtube';
  if p_credentials then
    delete from credentials where platform='youtube';
    update settings set youtube_revoke_requested_at=null where singleton;
  else
    update credentials set account_id=null,account_label='Disconnection pending',api_checked_at=now() where platform='youtube';
  end if;
  update settings set paused=true,integrations_verified=false,worker_error=null where singleton;
  delete from events; -- Events may describe authorized YouTube operations.
end; $$;

create function public.request_youtube_disconnect(p_holder uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform assert_lease(p_holder);
  update settings set youtube_revoke_requested_at=coalesce(youtube_revoke_requested_at,now()),paused=true,integrations_verified=false where singleton;
  perform clear_youtube_data(p_holder,false);
end; $$;

-- Refresh API data weekly. At 30 days, remove stale references safely even when
-- a network outage prevents refresh. Never reset an uncertain upload to pending.
create function public.expire_youtube_data(p_holder uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform assert_lease(p_holder);
  if exists(select 1 from credentials where platform='youtube' and api_checked_at<now()-interval '30 days')
    or exists(select 1 from settings where youtube_revoke_requested_at<now()-interval '7 days') then
    perform clear_youtube_data(p_holder,true);
    return;
  end if;
  update videos v set state='attention',reason='youtube_data_deleted_review_required'
    where v.state not in ('published','skipped') and exists(select 1 from publications p
      where p.video_id=v.id and p.platform='youtube' and p.state<>'published'
      and p.api_checked_at<now()-interval '30 days' and (p.external_id is not null or p.encrypted_session is not null));
  update publications set
    state=case when state='published' then state else 'attention' end,
    error_code=case when state='published' then null else 'youtube_data_deleted_review_required' end,
    external_id=null,encrypted_session=null,rendered_metadata=null,public_url=null,
    youtube_visibility=null,resume_state=null,next_retry_at=null,api_checked_at=now()
    where platform='youtube' and api_checked_at<now()-interval '30 days'
      and (external_id is not null or encrypted_session is not null or rendered_metadata is not null);
  delete from events where created_at<now()-interval '30 days';
end; $$;

create function public.refresh_youtube_publication(p_holder uuid,p_id text,p_visibility text) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform assert_lease(p_holder);
  update publications set api_checked_at=now(),youtube_visibility=p_visibility,
    public_url=case when p_visibility in ('public','unlisted') then 'https://www.youtube.com/shorts/'||external_id else null end
    where video_id=p_id and platform='youtube';
end; $$;

alter function public.update_publication(uuid,text,text,jsonb) rename to update_base_publication;
revoke all on function public.update_base_publication(uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.update_publication(p_holder uuid,p_id text,p_platform text,p_patch jsonb) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform update_base_publication(p_holder,p_id,p_platform,p_patch);
  if p_platform='youtube' and (p_patch->>'external_id' is not null or p_patch->>'encrypted_session' is not null) then
    update publications set api_checked_at=now() where video_id=p_id and platform=p_platform;
  end if;
end; $$;

create or replace function public.control_video(p_id text,p_action text) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform 1 from worker_lease where singleton and expires_at<clock_timestamp() for update;
  if not found then raise exception 'Worker busy; try again after it finishes'; end if;
  if p_action='skip' then
    update videos set state='skipped',reason='Skipped by you' where id=p_id and state<>'published';
  elsif p_action='retry' then
    if exists(select 1 from publications where video_id=p_id and required and error_code='youtube_data_deleted_review_required')
      then raise exception 'YouTube references were deleted; review and skip this video to avoid a duplicate'; end if;
    update videos set state='queued',reason=null where id=p_id and state<>'published';
    update publications set state=coalesce(resume_state,case when external_id is null then 'pending' else 'processing' end),
      error_code=null,next_retry_at=null,attempts=0 where video_id=p_id and required and state in ('retry','attention');
  else raise exception 'Invalid action'; end if;
end; $$;

-- These new RPCs are never available to browser roles.
do $$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('save_preferences','accept_policy','clear_youtube_data','request_youtube_disconnect','expire_youtube_data','refresh_youtube_publication','update_publication')
  loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);
       execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end; $$;
