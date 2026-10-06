import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
async function db() {
  const pg = new PGlite();
  await pg.exec(
    `create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema public,auth to authenticated,anon,service_role; grant execute on function auth.uid() to authenticated;`,
  );
  const migrations = readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    await pg.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  return pg;
}
async function ingest(pg: PGlite, id = "123", date = "2026-10-01T00:00:00Z") {
  await pg.query("select ingest_video($1,$2::jsonb)", [
    A,
    JSON.stringify({
      id,
      source_url: `https://www.tiktok.com/@test/video/${id}`,
      source_created_at: date,
      caption: "hello",
    }),
  ]);
}
test("Migration installs and ingestion is atomic, deduplicated, and ordered by source date", async () => {
  const pg = await db();
  try {
    await pg.query("select acquire_lease($1)", [A]);
    await ingest(pg);
    await ingest(pg);
    await ingest(pg, "124", "2026-09-01T00:00:00Z");
    assert.equal(
      (
        await pg.query<{ count: number }>(
          "select count(*)::int as count from videos",
        )
      ).rows[0].count,
      2,
    );
    assert.equal(
      (
        await pg.query<{ count: number }>(
          "select count(*)::int as count from publications",
        )
      ).rows[0].count,
      4,
    );
    assert.equal(
      (
        await pg.query<{ id: string }>(
          "select id from videos order by source_created_at,id",
        )
      ).rows[0].id,
      "124",
    );
  } finally {
    await pg.close();
  }
});
test("Expired workers are fenced and cannot release a new worker's lease", async () => {
  const pg = await db();
  try {
    await pg.query("select acquire_lease($1)", [A]);
    assert.equal(
      (await pg.query<{ ok: boolean }>("select acquire_lease($1) as ok", [B]))
        .rows[0].ok,
      false,
    );
    await pg.exec(
      "update worker_lease set expires_at=now()-interval '1 minute'",
    );
    await pg.query("select acquire_lease($1)", [B]);
    await assert.rejects(ingest(pg));
    await pg.query("select release_lease($1)", [A]);
    assert.equal(
      (await pg.query<{ holder: string }>("select holder from worker_lease"))
        .rows[0].holder,
      B,
    );
  } finally {
    await pg.close();
  }
});
test("Retry cannot erase a successful destination; completion updates hourly spacing", async () => {
  const pg = await db();
  try {
    await pg.query("select acquire_lease($1)", [A]);
    await ingest(pg);
    await pg.query(
      "select update_publication($1,'123','instagram',$2::jsonb)",
      [
        A,
        JSON.stringify({
          state: "published",
          external_id: "ig123",
          published_at: "2026-10-06T10:00:00Z",
        }),
      ],
    );
    await pg.query("select update_publication($1,'123','youtube',$2::jsonb)", [
      A,
      JSON.stringify({ state: "attention", resume_state: "publishing" }),
    ]);
    await assert.rejects(pg.query("select control_video('123','retry')"));
    await pg.query("select release_lease($1)", [A]);
    await pg.query("select control_video('123','retry')");
    const rows = (
      await pg.query<{ platform: string; state: string; external_id: string }>(
        "select * from publications order by platform",
      )
    ).rows;
    assert.equal(rows[0].state, "published");
    assert.equal(rows[0].external_id, "ig123");
    assert.equal(rows[1].state, "publishing");
    await pg.query("select acquire_lease($1)", [A]);
    await pg.query("select update_publication($1,'123','youtube',$2::jsonb)", [
      A,
      JSON.stringify({
        state: "published",
        published_at: "2026-10-06T10:30:00Z",
      }),
    ]);
    assert.equal(
      (await pg.query<{ state: string }>("select state from videos")).rows[0]
        .state,
      "published",
    );
    assert.equal(
      new Date(
        (
          await pg.query<{ last_publication_at: string }>(
            "select last_publication_at from settings",
          )
        ).rows[0].last_publication_at,
      ).toISOString(),
      "2026-10-06T10:30:00.000Z",
    );
  } finally {
    await pg.close();
  }
});
test("Only the provisioned owner can read rows; browsers cannot access credentials or mutating RPCs", async () => {
  const pg = await db();
  try {
    await pg.query("insert into auth.users(id) values($1),($2)", [A, B]);
    await pg.query("insert into app_owner(user_id) values($1)", [A]);
    await pg.exec("set role anon");
    await assert.rejects(pg.query("select * from settings"));
    await assert.rejects(pg.query("select is_owner()"));
    await pg.exec("set role authenticated");
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [B]);
    assert.equal((await pg.query("select * from settings")).rows.length, 0);
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [A]);
    assert.equal((await pg.query("select * from settings")).rows.length, 1);
    await assert.rejects(pg.query("select * from credentials"));
    await assert.rejects(pg.query("select acquire_lease($1)", [A]));
    await assert.rejects(pg.query("select control_video('123','skip')"));
    await assert.rejects(
      pg.query(
        'select save_preferences(\'{"enabled_platforms":["youtube"]}\'::jsonb)',
      ),
    );
    await assert.rejects(pg.query("update settings set paused=false"));
  } finally {
    await pg.close();
  }
});
test("YouTube-only import completes after one publication and preserves completed history when Instagram is enabled", async () => {
  const pg = await db();
  try {
    await pg.query("select save_preferences($1::jsonb)", [
      JSON.stringify({ enabled_platforms: ["youtube"] }),
    ]);
    await pg.query("select acquire_lease($1)", [A]);
    await ingest(pg);
    await ingest(pg, "124");
    assert.deepEqual(
      (
        await pg.query<{ platform: string; required: boolean }>(
          "select platform,required from publications where video_id='123' order by platform",
        )
      ).rows,
      [
        { platform: "instagram", required: false },
        { platform: "youtube", required: true },
      ],
    );
    await pg.query("select update_publication($1,'123','youtube',$2::jsonb)", [
      A,
      JSON.stringify({
        state: "published",
        external_id: "yt123",
        published_at: "2026-10-06T10:00:00Z",
      }),
    ]);
    assert.equal(
      (
        await pg.query<{ state: string }>(
          "select state from videos where id='123'",
        )
      ).rows[0].state,
      "published",
    );
    await pg.query(
      "select worker_settings($1,'{\"integrations_verified\":true}'::jsonb)",
      [A],
    );
    await assert.rejects(
      pg.query(
        'select save_preferences(\'{"enabled_platforms":["instagram","youtube"]}\'::jsonb)',
      ),
    );
    await pg.query("select release_lease($1)", [A]);
    await pg.query(
      'select save_preferences(\'{"enabled_platforms":["instagram","youtube"]}\'::jsonb)',
    );
    const preferences = (
      await pg.query<{ paused: boolean; integrations_verified: boolean }>(
        "select paused,integrations_verified from settings",
      )
    ).rows[0];
    assert.deepEqual(preferences, {
      paused: true,
      integrations_verified: false,
    });
    assert.equal(
      (
        await pg.query<{ required: boolean }>(
          "select required from publications where video_id='123' and platform='instagram'",
        )
      ).rows[0].required,
      false,
    );
    assert.equal(
      (
        await pg.query<{ required: boolean }>(
          "select required from publications where video_id='124' and platform='instagram'",
        )
      ).rows[0].required,
      true,
    );
    await pg.query("select control_video('123','retry')");
    assert.equal(
      (
        await pg.query<{ state: string; external_id: string }>(
          "select state,external_id from publications where video_id='123' and platform='youtube'",
        )
      ).rows[0].external_id,
      "yt123",
    );
    assert.equal(
      (
        await pg.query<{ state: string }>(
          "select state from videos where id='123'",
        )
      ).rows[0].state,
      "published",
    );
  } finally {
    await pg.close();
  }
});
test("Removing a failing destination clears its blockage, but retains confirmed publications and their spacing", async () => {
  const pg = await db();
  try {
    await pg.query("select acquire_lease($1)", [A]);
    await ingest(pg);
    await pg.query("select update_publication($1,'123','youtube',$2::jsonb)", [
      A,
      JSON.stringify({
        state: "published",
        external_id: "yt123",
        published_at: "2026-10-06T10:00:00Z",
      }),
    ]);
    await pg.query(
      'select update_publication($1,\'123\',\'instagram\',\'{"state":"attention","error_code":"account_not_connected"}\'::jsonb)',
      [A],
    );
    await pg.query(
      "select update_video($1,'123','attention','account_not_connected')",
      [A],
    );
    await pg.query("select release_lease($1)", [A]);
    await pg.query(
      'select save_preferences(\'{"enabled_platforms":["youtube"]}\'::jsonb)',
    );
    assert.deepEqual(
      (
        await pg.query<{ state: string; reason: string | null }>(
          "select state,reason from videos where id='123'",
        )
      ).rows[0],
      { state: "published", reason: null },
    );
    assert.equal(
      new Date(
        (
          await pg.query<{ last_publication_at: string }>(
            "select last_publication_at from settings",
          )
        ).rows[0].last_publication_at,
      ).toISOString(),
      "2026-10-06T10:00:00.000Z",
    );
    await pg.query("select control_video('123','retry')");
    assert.equal(
      (
        await pg.query<{ state: string }>(
          "select state from publications where platform='instagram'",
        )
      ).rows[0].state,
      "attention",
    );
  } finally {
    await pg.close();
  }
});
test("Destination settings reject empty, duplicate, and unsupported target sets", async () => {
  const pg = await db();
  try {
    for (const enabled_platforms of [
      [],
      ["youtube", "youtube"],
      ["tiktok"],
      ["youtube", null],
    ]) {
      await assert.rejects(
        pg.query("select save_preferences($1::jsonb)", [
          JSON.stringify({ enabled_platforms }),
        ]),
      );
    }
    assert.deepEqual(
      (
        await pg.query<{ enabled_platforms: string[] }>(
          "select enabled_platforms from settings",
        )
      ).rows[0].enabled_platforms,
      ["instagram", "youtube"],
    );
  } finally {
    await pg.close();
  }
});

test("Visibility changes pause and require verification; policy consent cannot be forged by browser roles", async () => {
  const pg = await db();
  try {
    await pg.exec(
      "update settings set paused=false,integrations_verified=true",
    );
    await pg.query<Record<string, unknown>>(
      "select save_preferences($1::jsonb)",
      [JSON.stringify({ youtube_visibility: "private" })],
    );
    assert.deepEqual(
      (
        await pg.query<Record<string, unknown>>(
          "select paused,integrations_verified,youtube_visibility,policy_accepted_at from settings",
        )
      ).rows[0],
      {
        paused: true,
        integrations_verified: false,
        youtube_visibility: "private",
        policy_accepted_at: null,
      },
    );
    await assert.rejects(
      pg.query<Record<string, unknown>>(
        'select save_preferences(\'{"youtube_visibility":"secret"}\'::jsonb)',
      ),
    );
    await assert.rejects(
      pg.query<Record<string, unknown>>("select accept_policy('outdated')"),
    );
    await pg.exec("set role authenticated");
    await assert.rejects(
      pg.query<Record<string, unknown>>("select accept_policy('2026-10-06')"),
    );
    await assert.rejects(
      pg.query<Record<string, unknown>>("select clear_youtube_data($1,true)", [
        A,
      ]),
    );
    await assert.rejects(
      pg.query<Record<string, unknown>>(
        "select save_base_preferences('{}'::jsonb)",
      ),
    );
    await pg.exec("reset role");
    await pg.query<Record<string, unknown>>(
      "select accept_policy('2026-10-06')",
    );
    assert.ok(
      (
        await pg.query<Record<string, unknown>>(
          "select policy_accepted_at from settings",
        )
      ).rows[0].policy_accepted_at,
    );
  } finally {
    await pg.close();
  }
});

test("Disconnect clears authorized data, preserves completed source history and blocks retries after lost identifiers", async () => {
  const pg = await db();
  try {
    await pg.query<Record<string, unknown>>(
      'select save_preferences(\'{"enabled_platforms":["youtube"]}\'::jsonb)',
    );
    await pg.query<Record<string, unknown>>("select acquire_lease($1)", [A]);
    await ingest(pg, "123");
    await ingest(pg, "124");
    await ingest(pg, "125");
    await pg.exec(
      "insert into credentials(platform,account_id,account_label,encrypted_payload) values('youtube','channel','test','encrypted')",
    );
    await pg.query<Record<string, unknown>>(
      "select update_publication($1,'123','youtube',$2::jsonb)",
      [
        A,
        JSON.stringify({
          state: "published",
          external_id: "completed",
          public_url: "https://example.invalid",
          published_at: "2026-10-06T10:00:00Z",
        }),
      ],
    );
    await pg.query<Record<string, unknown>>(
      "select update_publication($1,'124','youtube',$2::jsonb)",
      [
        A,
        JSON.stringify({
          state: "publishing",
          external_id: "uncertain",
          encrypted_session: "encrypted",
          rendered_metadata: { title: "hello" },
        }),
      ],
    );
    await pg.query<Record<string, unknown>>(
      "select request_youtube_disconnect($1)",
      [A],
    );
    assert.ok(
      (
        await pg.query<Record<string, unknown>>(
          "select youtube_revoke_requested_at from settings",
        )
      ).rows[0].youtube_revoke_requested_at,
    );
    assert.equal(
      (
        await pg.query<Record<string, unknown>>(
          "select encrypted_payload from credentials",
        )
      ).rows[0].encrypted_payload,
      "encrypted",
    );
    assert.equal(
      (
        await pg.query<Record<string, unknown>>(
          "select account_id from credentials",
        )
      ).rows[0].account_id,
      null,
    );
    await pg.query<Record<string, unknown>>(
      "select clear_youtube_data($1,true)",
      [A],
    );
    assert.equal(
      (await pg.query<Record<string, unknown>>("select * from credentials"))
        .rows.length,
      0,
    );
    const pubs = (
      await pg.query<Record<string, unknown>>(
        "select state,external_id,encrypted_session,rendered_metadata,public_url from publications where platform='youtube' order by video_id",
      )
    ).rows;
    assert.equal(pubs[0].state, "published");
    assert.equal(pubs[1].state, "attention");
    assert.equal(pubs[2].state, "pending");
    for (const pub of pubs) {
      assert.equal(pub.external_id, null);
      assert.equal(pub.encrypted_session, null);
      assert.equal(pub.rendered_metadata, null);
      assert.equal(pub.public_url, null);
    }
    assert.equal(
      (
        await pg.query<Record<string, unknown>>(
          "select state from videos where id='123'",
        )
      ).rows[0].state,
      "published",
    );
    assert.equal(
      (
        await pg.query<Record<string, unknown>>(
          "select state from videos where id='124'",
        )
      ).rows[0].state,
      "attention",
    );
    await pg.query<Record<string, unknown>>("select release_lease($1)", [A]);
    await assert.rejects(
      pg.query<Record<string, unknown>>("select control_video('124','retry')"),
    );
    await pg.query<Record<string, unknown>>(
      "select control_video('124','skip')",
    );
    await pg.query<Record<string, unknown>>("select acquire_lease($1)", [A]);
    await ingest(pg, "123");
    assert.equal(
      (
        await pg.query<Record<string, unknown>>(
          "select state from videos where id='123'",
        )
      ).rows[0].state,
      "published",
    );
  } finally {
    await pg.close();
  }
});

test("Stale API references expire without creating reupload candidates; lost leases cannot erase data", async () => {
  const pg = await db();
  try {
    await pg.query<Record<string, unknown>>("select acquire_lease($1)", [A]);
    await ingest(pg);
    await pg.query<Record<string, unknown>>(
      "select update_publication($1,'123','youtube',$2::jsonb)",
      [A, JSON.stringify({ state: "ready", external_id: "old-upload" })],
    );
    await pg.exec(
      "update publications set api_checked_at=now()-interval '31 days' where platform='youtube'",
    );
    await assert.rejects(
      pg.query<Record<string, unknown>>("select expire_youtube_data($1)", [B]),
    );
    assert.equal(
      (
        await pg.query<Record<string, unknown>>(
          "select external_id from publications where platform='youtube'",
        )
      ).rows[0].external_id,
      "old-upload",
    );
    await pg.query<Record<string, unknown>>("select expire_youtube_data($1)", [
      A,
    ]);
    assert.equal(
      (
        await pg.query<Record<string, unknown>>(
          "select state,external_id from publications where platform='youtube'",
        )
      ).rows[0].state,
      "attention",
    );
    assert.equal(
      (
        await pg.query<Record<string, unknown>>(
          "select external_id from publications where platform='youtube'",
        )
      ).rows[0].external_id,
      null,
    );
    await pg.exec(
      "insert into credentials(platform,account_id,account_label,encrypted_payload) values('youtube',null,'pending','encrypted'); update settings set youtube_revoke_requested_at=now()-interval '8 days'",
    );
    await pg.query<Record<string, unknown>>("select expire_youtube_data($1)", [
      A,
    ]);
    assert.equal(
      (await pg.query<Record<string, unknown>>("select * from credentials"))
        .rows.length,
      0,
    );
    assert.equal(
      (await pg.query<Record<string, unknown>>("select paused from settings"))
        .rows[0].paused,
      true,
    );
  } finally {
    await pg.close();
  }
});
