-- Distinguish owner actions from successful Relay API publication requests.
alter table public.publications add column confirmation_origin text
  check(confirmation_origin in ('relay_api','manual'));
create or replace function public.update_publication(p_holder uuid,p_id text,p_platform text,p_patch jsonb) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform update_base_publication(p_holder,p_id,p_platform,p_patch);
  update publications set
    confirmation_origin=case when p_patch ? 'confirmation_origin' then p_patch->>'confirmation_origin' else confirmation_origin end,
    api_checked_at=case when p_platform='youtube' and (p_patch->>'external_id' is not null or p_patch->>'encrypted_session' is not null)
      then now() else api_checked_at end
    where video_id=p_id and platform=p_platform;
end; $$;
