import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import { owner, env, encrypt, requirePolicy, admin } from "@/lib/server";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ platform: string }> },
) {
  const user = await owner();
  await requirePolicy();
  const { data: settings } = await admin()
    .from("settings")
    .select("youtube_revoke_requested_at")
    .single();
  if (settings?.youtube_revoke_requested_at)
    return NextResponse.redirect(
      new URL(
        "/?notice=" +
          encodeURIComponent(
            "Finish the pending YouTube disconnection before reconnecting.",
          ),
        _request.url,
      ),
    );
  const { platform } = await params;
  if (!["youtube", "instagram"].includes(platform))
    return new NextResponse("Unknown platform", { status: 404 });
  const required = [
    "TOKEN_ENCRYPTION_KEY",
    "APP_URL",
    ...(platform === "youtube"
      ? ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]
      : ["META_APP_ID", "META_APP_SECRET"]),
  ];
  if (required.some((name) => !process.env[name]))
    return NextResponse.redirect(
      new URL(
        "/?notice=" +
          encodeURIComponent(
            "Finish configuring this platform's application credentials first. See the setup guide.",
          ),
        _request.url,
      ),
    );
  const state = randomBytes(32).toString("hex"),
    verifier = randomBytes(48).toString("base64url");
  const callback = env("APP_URL") + `/api/oauth/${platform}/callback`;
  const jar = await cookies();
  jar.set(
    "relay_oauth_" + platform,
    encrypt({
      state,
      verifier,
      user_id: user.id,
      expires: Date.now() + 600000,
    }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: env("APP_URL").startsWith("https://"),
      path: "/",
      maxAge: 600,
    },
  );
  const url = new URL(
    platform === "youtube"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : `https://www.facebook.com/${process.env.META_GRAPH_VERSION || "v25.0"}/dialog/oauth`,
  );
  url.searchParams.set(
    "client_id",
    env(platform === "youtube" ? "GOOGLE_CLIENT_ID" : "META_APP_ID"),
  );
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (platform === "youtube") {
    url.searchParams.set(
      "scope",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    );
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    url.searchParams.set("code_challenge_method", "S256");
  } else {
    url.searchParams.set(
      "scope",
      "pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish",
    );
    if (process.env.META_LOGIN_CONFIG_ID) {
      url.searchParams.set("config_id", env("META_LOGIN_CONFIG_ID"));
      url.searchParams.set("override_default_response_type", "true");
    }
  }
  return NextResponse.redirect(url);
}
