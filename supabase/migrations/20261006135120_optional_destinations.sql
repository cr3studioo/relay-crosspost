-- Select one or both destinations. Completed videos retain their original targets.
alter table public.settings add column enabled_platforms text[] not null default array['instagram','youtube']
  check (array_ndims(enabled_platforms)=1 and array_lower(enabled_platforms,1)=1
    and cardinality(enabled_platforms) between 1 and 2
    and enabled_platforms <@ array['instagram','youtube']::text[]
    and array_position(enabled_platforms,null) is null
    and (cardinality(enabled_platforms)=1 or enabled_platforms[1]<>enabled_platforms[2]));
alter table public.publications add column required boolean not null default true;

create or replace function public.save_preferences(p_patch jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare targets text[]; previous text[]; source text;
begin
  -- Use the same lock order as workers; destination changes cannot race an upload.
  perform 1 from worker_lease where singleton and expires_at<clock_timestamp() for update;
  if not found then raise exception 'Worker busy; try again after it finishes'; end if;
  select enabled_platforms,source_profile into previous,source from settings where singleton for update;
  targets:=case when p_patch ? 'enabled_platforms'
    then array(select jsonb_array_elements_text(p_patch->'enabled_platforms')) else previous end;
  if source<>'' and p_patch ? 'source_profile' and source<>p_patch->>'source_profile' then
    raise exception 'Source account cannot change without resetting history';
  end if;
  update settings set
    source_profile=coalesce(p_patch->>'source_profile',source_profile),
    timezone=coalesce(p_patch->>'timezone',timezone),
    start_hour=coalesce((p_patch->>'start_hour')::integer,start_hour),
    end_hour=coalesce((p_patch->>'end_hour')::integer,end_hour),
    instagram_template=coalesce(p_patch->>'instagram_template',instagram_template),
    youtube_title_template=coalesce(p_patch->>'youtube_title_template',youtube_title_template),
    youtube_description_template=coalesce(p_patch->>'youtube_description_template',youtube_description_template),
    youtube_audit_confirmed=coalesce((p_patch->>'youtube_audit_confirmed')::boolean,youtube_audit_confirmed),
    enabled_platforms=targets,
    paused=case when not (targets @> previous and previous @> targets)
      or ('youtube'=any(targets) and not coalesce((p_patch->>'youtube_audit_confirmed')::boolean,youtube_audit_confirmed))
      then true else paused end,
    integrations_verified=case when not (targets @> previous and previous @> targets)
      then false else integrations_verified end
  where singleton;
  if not (targets @> previous and previous @> targets) then
    update publications p set required=p.platform=any(targets)
      from videos v where p.video_id=v.id and v.state<>'published';
    -- A removed destination's error must no longer stall the selected destinations.
    update videos v set state=case
      when not exists(select 1 from publications p where p.video_id=v.id and p.required and p.state<>'published') then 'published'
      when exists(select 1 from publications p where p.video_id=v.id and p.required and p.state='attention') then 'attention'
      else 'queued' end,
      reason=case when exists(select 1 from publications p where p.video_id=v.id and p.required and p.state='attention')
        then (select p.error_code from publications p where p.video_id=v.id and p.required and p.state='attention' order by p.platform limit 1)
        else null end
      where v.state not in ('published','skipped');
  end if;
end; $$;
revoke all on function public.save_preferences(jsonb) from public,anon,authenticated;
grant execute on function public.save_preferences(jsonb) to service_role;

create or replace function public.ingest_video(p_holder uuid,p_video jsonb) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform assert_lease(p_holder);
  insert into videos(id,source_url,source_created_at,caption,duration,width,height)
    values(p_video->>'id',p_video->>'source_url',(p_video->>'source_created_at')::timestamptz,
      coalesce(p_video->>'caption',''),(p_video->>'duration')::double precision,(p_video->>'width')::integer,(p_video->>'height')::integer)
    on conflict(id) do nothing;
  insert into publications(video_id,platform,required)
    select p_video->>'id',p,p=any(s.enabled_platforms)
    from settings s cross join unnest(array['instagram','youtube']) p where s.singleton
    on conflict do nothing;
end; $$;

create or replace function public.update_publication(p_holder uuid,p_id text,p_platform text,p_patch jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare pub_at timestamptz;
begin
  perform assert_lease(p_holder);
  update publications set
    state=coalesce(p_patch->>'state',state),
    resume_state=case when p_patch ? 'resume_state' then p_patch->>'resume_state' else resume_state end,
    external_id=case when p_patch ? 'external_id' then p_patch->>'external_id' else external_id end,
    encrypted_session=case when p_patch ? 'encrypted_session' then p_patch->>'encrypted_session' else encrypted_session end,
    rendered_metadata=case when p_patch ? 'rendered_metadata' then p_patch->'rendered_metadata' else rendered_metadata end,
    attempts=coalesce((p_patch->>'attempts')::integer,attempts),
    next_retry_at=case when p_patch ? 'next_retry_at' then (p_patch->>'next_retry_at')::timestamptz else next_retry_at end,
    published_at=coalesce((p_patch->>'published_at')::timestamptz,published_at),
    public_url=case when p_patch ? 'public_url' then p_patch->>'public_url' else public_url end,
    error_code=case when p_patch ? 'error_code' then p_patch->>'error_code' else error_code end
    where video_id=p_id and platform=p_platform;
  if p_patch->>'state'='published' then
    select published_at into pub_at from publications where video_id=p_id and platform=p_platform;
    update settings set last_publication_at=greatest(last_publication_at,pub_at) where singleton;
    if exists(select 1 from publications where video_id=p_id and required)
      and not exists(select 1 from publications where video_id=p_id and required and state<>'published') then
      update videos set state='published',reason=null where id=p_id;
    end if;
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
    update videos set state='queued',reason=null where id=p_id and state<>'published';
    update publications set state=coalesce(resume_state,case when external_id is null then 'pending' else 'processing' end),
      error_code=null,next_retry_at=null,attempts=0 where video_id=p_id and required and state in ('retry','attention');
  else raise exception 'Invalid action'; end if;
end; $$;
