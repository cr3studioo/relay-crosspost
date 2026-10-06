-- Run once in Supabase SQL Editor, then provision the single owner (README).
create table public.app_owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id) on delete cascade
);
create table public.settings (
  singleton boolean primary key default true check (singleton),
  source_profile text not null default '',
  timezone text not null default 'Europe/Prague',
  start_hour integer not null default 7 check(start_hour between 0 and 23),
  end_hour integer not null default 21 check(end_hour between 1 and 24),
  paused boolean not null default true,
  import_complete boolean not null default false,
  integrations_verified boolean not null default false,
  youtube_audit_confirmed boolean not null default false,
  instagram_template text not null default '{caption}',
  youtube_title_template text not null default '{first_line}',
  youtube_description_template text not null default '{caption}',
  last_discovery_at timestamptz,
  last_publication_at timestamptz,
  worker_seen_at timestamptz,
  worker_error text,
  check(start_hour < end_hour)
);
insert into public.settings(singleton) values(true);
create table public.credentials (
  platform text primary key check(platform in ('instagram','youtube')),
  account_id text,
  account_label text not null,
  encrypted_payload text not null,
  connected_at timestamptz not null default now()
);
create table public.videos (
  id text primary key check(id ~ '^[0-9]+$'),
  source_url text not null,
  source_created_at timestamptz not null,
  caption text not null default '',
  duration double precision,
  width integer,
  height integer,
  state text not null default 'queued' check(state in ('queued','preparing','published','skipped','attention')),
  reason text,
  added_at timestamptz not null default now()
);
create index videos_queue on public.videos(source_created_at,id) where state not in ('published','skipped');
create table public.publications (
  video_id text references public.videos(id) on delete cascade,
  platform text check(platform in ('instagram','youtube')),
  state text not null default 'pending' check(state in ('pending','uploading','processing','ready','publishing','published','retry','attention')),
  resume_state text,
  external_id text,
  encrypted_session text,
  rendered_metadata jsonb,
  attempts integer not null default 0,
  next_retry_at timestamptz,
  published_at timestamptz,
  public_url text,
  error_code text,
  primary key(video_id,platform)
);
create table public.worker_lease (
  singleton boolean primary key default true check(singleton),
  holder uuid,
  expires_at timestamptz not null default '-infinity'
);
insert into public.worker_lease(singleton) values(true);
create table public.events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  level text not null check(level in ('info','warning','error')),
  message text not null,
  video_id text references public.videos(id) on delete set null
);
create or replace function public.is_owner() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.app_owner where user_id=auth.uid());
$$;
alter table public.app_owner enable row level security;
alter table public.settings enable row level security;
alter table public.credentials enable row level security;
alter table public.videos enable row level security;
alter table public.publications enable row level security;
alter table public.worker_lease enable row level security;
alter table public.events enable row level security;
create policy owner_read on public.app_owner for select to authenticated using(user_id=auth.uid());
create policy owner_read on public.settings for select to authenticated using(public.is_owner());
create policy owner_read on public.videos for select to authenticated using(public.is_owner());
create policy owner_read on public.publications for select to authenticated using(public.is_owner());
create policy owner_read on public.events for select to authenticated using(public.is_owner());
-- Credentials and leases intentionally have NO browser access policy.
revoke all on public.credentials,public.worker_lease from anon,authenticated;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
grant select on public.app_owner,public.settings,public.videos,public.publications,public.events to authenticated;

create or replace function public.acquire_lease(p_holder uuid) returns boolean language plpgsql security definer set search_path=public as $$
begin
  update worker_lease set holder=p_holder,expires_at=clock_timestamp()+interval '15 minutes'
  where singleton and (expires_at<clock_timestamp() or holder=p_holder);
  return found;
end; $$;
create or replace function public.assert_lease(p_holder uuid) returns void language plpgsql security definer set search_path=public as $$
begin
  -- Row lock fences all database mutations and dashboard queue edits.
  perform 1 from worker_lease where singleton and holder=p_holder and expires_at>clock_timestamp() for update;
  if not found then raise exception 'Worker lease lost'; end if;
  update worker_lease set expires_at=clock_timestamp()+interval '15 minutes' where singleton;
end; $$;
create or replace function public.release_lease(p_holder uuid) returns void language sql security definer set search_path=public as $$
  update worker_lease set holder=null,expires_at='-infinity' where singleton and holder=p_holder;
$$;
create or replace function public.worker_settings(p_holder uuid,p_patch jsonb) returns void language plpgsql security definer set search_path=public as $$
begin
  perform assert_lease(p_holder);
  update settings set
    import_complete=coalesce((p_patch->>'import_complete')::boolean,import_complete),
    integrations_verified=coalesce((p_patch->>'integrations_verified')::boolean,integrations_verified),
    last_discovery_at=coalesce((p_patch->>'last_discovery_at')::timestamptz,last_discovery_at),
    worker_seen_at=coalesce((p_patch->>'worker_seen_at')::timestamptz,worker_seen_at),
    worker_error=case when p_patch ? 'worker_error' then p_patch->>'worker_error' else worker_error end
  where singleton;
end; $$;
create or replace function public.ingest_video(p_holder uuid,p_video jsonb) returns void language plpgsql security definer set search_path=public as $$
begin
  perform assert_lease(p_holder);
  insert into videos(id,source_url,source_created_at,caption,duration,width,height)
    values(p_video->>'id',p_video->>'source_url',(p_video->>'source_created_at')::timestamptz,
      coalesce(p_video->>'caption',''),(p_video->>'duration')::double precision,(p_video->>'width')::integer,(p_video->>'height')::integer)
    on conflict(id) do nothing;
  insert into publications(video_id,platform) values(p_video->>'id','instagram'),(p_video->>'id','youtube') on conflict do nothing;
end; $$;
create or replace function public.update_video(p_holder uuid,p_id text,p_state text,p_reason text default null) returns void language plpgsql security definer set search_path=public as $$
begin
  perform assert_lease(p_holder);
  update videos set state=p_state,reason=p_reason where id=p_id;
end; $$;
create or replace function public.update_publication(p_holder uuid,p_id text,p_platform text,p_patch jsonb) returns void language plpgsql security definer set search_path=public as $$
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
    -- Confirmation time is conservative when a publish response was lost.
    select published_at into pub_at from publications where video_id=p_id and platform=p_platform;
    update settings set last_publication_at=greatest(last_publication_at,pub_at) where singleton;
    if (select count(*) from publications where video_id=p_id and state='published')=2 then
      update videos set state='published',reason=null where id=p_id;
    end if;
  end if;
end; $$;
create or replace function public.worker_event(p_holder uuid,p_level text,p_message text,p_video_id text default null) returns void language plpgsql security definer set search_path=public as $$
begin
  perform assert_lease(p_holder);
  insert into events(level,message,video_id) values(p_level,left(p_message,300),p_video_id);
  delete from events where created_at<now()-interval '30 days';
end; $$;
create or replace function public.control_video(p_id text,p_action text) returns void language plpgsql security definer set search_path=public as $$
begin
  perform 1 from worker_lease where singleton and expires_at<clock_timestamp() for update;
  if not found then raise exception 'Worker busy; try again after it finishes'; end if;
  if p_action='skip' then
    update videos set state='skipped',reason='Skipped by you' where id=p_id and state<>'published';
  elsif p_action='retry' then
    update videos set state='queued',reason=null where id=p_id and state<>'published';
    -- Never discard successful destinations or uncertain publish intents.
    update publications set state=coalesce(resume_state,case when external_id is null then 'pending' else 'processing' end),
      error_code=null,next_retry_at=null,attempts=0 where video_id=p_id and state in ('retry','attention');
  else raise exception 'Invalid action'; end if;
end; $$;
-- Mutations are service-role-only. Server actions verify the single owner first.
do $$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('acquire_lease','assert_lease','release_lease','worker_settings','ingest_video','update_video','update_publication','worker_event','control_video')
  loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);
       execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end; $$;
