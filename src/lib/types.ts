export type Platform = "instagram" | "youtube";
export type Settings = {
  source_profile: string;
  timezone: string;
  start_hour: number;
  end_hour: number;
  paused: boolean;
  import_complete: boolean;
  integrations_verified: boolean;
  youtube_audit_confirmed: boolean;
  enabled_platforms: Platform[];
  instagram_template: string;
  youtube_title_template: string;
  youtube_description_template: string;
  last_discovery_at: string | null;
  last_publication_at: string | null;
  worker_seen_at: string | null;
  worker_error: string | null;
};
export type Publication = {
  platform: Platform;
  required: boolean;
  state: string;
  external_id: string | null;
  public_url: string | null;
  published_at: string | null;
  error_code: string | null;
  next_retry_at: string | null;
};
export type Video = {
  id: string;
  source_url: string;
  source_created_at: string;
  caption: string;
  state: string;
  reason: string | null;
  duration: number | null;
  publications: Publication[];
};
export type Connection = {
  platform: Platform;
  account_id: string | null;
  account_label: string;
  connected_at: string;
};
export const defaults: Settings = {
  source_profile: "",
  timezone: "Europe/Prague",
  start_hour: 7,
  end_hour: 21,
  paused: true,
  import_complete: false,
  integrations_verified: false,
  youtube_audit_confirmed: false,
  enabled_platforms: ["instagram", "youtube"],
  instagram_template: "{caption}",
  youtube_title_template: "{first_line}",
  youtube_description_template: "{caption}",
  last_discovery_at: null,
  last_publication_at: null,
  worker_seen_at: null,
  worker_error: null,
};
