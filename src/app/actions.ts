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
} from "@/lib/server";
import type { Settings } from "@/lib/types";
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
    const { data: connections, error: ce } = await db
      .from("credentials")
      .select("platform,account_id");
    if (
      ce ||
      connections?.filter((c) => c.account_id).length !== 2 ||
      !s.source_profile ||
      !s.youtube_audit_confirmed ||
      !s.integrations_verified ||
      !s.import_complete
    )
      feedback(
        "Complete connections, initial import, YouTube audit, and the setup test before enabling automatic posting.",
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
  const id = String(form.get("id"));
  const action = String(form.get("action"));
  if (!/^\d+$/.test(id) || !["skip", "retry"].includes(action))
    feedback("Invalid queue action.");
  const { error } = await admin().rpc("control_video", {
    p_id: id,
    p_action: action,
  });
  if (error)
    feedback("The worker may be running. Try again after it finishes.");
  revalidatePath("/");
}
export async function saveSettings(form: FormData) {
  await owner();
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
  const { error } = await db
    .from("settings")
    .update({
      source_profile,
      timezone,
      start_hour,
      end_hour,
      ...templates,
      youtube_audit_confirmed: form.get("youtube_audit_confirmed") === "on",
      ...(form.get("youtube_audit_confirmed") !== "on" ? { paused: true } : {}),
    })
    .eq("singleton", true);
  if (error) feedback("Could not save settings.");
  revalidatePath("/");
  feedback("Settings saved. Prepared uploads retain their original captions.");
}
export async function chooseInstagram(form: FormData) {
  await owner();
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
