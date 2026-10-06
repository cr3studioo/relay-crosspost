import Link from "next/link";
import { owner, admin } from "@/lib/server";
import { POLICY_VERSION, policyAccepted } from "@/lib/policy";
import { PolicyLinks } from "@/components/policy-links";
import { Submit } from "@/components/submit";
import { acceptPolicy, disconnectYouTube, logout } from "../actions";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function Consent({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await owner();
  const { data } = await admin()
    .from("settings")
    .select("policy_version,policy_accepted_at")
    .single();
  if (data && policyAccepted(data)) redirect("/");
  const { error } = await searchParams;
  return (
    <main className="auth-page">
      <Link className="brand dark-brand" href="/">
        relay ↗
      </Link>
      <section className="auth-card consent-card">
        <span className="eyebrow">REVIEW BEFORE CONTINUING</span>
        <h1>Your accounts. Your choices.</h1>
        <p>
          Relay uses YouTube API Services to upload your TikTok videos, check
          processing and apply the visibility you choose. Read the policies
          before using the dashboard. Accepting them keeps automation paused.
        </p>
        <PolicyLinks />
        {error && <div className="notice warning">{error}</div>}
        <form action={acceptPolicy}>
          <input type="hidden" name="policy_version" value={POLICY_VERSION} />
          <label className="checkbox">
            <input type="checkbox" name="accept_policy" required />
            <span>
              I have read and agree to Relay’s privacy policy and terms of use,
              including the linked YouTube Terms of Service.
            </span>
          </label>
          <Submit>Accept policies and continue</Submit>
        </form>
        <details className="disconnect-details">
          <summary>Prefer to disconnect YouTube?</summary>
          <p>
            This pauses automation, revokes Google authorization and deletes
            Relay’s YouTube references. Videos on YouTube remain in place.
            Interrupted uploads require review before retrying.
          </p>
          <form action={disconnectYouTube}>
            <label className="checkbox">
              <input type="checkbox" name="confirm_disconnect" required />
              <span>Revoke access and delete Relay’s stored YouTube data.</span>
            </label>
            <Submit className="button subtle">
              Disconnect YouTube and delete data
            </Submit>
          </form>
          <a
            className="text-link"
            href="https://security.google.com/settings/security/permissions"
          >
            Google account permissions ↗
          </a>
        </details>
        <form action={logout}>
          <Submit className="button subtle">Sign out</Submit>
        </form>
      </section>
    </main>
  );
}
