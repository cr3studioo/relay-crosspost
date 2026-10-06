import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { seal, unseal } from "./crypto-core";
import { policyAccepted } from "./policy";
export function configured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.OWNER_EMAIL
  );
}
export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export function admin() {
  return createClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
export async function sessionClient() {
  const jar = await cookies();
  return createServerClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => jar.getAll(),
        setAll(values) {
          try {
            for (const { name, value, options } of values)
              jar.set(name, value, options);
          } catch {
            /* Proxy refreshes Server Component sessions. */
          }
        },
      },
    },
  );
}
export async function owner() {
  if (!configured()) redirect("/setup");
  const db = await sessionClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user || user.email?.toLowerCase() !== env("OWNER_EMAIL").toLowerCase())
    redirect("/login");
  const { data, error } = await db
    .from("app_owner")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !data) redirect("/login?error=owner-not-provisioned");
  return user;
}
export function encrypt(value: unknown): string {
  return seal(value, env("TOKEN_ENCRYPTION_KEY"));
}
export async function requirePolicy() {
  const { data, error } = await admin()
    .from("settings")
    .select("policy_version,policy_accepted_at")
    .single();
  if (error || !data || !policyAccepted(data)) redirect("/consent");
}
export function decrypt<T>(value: string): T {
  return unseal<T>(value, env("TOKEN_ENCRYPTION_KEY"));
}
export async function checkedFetch(url: string | URL, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("Platform request failed");
  return response.json();
}
