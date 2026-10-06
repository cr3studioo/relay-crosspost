-- Owner checks use the caller's RLS-protected app_owner row; no elevation needed.
alter function public.is_owner() security invoker;
alter function public.is_owner() set search_path = '';
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;

-- Remove inherited/default browser privileges, then grant only dashboard reads.
revoke all on public.app_owner, public.settings, public.credentials,
  public.videos, public.publications, public.worker_lease, public.events
  from public, anon, authenticated;
grant select on public.app_owner, public.settings, public.videos,
  public.publications, public.events to authenticated;
grant all on public.app_owner, public.settings, public.credentials,
  public.videos, public.publications, public.worker_lease, public.events to service_role;

alter policy owner_read on public.app_owner using (user_id = (select auth.uid()));
alter policy owner_read on public.settings using ((select public.is_owner()));
alter policy owner_read on public.videos using ((select public.is_owner()));
alter policy owner_read on public.publications using ((select public.is_owner()));
alter policy owner_read on public.events using ((select public.is_owner()));

create index events_video_id on public.events(video_id);
