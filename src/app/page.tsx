import Link from "next/link";
import {
  ArrowUpRight,
  ArrowRight,
  Repeat2,
  LayoutDashboard,
  Clock3,
  Settings2,
  Check,
  Pause,
  Play,
  Camera as Instagram,
  SquarePlay as Youtube,
  Music2,
  Info,
  Link2,
  RefreshCw,
  ChevronRight,
  LogOut,
  AlertCircle,
  CheckCircle2,
  SkipForward,
} from "lucide-react";
import { admin, configured, owner, decrypt } from "@/lib/server";
import {
  defaults,
  type Settings,
  type Video,
  type Connection,
} from "@/lib/types";
import { estimatedSlots, formatTime } from "@/lib/schedule";
import {
  togglePause,
  controlVideo,
  saveSettings,
  chooseInstagram,
  logout,
} from "./actions";
import { Submit } from "@/components/submit";
import { Refresh } from "@/components/refresh";
export const dynamic = "force-dynamic";
const previews: Video[] = [
  {
    id: "1001",
    source_url: "https://www.tiktok.com",
    source_created_at: "2026-09-01T10:00:00Z",
    caption: "A small reminder to slow down. 🌿 #dailyvlog #littlemoments",
    state: "queued",
    reason: null,
    duration: 24,
    publications: [],
  },
  {
    id: "1002",
    source_url: "https://www.tiktok.com",
    source_created_at: "2026-09-02T10:00:00Z",
    caption: "The behind-the-scenes you asked for ✨ #creator #bts",
    state: "queued",
    reason: null,
    duration: 38,
    publications: [],
  },
  {
    id: "1003",
    source_url: "https://www.tiktok.com",
    source_created_at: "2026-09-03T10:00:00Z",
    caption: "My favourite part of the morning ☕ #morningroutine",
    state: "queued",
    reason: null,
    duration: 17,
    publications: [],
  },
];
function Mark({ platform }: { platform: string }) {
  return platform === "instagram" ? (
    <Instagram size={18} />
  ) : platform === "youtube" ? (
    <Youtube size={19} />
  ) : (
    <Music2 size={18} />
  );
}
function PairStatus({ video }: { video: Video }) {
  return (
    <div className="pair-status">
      {video.publications
        .filter((p) => p.required)
        .map((p) => {
          const platform = p.platform;
          return (
            <span
              key={platform}
              className={p?.state === "published" ? "done" : ""}
              title={`${platform}: ${p?.state || "waiting"}`}
            >
              <Mark platform={platform} />
              {p?.state === "published" && <Check size={10} />}
            </span>
          );
        })}
    </div>
  );
}
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; notice?: string; page?: string }>;
}) {
  const params = await searchParams;
  const tab = ["published", "skipped", "attention", "settings"].includes(
    params.tab || "",
  )
    ? params.tab!
    : "queue";
  const preview = !configured();
  let settings: Settings = defaults,
    videos: Video[] = previews,
    connections: Connection[] = [],
    events: Array<{
      id: number;
      message: string;
      created_at: string;
      level: string;
    }> = [];
  let counts = { queue: 3, published: 0, skipped: 0, attention: 0 },
    error = "",
    candidates: Array<{
      id: string;
      name: string;
      instagram_business_account: { username?: string };
    }> = [];
  const page = Math.max(
    0,
    Math.min(100, Number.parseInt(params.page || "0", 10) || 0),
  );
  if (!preview) {
    await owner();
    const db = admin();
    const query = db
      .from("videos")
      .select(
        "id,source_url,source_created_at,caption,state,reason,duration,publications(platform,required,state,external_id,public_url,published_at,error_code,next_retry_at)",
      );
    const filter =
      tab === "queue" || tab === "settings"
        ? query.in("state", ["queued", "preparing"])
        : query.eq("state", tab);
    const results = await Promise.all([
      db.from("settings").select("*").single(),
      filter
        .order("source_created_at", { ascending: tab !== "published" })
        .order("id")
        .range(page * 25, page * 25 + 24),
      db
        .from("credentials")
        .select("platform,account_id,account_label,connected_at"),
      db
        .from("events")
        .select("id,message,created_at,level")
        .order("created_at", { ascending: false })
        .limit(6),
      ...["queue", "published", "skipped", "attention"].map((t) =>
        t === "queue"
          ? db
              .from("videos")
              .select("id", { count: "exact", head: true })
              .in("state", ["queued", "preparing"])
          : db
              .from("videos")
              .select("id", { count: "exact", head: true })
              .eq("state", t),
      ),
    ]);
    if (results.some((r) => r.error))
      error =
        "Could not load your workspace. Check the database migration and environment variables.";
    settings = (results[0].data as Settings) || defaults;
    videos = (results[1].data as unknown as Video[]) || [];
    connections = (results[2].data as Connection[]) || [];
    events = (results[3].data as typeof events) || [];
    counts = {
      queue: results[4].count || 0,
      published: results[5].count || 0,
      skipped: results[6].count || 0,
      attention: results[7].count || 0,
    };
    if (connections.some((c) => c.platform === "instagram" && !c.account_id)) {
      const { data } = await db
        .from("credentials")
        .select("encrypted_payload")
        .eq("platform", "instagram")
        .single();
      if (data)
        candidates =
          decrypt<{ candidates: typeof candidates }>(data.encrypted_payload)
            .candidates || [];
    }
  } else if (tab !== "queue" && tab !== "settings") videos = [];
  const slots = estimatedSlots(settings, 25 * (page + 1));
  const stale =
    !preview &&
    settings.worker_seen_at &&
    Date.now() - Date.parse(settings.worker_seen_at) > 45 * 60000;
  const sourceName = settings.source_profile.split("@")[1] || "Your TikTok";
  return (
    <div className="app-shell">
      <Refresh enabled={!preview} />
      <aside className="sidebar">
        <Link className="brand" href="/">
          <Repeat2 size={27} /> relay<span>↗</span>
        </Link>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav>
          <Link
            className={tab !== "settings" ? "nav-link active" : "nav-link"}
            href="/"
          >
            <LayoutDashboard size={18} /> Overview <span className="nav-dot" />
          </Link>
          <Link className="nav-link" href="/#up-next">
            <Clock3 size={18} /> Publishing queue{" "}
            <span className="nav-count">{counts.queue}</span>
          </Link>
          <Link
            className={tab === "settings" ? "nav-link active" : "nav-link"}
            href="/?tab=settings"
          >
            <Settings2 size={18} /> Settings
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <div className="note-orbit">
              <Repeat2 size={22} />
            </div>
            <h3>
              Create once.
              <br />
              Keep it moving.
            </h3>
            <p>
              Your videos find their next audience, while you make the next one.
            </p>
          </div>
          <Link className="guide-link" href="/setup">
            <Info size={16} /> Setup guide <ArrowUpRight size={14} />
          </Link>
          <div className="profile">
            <span className="avatar">Y</span>
            <div>
              <strong>Your workspace</strong>
              <small>Personal · Free</small>
            </div>
            {!preview && (
              <form action={logout}>
                <button className="icon-button" aria-label="Sign out">
                  <LogOut size={17} />
                </button>
              </form>
            )}
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span>
            Workspace <ChevronRight size={12} />{" "}
            {tab === "settings" ? "Settings" : "Overview"}
          </span>
          <span className="topbar-right">
            <span className="tiny-dot" /> Private workspace
          </span>
        </header>
        <div className="content">
          {preview && (
            <div className="preview-banner">
              <span>
                <Info size={15} /> Preview · sample videos, no accounts
                connected
              </span>
              <Link href="/setup">
                Set up your app <ArrowRight size={15} />
              </Link>
            </div>
          )}
          {params.notice && <div className="notice">{params.notice}</div>}
          {error && <div className="notice warning">{error}</div>}
          {counts.attention > 0 && (
            <div className="notice warning">
              <AlertCircle size={16} />
              <span>A video needs attention. Later videos will wait.</span>
              <Link href="/?tab=attention">
                Resolve issue <ArrowRight size={13} />
              </Link>
            </div>
          )}
          {stale && (
            <div className="notice warning">
              <AlertCircle size={16} /> Your worker has not checked in for over
              45 minutes. Check GitHub Actions; its schedule may be delayed or
              disabled.
            </div>
          )}
          {settings.worker_error && (
            <div className="notice warning">
              Worker needs attention:{" "}
              {settings.worker_error.replaceAll("_", " ")}
            </div>
          )}
          <section className="page-heading">
            <div>
              <span className="eyebrow">A LITTLE LESS BUSYWORK</span>
              <h1>
                {tab === "settings"
                  ? "Make it yours."
                  : "Your content, on repeat."}
              </h1>
              <p>
                {tab === "settings"
                  ? "Set the rhythm. Relay takes care of the rest."
                  : "From TikTok to your next audience. All in one place."}
              </p>
            </div>
            {tab !== "settings" && (
              <form action={togglePause}>
                <Submit className="button subtle" disabled={preview}>
                  {settings.paused ? <Play size={15} /> : <Pause size={15} />}{" "}
                  {settings.paused ? "Resume queue" : "Pause queue"}
                </Submit>
              </form>
            )}
          </section>
          {tab === "settings" ? (
            <section className="panel settings-panel">
              <div className="section-title">
                <h2>Publishing preferences</h2>
                <span className="badge neutral">
                  One source · {settings.enabled_platforms.length}{" "}
                  {settings.enabled_platforms.length === 1
                    ? "destination"
                    : "destinations"}
                </span>
              </div>
              <form action={saveSettings}>
                <h3>Post to</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    name="enabled_platforms"
                    value="youtube"
                    defaultChecked={settings.enabled_platforms.includes(
                      "youtube",
                    )}
                  />
                  <span>YouTube Shorts</span>
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    name="enabled_platforms"
                    value="instagram"
                    defaultChecked={settings.enabled_platforms.includes(
                      "instagram",
                    )}
                  />
                  <span>Instagram Reels</span>
                </label>
                <p className="muted">
                  Choose one or both. Changing destinations pauses automation
                  until you verify a post. Completed videos keep their original
                  destinations.
                </p>
                <div className="form-divider" />
                <label>
                  TikTok profile URL
                  <input
                    name="source_profile"
                    type="url"
                    placeholder="https://www.tiktok.com/@yourname"
                    defaultValue={settings.source_profile}
                    required
                  />
                </label>
                <div className="field-grid">
                  <label>
                    Timezone
                    <input
                      name="timezone"
                      defaultValue={settings.timezone}
                      required
                    />
                  </label>
                  <label>
                    Start hour
                    <input
                      name="start_hour"
                      type="number"
                      min="0"
                      max="23"
                      defaultValue={settings.start_hour}
                      required
                    />
                  </label>
                  <label>
                    End hour (exclusive)
                    <input
                      name="end_hour"
                      type="number"
                      min="1"
                      max="24"
                      defaultValue={settings.end_hour}
                      required
                    />
                  </label>
                </div>
                <div className="form-divider" />
                <h3>Your caption templates</h3>
                <p className="muted">
                  Use <code>{"{caption}"}</code>, <code>{"{first_line}"}</code>,{" "}
                  <code>{"{source_url}"}</code>, or <code>{"{video_id}"}</code>.
                  Prepared uploads keep their original text.
                </p>
                <label>
                  Instagram caption
                  <textarea
                    name="instagram_template"
                    defaultValue={settings.instagram_template}
                    rows={3}
                    required
                  />
                </label>
                <label>
                  YouTube title
                  <input
                    name="youtube_title_template"
                    defaultValue={settings.youtube_title_template}
                    required
                  />
                </label>
                <label>
                  YouTube description
                  <textarea
                    name="youtube_description_template"
                    defaultValue={settings.youtube_description_template}
                    rows={3}
                    required
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    name="youtube_audit_confirmed"
                    defaultChecked={settings.youtube_audit_confirmed}
                  />
                  <span>
                    I have completed the YouTube API project audit and confirmed
                    that API uploads can be published publicly.
                  </span>
                </label>
                <Submit disabled={preview}>
                  Save preferences <Check size={16} />
                </Submit>
              </form>
            </section>
          ) : (
            <>
              <section className="route-panel">
                <div className="route-top">
                  <span className="eyebrow">YOUR PUBLISHING ROUTE</span>
                  <span
                    className={settings.paused ? "badge neutral" : "badge mint"}
                  >
                    <span className="tiny-dot" />
                    {settings.paused ? "Automation paused" : "Automation on"}
                  </span>
                </div>
                <div className="route-flow">
                  <div className="platform-node source">
                    <div className="platform-logo tiktok">
                      <Music2 size={24} />
                    </div>
                    <div>
                      <strong>TikTok</strong>
                      <small>
                        {settings.source_profile
                          ? "@" + sourceName
                          : "Connect your source"}
                      </small>
                    </div>
                    <span className="source-tag">SOURCE</span>
                  </div>
                  <div className="route-connector">
                    <span />
                    <span className="relay-token">
                      <Repeat2 size={19} />
                    </span>
                    <span />
                    <ArrowRight size={16} />
                  </div>
                  <div className="destinations">
                    {["instagram", "youtube"].map((platform) => {
                      const connection = connections.find(
                        (c) => c.platform === platform,
                      );
                      const enabled = settings.enabled_platforms.some(
                        (p) => p === platform,
                      );
                      return (
                        <div className="platform-node" key={platform}>
                          <div className={`platform-logo ${platform}`}>
                            <Mark platform={platform} />
                          </div>
                          <div>
                            <strong>
                              {platform === "instagram"
                                ? "Instagram Reels"
                                : "YouTube Shorts"}
                            </strong>
                            <small>
                              {!enabled
                                ? "Disabled in Settings"
                                : connection?.account_id
                                  ? connection.account_label
                                  : "Not connected yet"}
                            </small>
                          </div>
                          {!enabled ? (
                            <Link
                              className="connect-button"
                              href="/?tab=settings"
                            >
                              Enable <Settings2 size={13} />
                            </Link>
                          ) : connection?.account_id ? (
                            <a
                              className="connect-button"
                              href={`/api/oauth/${platform}`}
                              aria-label={`Reconnect ${platform}`}
                            >
                              <Check size={12} /> Reconnect
                            </a>
                          ) : preview ? (
                            <span className="connect-disabled">
                              Connect <Link2 size={13} />
                            </span>
                          ) : (
                            <a
                              className="connect-button"
                              href={`/api/oauth/${platform}`}
                            >
                              Connect <Link2 size={13} />
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="route-foot">
                  <span>
                    <Clock3 size={14} /> Checks every ~15 minutes
                  </span>
                  <span>
                    <CheckCircle2 size={14} /> Watermark-free sources only
                  </span>
                  <span>
                    <Repeat2 size={14} /> Oldest first
                  </span>
                </div>
              </section>
              {settings.enabled_platforms.includes("instagram") &&
                candidates.length > 0 && (
                  <section className="panel">
                    <h2>Choose your Instagram</h2>
                    <p>
                      Choose the Facebook Page linked to the account you want to
                      publish to.
                    </p>
                    {candidates.map((c) => (
                      <form
                        className="candidate-form"
                        action={chooseInstagram}
                        key={c.id}
                      >
                        <input type="hidden" name="page_id" value={c.id} />
                        <span>
                          {c.name} ·{" "}
                          {c.instagram_business_account.username || "Instagram"}
                        </span>
                        <Submit className="button subtle">
                          Use this account
                        </Submit>
                      </form>
                    ))}
                  </section>
                )}
              <section className="stats-grid">
                <article>
                  <span>
                    In the queue <Clock3 size={16} />
                  </span>
                  <strong>{String(counts.queue).padStart(2, "0")}</strong>
                  <small>Ready for their next audience</small>
                </article>
                <article>
                  <span>
                    Published <CheckCircle2 size={16} />
                  </span>
                  <strong>{String(counts.published).padStart(2, "0")}</strong>
                  <small>Selected destinations confirmed</small>
                </article>
                <article>
                  <span>
                    Posting rhythm <Repeat2 size={16} />
                  </span>
                  <strong>
                    1 <em>hour</em>
                  </strong>
                  <small>
                    {String(settings.start_hour).padStart(2, "0")}:00–
                    {String(settings.end_hour).padStart(2, "0")}:00 ·{" "}
                    {settings.timezone.split("/").pop()}
                  </small>
                </article>
              </section>
              {!settings.integrations_verified && (
                <div className="setup-hint">
                  <div className="hint-icon">
                    <Info size={18} />
                  </div>
                  <div>
                    <strong>
                      {preview
                        ? "Your publishing routine starts here."
                        : "A few connections, then you’re ready."}
                    </strong>
                    <p>
                      Connect your selected destinations, import your TikToks,
                      and verify one post before enabling automation.
                    </p>
                  </div>
                  <Link href="/setup">
                    View setup <ArrowUpRight size={16} />
                  </Link>
                </div>
              )}
              <section className="queue-section" id="up-next">
                <div className="section-title">
                  <div>
                    <h2>
                      Up next{" "}
                      <span className="heading-count">{counts.queue}</span>
                    </h2>
                    <p>Your oldest videos get the first turn.</p>
                  </div>
                  <span className="queue-note">
                    <Clock3 size={14} /> Times are estimates
                  </span>
                </div>
                <div className="tabs">
                  {(
                    ["queue", "published", "skipped", "attention"] as const
                  ).map((t) => (
                    <Link
                      className={tab === t ? "tab selected" : "tab"}
                      key={t}
                      href={`/?tab=${t}`}
                    >
                      {t === "queue"
                        ? "Queued"
                        : t === "attention"
                          ? "Needs attention"
                          : t[0].toUpperCase() + t.slice(1)}{" "}
                      <span>{counts[t]}</span>
                    </Link>
                  ))}
                </div>
                <div className="video-list">
                  {videos.length ? (
                    videos.map((video, i) => (
                      <article className="video-row" key={video.id}>
                        <div className={`video-tile tile-${i % 3}`}>
                          <span>
                            {String(page * 25 + i + 1).padStart(2, "0")}
                          </span>
                          <Play size={14} />
                          <small>
                            {video.duration
                              ? Math.floor(video.duration) + "s"
                              : "VIDEO"}
                          </small>
                        </div>
                        <div className="video-copy">
                          <strong>
                            {video.caption.split("\n")[0] || "Untitled TikTok"}
                          </strong>
                          <p>
                            {video.reason
                              ? video.reason.replaceAll("_", " ")
                              : "From TikTok · " +
                                formatTime(
                                  video.source_created_at,
                                  settings.timezone,
                                ).split(",")[0]}
                          </p>
                          <div className="video-links">
                            {video.publications
                              .filter((p) => p.public_url)
                              .map((p) => (
                                <a
                                  key={p.platform}
                                  href={p.public_url!}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {p.platform} <ArrowUpRight size={11} />
                                </a>
                              ))}
                          </div>
                        </div>
                        <PairStatus video={video} />
                        <div className="video-time">
                          {tab === "queue" ? (
                            <>
                              <span>
                                {counts.attention > 0
                                  ? "Queue blocked"
                                  : video.publications.some(
                                        (p) =>
                                          p.required && p.state === "retry",
                                      )
                                    ? "Retry pending"
                                    : settings.paused
                                      ? "When resumed"
                                      : "Target time"}
                              </span>
                              <strong>
                                {counts.attention > 0
                                  ? "Resolve issue first"
                                  : formatTime(
                                      slots[page * 25 + i],
                                      settings.timezone,
                                    )}
                              </strong>
                            </>
                          ) : (
                            <span className="badge neutral">{video.state}</span>
                          )}
                        </div>
                        <div className="row-actions">
                          {tab !== "published" &&
                            tab !== "queue" &&
                            !preview && (
                              <form action={controlVideo}>
                                <input
                                  type="hidden"
                                  name="id"
                                  value={video.id}
                                />
                                {tab !== "queue" && (
                                  <Submit
                                    className="icon-button"
                                    disabled={preview}
                                  >
                                    <RefreshCw size={15} />
                                    <span className="sr-only">Retry video</span>
                                  </Submit>
                                )}
                                <input
                                  type="hidden"
                                  name="action"
                                  value={tab !== "queue" ? "retry" : "skip"}
                                />
                                {tab === "queue" && (
                                  <Submit className="icon-button">
                                    <SkipForward size={16} />
                                    <span className="sr-only">Skip video</span>
                                  </Submit>
                                )}
                              </form>
                            )}
                          {tab !== "published" &&
                            tab !== "skipped" &&
                            !preview && (
                              <form action={controlVideo}>
                                <input
                                  type="hidden"
                                  name="id"
                                  value={video.id}
                                />
                                <input
                                  type="hidden"
                                  name="action"
                                  value="skip"
                                />
                                <Submit className="icon-button">
                                  <SkipForward size={16} />
                                  <span className="sr-only">Skip video</span>
                                </Submit>
                              </form>
                            )}
                          {!preview && (
                            <a
                              className="icon-button"
                              href={video.source_url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label="Open original TikTok"
                            >
                              <ArrowUpRight size={17} />
                            </a>
                          )}
                        </div>
                      </article>
                    ))
                  ) : (
                    <div className="empty-state">
                      <CheckCircle2 size={28} />
                      <h3>
                        {tab === "queue"
                          ? "A clear runway."
                          : "Nothing here yet."}
                      </h3>
                      <p>
                        {tab === "queue"
                          ? "Your videos will appear here after the next successful import."
                          : "Your publishing history and any issues will appear here."}
                      </p>
                    </div>
                  )}
                </div>
                {!preview && (
                  <div className="pagination">
                    {page > 0 && (
                      <Link
                        className="text-link"
                        href={`/?tab=${tab}&page=${page - 1}`}
                      >
                        ← Previous
                      </Link>
                    )}
                    <span>Page {page + 1}</span>
                    {videos.length === 25 && (
                      <Link
                        className="text-link"
                        href={`/?tab=${tab}&page=${page + 1}`}
                      >
                        Next →
                      </Link>
                    )}
                  </div>
                )}
              </section>
              <div className="bottom-grid">
                <section className="panel rhythm-card">
                  <span className="eyebrow">STEADY IS THE STRATEGY</span>
                  <h2>
                    A rhythm that works
                    <br />
                    while you create.
                  </h2>
                  <div className="rhythm-line">
                    {Array.from({ length: 8 }, (_, i) => (
                      <span key={i} className={i === 0 ? "rhythm-now" : ""} />
                    ))}
                    <ArrowRight size={15} />
                  </div>
                  <p>
                    One video at a time. An hour to breathe.
                    <br />
                    The rest can wait until tomorrow.
                  </p>
                  <Link className="text-link" href="/?tab=settings">
                    Adjust your schedule <ArrowUpRight size={14} />
                  </Link>
                </section>
                <section className="panel activity-card">
                  <div className="section-title">
                    <h2>Recent activity</h2>
                    <span className="tiny-dot" />
                  </div>
                  {events.length ? (
                    <ul className="events">
                      {events.map((e) => (
                        <li key={e.id}>
                          <span
                            className={
                              e.level === "info"
                                ? "event-dot"
                                : "event-dot warn"
                            }
                          />
                          <div>
                            <p>{e.message}</p>
                            <small>
                              {formatTime(e.created_at, settings.timezone)}
                            </small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="activity-empty">
                      <div className="activity-orbit">
                        <RefreshCw size={20} />
                      </div>
                      <strong>Waiting for the first check-in</strong>
                      <p>Your worker’s updates will appear here.</p>
                    </div>
                  )}
                  <div className="last-check">
                    <span>Last worker check</span>
                    <strong>
                      {settings.worker_seen_at
                        ? formatTime(settings.worker_seen_at, settings.timezone)
                        : "Not started"}
                    </strong>
                  </div>
                </section>
              </div>
            </>
          )}
          <footer className="footer">
            <span>Made for creating more, uploading less.</span>
            <span>
              relay <Repeat2 size={12} />
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}
