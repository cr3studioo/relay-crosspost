"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  admin,
  owner,
  sessionClient,
  env,
  decrypt,
  encrypt,
  requirePolicy,
} from "@/lib/server";
import { POLICY_VERSION } from "@/lib/policy";
import { randomUUID } from "node:crypto";
import type { Platform, Settings } from "@/lib/types";
function feedback(message: string): never {
  redirect("/?notice=" + encodeURIComponent(message));
}
export async function login(form: FormData) {
  const email = String(form.get("email") || "").trim();
  if (email.toLowerCase() !== env("OWNER_EMAIL").toLowerCase())
    redirect("/login?error=invalid-login");
  const db = await sessionClient();
  const { error } = await db.auth.signInWithPassword({
    email,
    password: String(form.get("password") || ""),
  });
  if (error) redirect("/login?error=invalid-login");
  redirect("/");
}
export async function logout() {
  await owner();
  const db = await sessionClient();
  await db.auth.signOut();
  redirect("/login");
}
export async function togglePause() {
  await owner();
  const db = admin();
  const { data, error } = await db.from("settings").select("*").single();
  if (error) feedback("Could not load settings.");
  const s = data as Settings;
  if (s.paused) {
    await requirePolicy();
    const { data: connections, error: ce } = await db
      .from("credentials")
      .select("platform,account_id");
    if (
      ce ||
      !s.enabled_platforms.every((platform) =>
        connections?.some((c) => c.platform === platform && c.account_id),
      ) ||
      !s.source_profile ||
      (s.enabled_platforms.includes("youtube") &&
        s.youtube_visibility !== "private" &&
        !s.youtube_audit_confirmed) ||
      s.youtube_revoke_requested_at ||
      !s.integrations_verified ||
      !s.import_complete
    )
      feedback(
        "Connect your selected destinations, finish the initial import and setup test, and confirm the YouTube audit if YouTube is selected.",
      );
  }
  const result = await db
    .from("settings")
    .update({ paused: !s.paused })
    .eq("singleton", true);
  if (result.error) feedback("Could not change the queue.");
  revalidatePath("/");
}
export async function controlVideo(form: FormData) {
  await owner();
  await requirePolicy();
  const id = String(form.get("id"));
  const action = String(form.get("action"));
  if (!/^\d+$/.test(id) || !["skip", "retry"].includes(action))
    feedback("Invalid queue action.");
  const { error } = await admin().rpc("control_video", {
    p_id: id,
    p_action: action,
  });
  if (error)
    feedback(
      error.message.includes("references were deleted")
        ? "YouTube data was deleted. Check your channel, then skip this item to avoid a duplicate upload."
        : "The worker may be running. Try again after it finishes.",
    );
  revalidatePath("/");
}
export async function saveSettings(form: FormData) {
  await owner();
  await requirePolicy();
  const youtube_visibility = String(form.get("youtube_visibility") || "");
  if (!["public", "private", "unlisted"].includes(youtube_visibility))
    feedback("Choose a YouTube visibility setting.");
  const enabled_platforms = (["instagram", "youtube"] as Platform[]).filter(
    (platform) => form.getAll("enabled_platforms").includes(platform),
  );
  if (!enabled_platforms.length) feedback("Select at least one destination.");
  const source_profile = String(form.get("source_profile") || "")
    .trim()
    .replace(/\/$/, "");
  if (
    !/^https:\/\/www\.tiktok\.com\/@[a-zA-Z0-9_.]{2,24}$/.test(source_profile)
  )
    feedback(
      "Enter a full public profile URL, such as https://www.tiktok.com/@yourname.",
    );
  const start_hour = Number(form.get("start_hour")),
    end_hour = Number(form.get("end_hour"));
  const timezone = String(form.get("timezone") || "");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    feedback("Choose a valid timezone.");
  }
  if (
    !Number.isInteger(start_hour) ||
    !Number.isInteger(end_hour) ||
    start_hour < 0 ||
    end_hour > 24 ||
    start_hour >= end_hour
  )
    feedback(
      "The posting window must start before it ends, within the same day.",
    );
  const templates = {
    instagram_template: String(form.get("instagram_template") || ""),
    youtube_title_template: String(form.get("youtube_title_template") || ""),
    youtube_description_template: String(
      form.get("youtube_description_template") || "",
    ),
  };
  for (const value of Object.values(templates)) {
    if (
      !value.trim() ||
      value.length > 5000 ||
      /\{(?!caption\}|first_line\}|source_url\}|video_id\})[^}]*\}/.test(value)
    )
      feedback(
        "Use nonempty templates with {caption}, {first_line}, {source_url}, or {video_id}.",
      );
  }
  const db = admin();
  const { data: old } = await db
    .from("settings")
    .select("source_profile")
    .single();
  if (old?.source_profile && old.source_profile !== source_profile)
    feedback(
      "Changing TikTok accounts requires a deliberate history reset. This app is configured for one source account.",
    );
  const { error } = await db.rpc("save_preferences", {
    p_patch: {
      source_profile,
      timezone,
      start_hour,
      end_hour,
      ...templates,
      enabled_platforms,
      youtube_visibility,
      youtube_audit_confirmed: form.get("youtube_audit_confirmed") === "on",
    },
  });
  if (error)
    feedback(
      "Could not save settings. If the worker is running, try again after it finishes.",
    );
  revalidatePath("/");
  feedback("Settings saved. Prepared uploads retain their original captions.");
}
export async function chooseInstagram(form: FormData) {
  await owner();
  await requirePolicy();
  const db = admin();
  const { data } = await db
    .from("credentials")
    .select("encrypted_payload")
    .eq("platform", "instagram")
    .single();
  if (!data) feedback("Connect Instagram first.");
  const payload = decrypt<{
    access_token: string;
    expires_at: string;
    candidates: Array<{
      id: string;
      name: string;
      instagram_business_account: { id: string; username?: string };
    }>;
  }>(data.encrypted_payload);
  const candidate = payload.candidates?.find(
    (c) => c.id === String(form.get("page_id")),
  );
  if (!candidate?.instagram_business_account)
    feedback("That Page was not part of your authorized connection.");
  const { error } = await db.from("credentials").upsert({
    platform: "instagram",
    account_id: candidate.instagram_business_account.id,
    account_label:
      candidate.instagram_business_account.username || candidate.name,
    encrypted_payload: encrypt({
      access_token: payload.access_token,
      expires_at: payload.expires_at,
      page_id: candidate.id,
    }),
    connected_at: new Date().toISOString(),
  });
  if (error) feedback("Could not save the connection.");
  revalidatePath("/");
  feedback("Instagram connected.");
}

export async function acceptPolicy(form: FormData) {
  await owner();
  if (
    form.get("accept_policy") !== "on" ||
    form.get("policy_version") !== POLICY_VERSION
  )
    redirect("/consent?error=Please+read+and+accept+the+current+policies.");
  const { error } = await admin().rpc("accept_policy", {
    p_version: POLICY_VERSION,
  });
  if (error) redirect("/consent?error=Could+not+save+your+choice.+Try+again.");
  revalidatePath("/");
  redirect(
    "/?tab=settings&notice=" +
      encodeURIComponent(
        "Policies accepted. Review your publishing preferences; the queue is paused.",
      ),
  );
}

export async function disconnectYouTube(form: FormData) {
  await owner();
  if (form.get("confirm_disconnect") !== "on")
    feedback(
      "Confirm that you want to revoke access and delete Relay’s YouTube data.",
    );
  const db = admin();
  // Pausing is safe even if an active worker currently owns the lease.
  await db.from("settings").update({ paused: true }).eq("singleton", true);
  const holder = randomUUID();
  const { data: acquired, error: leaseError } = await db.rpc("acquire_lease", {
    p_holder: holder,
  });
  if (leaseError || !acquired)
    feedback(
      "Queue paused. Wait for the current worker to finish, then disconnect again.",
    );
  let notice =
    "YouTube disconnected and Relay’s stored YouTube data deleted. Videos on YouTube remain available.";
  try {
    const { data, error } = await db
      .from("credentials")
      .select("encrypted_payload")
      .eq("platform", "youtube")
      .maybeSingle();
    if (error) throw new Error("Could not read connection");
    const token = data
      ? decrypt<{ refresh_token?: string; access_token?: string }>(
          data.encrypted_payload,
        )
      : null;
    const requested = await db.rpc("request_youtube_disconnect", {
      p_holder: holder,
    });
    if (requested.error) throw new Error("Could not record disconnection");
    let revoked = !token;
    if (token) {
      try {
        const response = await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          body: new URLSearchParams({
            token: token.refresh_token || token.access_token || "",
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
        });
        revoked =
          response.ok ||
          (response.status === 400 &&
            (await response.json()).error === "invalid_token");
      } catch {
        /* The worker will retry the revocation, with the queue paused. */
      }
    }
    if (revoked) {
      const result = await db.rpc("clear_youtube_data", {
        p_holder: holder,
        p_credentials: true,
      });
      if (result.error) throw new Error("Could not finish disconnection");
    } else
      notice =
        "Queue paused and stored YouTube references cleared. Google revocation is pending; the worker will retry. You can also remove Relay in Google account permissions.";
  } catch {
    notice =
      "Could not finish disconnection. The queue is paused; retry or remove Relay in Google account permissions.";
  } finally {
    await db.rpc("release_lease", { p_holder: holder });
  }
  revalidatePath("/");
  feedback(notice);
}
