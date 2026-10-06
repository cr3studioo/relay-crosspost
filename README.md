# Relay

One TikTok account → YouTube Shorts, Instagram Reels, or both. A private Next.js dashboard, Supabase metadata database, and a Python worker that runs on free standard GitHub Actions runners in a **public** repository. All publishing starts paused.

## What is implemented

- Complete historical discovery before normal publication; oldest first, deduplicated by TikTok ID.
- Checks every approximately 15 minutes; at least 60 minutes between video pairs, based on the latest confirmation of the previous pair.
- Europe/Prague posting window **07:00 inclusive to 21:00 exclusive**, with daylight-saving changes. No catch-up bursts after downtime.
- Square/vertical videos, 3–180 seconds, playback sources only. Known watermarked downloads, unknown source formats, unsupported codecs, photo posts and horizontal videos are skipped. No cropping, transcoding, subtitle generation or watermark-removal editing.
- Direct temporary-file uploads, private YouTube preparation, Instagram processing checks, paired publication, persistent resumable YouTube sessions and encrypted tokens.
- Retries at 15, 30, then 60 minutes. A partial failure blocks later pairs; successful destinations are never uploaded again.
- Pause/resume, retry/skip, editable captions, account reconnects, posting history, pagination, in-app errors and stale-worker detection.

**Live verification is still required.** Offline tests validate queue behavior and HTTP protocol handling, but cannot prove access to your account, watermark-free availability, Meta permissions, or YouTube public-upload approval. GitHub scheduling is approximate and TikTok retrieval uses an unofficial extractor, which can break. A source with a watermark already embedded in its original playback stream cannot be repaired by this app.

## 1. Local preview and checks

Requires Node 22+, Python 3.13+, and FFmpeg/ffprobe. From this repository:

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r worker/requirements.txt
TEST_PYTHON=.venv/bin/python npm test
.venv/bin/python -m unittest discover -s worker/tests -v
npm run build
npm run typecheck
npm run dev
```

Without configuration, the homepage is an explicitly labeled sample preview. It contains no account data and its publishing controls are disabled. With configuration, the homepage requires the provisioned owner to sign in.

## 2. Supabase Free project

1. Create a **Free** project at https://supabase.com/dashboard. Stay on the Free plan; do not enable paid add-ons.
2. Run the SQL files in [`supabase/migrations`](supabase/migrations) once in filename order in SQL Editor: first `001_relay.sql`, then the access-hardening migration. If the database was provisioned through the connected Supabase app, these are already recorded; do not run them twice.
3. In Authentication → Users, create your single email/password user. Confirm its email. Disable **Allow new users to sign up** in the project's authentication settings.
4. Copy that user's UUID and run:

```sql
insert into public.app_owner(user_id)
values ('REPLACE-WITH-YOUR-AUTH-USER-UUID');
```

5. Save the project URL, anon/publishable compatibility key, and **service_role** key from the project's API settings. Never use the service-role key in a `NEXT_PUBLIC_` variable.

Row-level security gives the owner read access to dashboard rows; browsers cannot mutate the queue or read credentials. Worker mutations use fenced, service-only PostgreSQL functions. Metadata and a rolling 30-day activity log are retained; video files are not stored in Supabase. Free projects can pause after inactivity and have no automatic backups; export the metadata periodically if you need a backup.

## 3. Vercel Hobby dashboard

Import this public repository into Vercel, select Next.js and the **Hobby** plan, and keep the repository root as the project root. No Vercel cron jobs or paid services are used.

Copy the variables from [`.env.example`](.env.example) into Vercel environment settings and into an ignored `.env.local` for local development:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable key (legacy anon keys also work) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key; server only |
| `OWNER_EMAIL` | Exactly your provisioned user's email |
| `APP_URL` | Your production `https://…vercel.app` origin, no trailing slash |
| `TOKEN_ENCRYPTION_KEY` | Shared 64-character hex key, generated below |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google web OAuth application credentials |
| `META_APP_ID`, `META_APP_SECRET` | Your Meta app credentials |
| `META_LOGIN_CONFIG_ID` | Facebook Login for Business configuration ID, when your app uses a configuration |
| `META_GRAPH_VERSION` | `v25.0` (or a compatible supported version after testing) |

Generate the encryption key **once**, privately in your terminal:

```sh
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

Use the **same key** in Vercel and GitHub Secrets. Keep it backed up privately; changing it without migrating encrypted rows makes existing connections and upload sessions unreadable. Restart/redeploy after changing environment variables.

## 4. Social account setup

### Instagram / Meta (only if selected)

1. Switch your Instagram account to **Creator or Business**, and link a Facebook Page you administer. The app will not post to that Page.
2. Create a Meta developer app and configure the Instagram API with **Facebook Login for Business** so direct resumable file uploads are available. If you create a Login for Business configuration, choose a user access token, include the permissions listed below, and set its ID as `META_LOGIN_CONFIG_ID` in Vercel. Relay exchanges the returned authorization code on the server.
3. Add this exact valid OAuth redirect URI:

```text
https://YOUR-APP.vercel.app/api/oauth/instagram/callback
```

4. Grant your app owner/admin access to the Page and Instagram asset. The app requests `pages_show_list`, `pages_read_engagement`, `instagram_basic`, and `instagram_content_publish`. Your own account may use the app's available Standard Access; complete any review or verification Meta requires for your particular app/account configuration. Do not assume development access is sufficient until an actual publishing test passes.
5. In Relay, click **Connect** for Instagram. If several Pages are available, choose the one linked to your intended account.

Direct upload reference: https://github.com/fbsamples/reels_publishing_apis/blob/main/insta_reels_publishing_api_sample/README.md

### YouTube / Google

1. Create a Google Cloud project and enable **YouTube Data API v3**. Create an OAuth **Web application** client.
2. Configure the consent screen for your personal app and register:

```text
https://YOUR-APP.vercel.app/api/oauth/youtube/callback
```

3. Configure the consent screen's production status appropriately for unattended refresh tokens. External apps left in Testing can have refresh tokens expire after seven days; scope verification and the YouTube upload audit are separate requirements. Follow the requirements Google presents for your project.
4. Read and accept Relay’s privacy policy and terms, then connect the intended YouTube channel in Relay. It requests `youtube.force-ssl` because it must upload, read processing status, and update an existing video's privacy without uploading a second copy. The worker uses the resulting refresh token.
5. **Complete the YouTube API project audit for public uploads.** New unaudited API projects can be restricted to private uploads. After confirming public API publication is allowed, tick the audit confirmation in Relay Settings. The app does not bypass private-only restrictions.

Audit requirement: https://developers.google.com/youtube/v3/docs/videos/insert

The app has one fixed destination per platform. Reconnection must select the same Instagram account and YouTube channel; deliberate destination changes require a history reset rather than silently reusing another account's upload IDs.

## Privacy, visibility and revocation

Public policy pages are available at `/privacy` and `/terms`; login and the dashboard link to both. The privacy contact defaults to `OWNER_EMAIL`; set `PRIVACY_CONTACT_EMAIL` to a suitable public business contact if different. Owner consent is versioned and must be accepted before account connections, discovery, uploads or queue controls. Accepting policies leaves automation paused.

YouTube visibility supports public, unlisted and private. Uploads begin privately for processing, then the worker applies the chosen visibility to the known upload ID. Changing visibility affects unfinished/future uploads, pauses automation and resets setup verification. Completed videos are not changed. Manually making an upload public in Studio does not verify Relay's publishing integration or Google's audit approval.

**Disconnect YouTube and delete data** pauses automation, requests Google token revocation and clears stored YouTube account identifiers, upload/session IDs, links and rendered metadata. If Google is unavailable, encrypted tokens remain only for revocation retries, with a seven-day expiry. Previously completed TikTok IDs and Relay's own completion facts remain to prevent duplicates. Incomplete uploads that lost their identifiers require review and skipping; Retry cannot create a duplicate from a deleted reference. YouTube-hosted videos are never deleted by this control.

Each worker run checks authorization even when paused. A confirmed `invalid_grant` clears authorized data; temporary network failures do not. The worker attempts weekly refreshes of channel names and video visibility in batches of 50 references. Stale references expire after 30 days. Cleanup needs a running worker; restart after downtime or have the operator delete data through the server. Activity events expire after 30 days. Browser roles cannot execute consent, deletion, refresh or preference RPCs directly.

## 5. GitHub worker secrets and retrieval probe

In repository Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Same project URL as the dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | Same service-role key |
| `TOKEN_ENCRYPTION_KEY` | Same hex key as Vercel |
| `GOOGLE_CLIENT_ID` | Same Google client ID |
| `GOOGLE_CLIENT_SECRET` | Same Google client secret |
| `TIKTOK_PROFILE_URL` | Optional: profile bound to the account-ID hint below |
| `TIKTOK_CHANNEL_ID` | Optional: yt-dlp's public `channel_id` for that same profile |

Meta account tokens are encrypted in Supabase by the dashboard; the worker does not need the Meta app secret. Never enable verbose HTTP or yt-dlp debug logging in a public Actions run.

Open **Actions → Publishing worker → Run workflow**:

1. Choose `probe`, supply your public TikTok profile URL, and optionally one exact video URL from it.
2. The probe enumerates the history, downloads one candidate, checks it with ffprobe, reports results without printing URLs or tokens, and deletes the local file. **It does not upload or publish anything.**
3. If this fails on GitHub, run the same probe locally:

```sh
.venv/bin/python -m worker.main probe --profile https://www.tiktok.com/@YOURNAME
```

Updating `yt-dlp` may be needed after TikTok changes; update its pinned version in `worker/requirements.txt`, run the tests, and repeat the probe. The app does not automatically bypass login requirements or use paid downloader services. If GitHub's network is blocked but your home network works, use the local worker below.

If only profile resolution fails, yt-dlp supports looking up the same public account with `tiktokuser:channel_id`. Resolve `channel_id` on a working network, then configure the optional paired secrets above. The worker validates every returned post's uploader URL against the configured profile and stops on a mismatch. This lookup still requires TikTok's video API and downloads to be reachable from the runner. See the [official TikTok extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py).

## 6. Import, verify one post, then resume

1. Sign in to Relay, read and accept the current policies, and save your exact public TikTok profile URL in Settings. Select YouTube, Instagram, or both, and connect only those destinations. Configure templates and YouTube visibility. Confirm the audit only after Google approves public/unlisted API uploads. Publishing remains paused.
2. Run the worker in `tick` mode. It imports the full history. If a run ends at its time budget, discovered IDs remain saved; subsequent runs avoid re-writing them and continue until enumeration completes. No normal posting starts before a complete import.
3. Choose **one queued eligible TikTok** as the real publishing test. Its TikTok ID is the number in its original URL. Run `verify` with that `video_id`, during your posting window. This intentionally completes that single selected video at your chosen visibility on the selected destinations, even while the normal queue is paused. Public and unlisted YouTube publication require audit approval; choosing private permits a private-only test.
4. If processing requires several checks, rerun **verify with the same ID**. The same stored upload/container IDs are reused. The chosen video is recorded as published and will not be reposted by the backlog.
5. Once publications to every selected destination are confirmed, `integrations_verified` becomes true. Click **Resume queue** in Relay. Later scheduled runs post the oldest remaining eligible videos, with the hourly gap.

YouTube-only mode requires no Meta application, Instagram connection, or Instagram processing. Changing destinations pauses automation and requires a fresh verification with a queued video. The change applies to unfinished videos; completed videos keep their original targets and successful upload IDs. Enabling Instagram later does not backfill videos already completed on YouTube. Destination changes are blocked while the worker holds its lease so they cannot race an upload.

Changing caption templates affects uploads that have not been prepared yet. Each destination freezes its rendered text when its upload starts. YouTube titles are trimmed to 100 characters; captions/descriptions that exceed destination limits require a template change and retry rather than silent text loss.

The defaults mark all YouTube uploads **not made for children** and **not realistic synthetic media**. These match the agreed use case. If the content changes to require different audience or promotional disclosures, pause automation and update the implementation before publishing it.

## Failure recovery

- **Network/rate limits:** automatic 15/30/60-minute backoff, capped at one hour. Publication attempts stay inside the window; retries do not erase successful posts.
- **Authorization expired:** reconnect the same account from its reconnect link, then retry the affected item. Later pairs wait.
- **Permanent processing or publication rejection:** the queue stalls in Needs attention. Resolve the cause, then Retry, or Skip to allow the next video through. Skipping an item never deletes an already published post or private staged copy.
- **YouTube final upload response lost:** the stored resumable session is queried; a completed upload's ID is recovered instead of inserting another video. Changed source bytes are flagged rather than attached to an existing upload session.
- **YouTube publication response lost:** query the known video's privacy status. Repeating a privacy change on that same ID cannot create another copy.
- **Instagram publication response lost:** query the known container. If it reports PUBLISHED but the response containing the media ID was lost, the app stops with `published_id_needs_reconciliation`. If the outcome is still ambiguous it also stops. Inspect Instagram, then Skip the item once you have accounted for the existing post; Retry will continue reconciliation, never blindly publish another copy. A permalink lookup failure after an acknowledged publish does not cause a repost.
- **Worker hasn't checked in:** a warning appears after 45 minutes when you open the dashboard. Inspect Actions runs. GitHub can delay/drop schedules and disables public-repository schedules after 60 days without repository activity. Re-enable the workflow or make a legitimate repository update. No external emails are sent by the app.

## Local worker fallback

The local worker uses the same database and dashboard. Save the worker's secrets in the ignored `.env.local` (the dashboard's `NEXT_PUBLIC_SUPABASE_URL` is accepted as its URL), then:

```sh
.venv/bin/python -m worker.local local
```

It checks approximately every 15 minutes. Keep the computer awake and online. **Disable the GitHub Publishing worker schedule** if using the local worker as your permanent replacement. The database lease also prevents two simultaneous workers from operating on the queue. On Windows, use `.venv\Scripts\python.exe` for Python commands.

For an operating-system scheduler, invoke `.venv/bin/python -m worker.local tick` every 15 minutes with this repository as its working directory. Each invocation reloads private settings, checks once, and exits. Verify one selected setup-test video locally with `.venv/bin/python -m worker.local verify --video-id TIKTOK_ID`; this creates real posts, so choose the ID deliberately. No new video is published while normal automation is paused.

## Free-tier and scheduling limits

- Keep the GitHub repository public and use only standard GitHub-hosted runners. Private repositories have metered included minutes; do not move this worker to paid runners.
- No persistent video hosting, Redis, paid cron service or AI API is required. Supabase only stores metadata and encrypted credentials. Stay on its Free plan and Vercel Hobby; if a provider limit is reached, stop/reduce usage rather than upgrade automatically.
- Both destinations are prepared before publication requests start together. Visibility can differ because of platform processing and API/network delays. Every target time in the UI is an estimate, not an exact promise.
- When a platform fails, preserving order and avoiding duplicates takes precedence over simultaneous visibility. The next pair waits for the failed pair's latest confirmation, then an additional hour.
- Built-in Vercel Hobby scheduling is not used: https://vercel.com/docs/cron-jobs/usage-and-pricing
- GitHub standard public runners: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- GitHub scheduled workflow behavior: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- Shorts classification: https://support.google.com/youtube/answer/15424877

## Repository layout

```text
src/                     Next.js dashboard, server actions, owner auth and OAuth
supabase/migrations/     Schema, RLS, queue controls and fenced worker RPCs
worker/                  Downloader, scheduling engine and platform clients
tests/                   Real PostgreSQL migration/security tests and Node tests
worker/tests/            Queue simulations and platform HTTP recovery tests
.github/workflows/       Free scheduler and CI (neither contains credentials)
```

The test suite does not contact TikTok, Meta, or YouTube. Publishing integration tests require your own connected accounts and a chosen sample, as described above.
