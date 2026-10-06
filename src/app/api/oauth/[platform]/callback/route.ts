import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import {
  owner,
  env,
  encrypt,
  decrypt,
  checkedFetch,
  admin,
  requirePolicy,
} from "@/lib/server";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ platform: string }> },
) {
  const user = await owner();
  await requirePolicy();
  const { platform } = await params;
  if (!["youtube", "instagram"].includes(platform))
    return new NextResponse("Unknown platform", { status: 404 });
  const redirect = (notice: string) =>
    NextResponse.redirect(
      new URL("/?notice=" + encodeURIComponent(notice), env("APP_URL")),
    );
  const jar = await cookies();
  const name = "relay_oauth_" + platform;
  const cookie = jar.get(name)?.value;
  jar.delete(name);
  try {
    if (!cookie) throw new Error("Missing authorization state");
    const saved = decrypt<{
      state: string;
      verifier: string;
      user_id: string;
      expires: number;
    }>(cookie);
    const query = new URL(request.url).searchParams;
    const state = query.get("state") || "";
    const code = query.get("code");
    if (
      saved.user_id !== user.id ||
      saved.expires < Date.now() ||
      state.length !== saved.state.length ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(saved.state)) ||
      !code
    )
      throw new Error("Invalid authorization state");
    const callback = env("APP_URL") + `/api/oauth/${platform}/callback`;
    const { data: settings } = await admin()
      .from("settings")
      .select("youtube_revoke_requested_at")
      .single();
    if (settings?.youtube_revoke_requested_at)
      return redirect(
        "Finish the pending YouTube disconnection before reconnecting.",
      );
    const { data: existing } = await admin()
      .from("credentials")
      .select("account_id")
      .eq("platform", platform)
      .maybeSingle();
    let record;
    if (platform === "youtube") {
      const token = await checkedFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          code,
          client_id: env("GOOGLE_CLIENT_ID"),
          client_secret: env("GOOGLE_CLIENT_SECRET"),
          redirect_uri: callback,
          grant_type: "authorization_code",
          code_verifier: saved.verifier,
        }),
      });
      if (
        !token.refresh_token ||
        !String(token.scope).includes("youtube.force-ssl")
      )
        throw new Error("Missing required permission");
      const channel = await checkedFetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { Authorization: `Bearer ${token.access_token}` } },
      );
      if (channel.items?.length !== 1)
        throw new Error("Select a single channel");
      record = {
        platform,
        account_id: channel.items[0].id,
        account_label: channel.items[0].snippet.title,
        encrypted_payload: encrypt({
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: new Date(
            Date.now() + token.expires_in * 1000,
          ).toISOString(),
        }),
      };
    } else {
      const base = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v25.0"}`;
      const token = await checkedFetch(base + "/oauth/access_token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: env("META_APP_ID"),
          client_secret: env("META_APP_SECRET"),
          redirect_uri: callback,
          code,
        }),
      });
      const long = await checkedFetch(base + "/oauth/access_token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: env("META_APP_ID"),
          client_secret: env("META_APP_SECRET"),
          fb_exchange_token: token.access_token,
        }),
      });
      const candidates: Array<{
        id: string;
        name: string;
        instagram_business_account: { id: string; username?: string };
      }> = [];
      let url: string | undefined =
        base +
        "/me/accounts?fields=id,name,instagram_business_account{id,username}&limit=100";
      for (let pages = 0; url && pages < 10; pages++) {
        // Reconstruct pagination URLs to prevent token-bearing URLs entering logs.
        const page = await checkedFetch(url, {
          headers: { Authorization: `Bearer ${long.access_token}` },
        });
        candidates.push(
          ...(page.data || []).filter(
            (p: { instagram_business_account?: { id: string } }) =>
              p.instagram_business_account?.id,
          ),
        );
        url = page.paging?.next
          ? base +
            "/me/accounts?fields=id,name,instagram_business_account{id,username}&limit=100&after=" +
            encodeURIComponent(page.paging.cursors.after)
          : undefined;
      }
      if (!candidates.length)
        throw new Error("No linked professional Instagram");
      const first = existing?.account_id
        ? candidates.find(
            (c) => c.instagram_business_account.id === existing.account_id,
          )
        : candidates.length === 1
          ? candidates[0]
          : null;
      if (existing?.account_id && !first)
        return redirect(
          "Reconnect the same Instagram account. Switching destinations requires a deliberate history reset.",
        );
      record = {
        platform,
        account_id: first?.instagram_business_account.id || null,
        account_label:
          first?.instagram_business_account.username ||
          first?.name ||
          "Choose your Instagram account",
        encrypted_payload: encrypt({
          access_token: long.access_token,
          expires_at: new Date(
            Date.now() + (long.expires_in || 5184000) * 1000,
          ).toISOString(),
          ...(first ? { page_id: first.id } : { candidates }),
        }),
      };
    }
    if (existing?.account_id && record.account_id !== existing.account_id)
      return redirect(
        "Reconnect the same YouTube channel. Switching destinations requires a deliberate history reset.",
      );
    const { error } = await admin()
      .from("credentials")
      .upsert({
        ...record,
        connected_at: new Date().toISOString(),
        api_checked_at: new Date().toISOString(),
      });
    if (error) throw new Error("Could not save connection");
    return redirect(
      record.account_id
        ? "Account connected."
        : "Choose the Facebook Page linked to your Instagram below.",
    );
  } catch {
    return redirect(
      "Connection failed. Check app permissions, redirect URLs, and your linked account, then try again.",
    );
  }
}
