import Link from "next/link";
import { PolicyLinks } from "@/components/policy-links";
import { POLICY_VERSION } from "@/lib/policy";
export const dynamic = "force-dynamic";
export default function Privacy() {
  const contact = process.env.PRIVACY_CONTACT_EMAIL || process.env.OWNER_EMAIL;
  return (
    <main className="setup-page policy-page">
      <Link className="text-link" href="/">
        ← Back to Relay
      </Link>
      <h1>Relay privacy policy</h1>
      <p className="lead">
        Effective {POLICY_VERSION}. Relay is a private personal tool for its
        owner, using YouTube API Services and optional Instagram publishing.
      </p>
      <h2>Information we use</h2>
      <p>
        Relay stores the owner’s login email and authentication session,
        preferences, public TikTok video IDs, captions, original dates and media
        properties. When you connect YouTube, it accesses your channel ID and
        name, OAuth access and refresh tokens, and the IDs, processing results
        and visibility of videos uploaded through Relay. It stores upload
        sessions, rendered captions, retry details and posting history to
        recover interrupted work and avoid duplicates. Optional Instagram
        connections store the authorized account and linked Page identifiers,
        tokens and publishing results.
      </p>
      <h2>Purpose and sharing</h2>
      <p>
        Relay uses this information only to import your selected source, upload
        to your selected accounts, apply your chosen visibility, show progress
        and handle failures. Video files and title/description metadata are sent
        to YouTube, and to Meta if Instagram is selected. Google’s use of
        information is covered by the{" "}
        <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.
        Vercel hosts the dashboard, Supabase provides authentication and
        database storage, and the worker runs on the owner’s computer or a
        configured GitHub Actions runner. These providers process the
        information needed to operate the app. Relay has no advertising,
        analytics trackers, data sales or AI processing.
      </p>
      <h2>Cookies and security</h2>
      <p>
        Necessary cookies maintain your Supabase login session and temporary
        OAuth authorization state. Relay does not request your Google password.
        Platform tokens and upload sessions are encrypted on the server; the
        dashboard and database restrict private information to the provisioned
        owner. Service providers may process IP addresses and technical request
        logs for hosting and security. Tokens and private account settings must
        never be committed to the public source repository.
      </p>
      <h2>Retention</h2>
      <p>
        Temporary source video files are deleted after each worker preparation
        attempt. Relay retains TikTok source metadata and its own completion
        facts to prevent duplicate reposts. While the worker is running and
        authorization remains valid, it refreshes stored YouTube account and
        video references at least weekly. References that cannot be refreshed
        are removed after 30 days. Activity events expire after 30 days. OAuth
        tokens are retained while the connection is active or briefly to
        complete a requested revocation.
      </p>
      <h2>Revoke access and delete data</h2>
      <p>
        Use “Disconnect YouTube and delete data” in Settings or on the policy
        acceptance screen. This pauses automation, sends a token revocation
        request to Google and clears Relay’s stored YouTube account and video
        references. If Google cannot be reached, the worker retries revocation;
        the encrypted token retained for this purpose is deleted within seven
        days. You can also revoke access in{" "}
        <a href="https://security.google.com/settings/security/permissions">
          Google account permissions
        </a>
        . The worker checks authorization on each run and clears YouTube data
        when Google confirms the token can no longer be refreshed. Stored
        references also expire within 30 days if checks cannot succeed.
      </p>
      <p>
        The local worker needs your computer awake and connected to perform
        checks, retries and cleanup. Run it after a long outage, or contact the
        operator for deletion while it is unavailable. These controls delete
        Relay’s data; they do not delete videos or other data held by YouTube.
        Use YouTube Studio to remove videos there. Relay retains source IDs and
        completion facts so reconnecting cannot automatically duplicate
        previously completed posts. An interrupted upload whose identifiers were
        removed requires review and skipping before later videos can continue.
      </p>
      <h2>Contact and changes</h2>
      <p>
        The app is operated by its single owner.{" "}
        {contact ? (
          <>
            For privacy questions, complaints, or deletion of additional Relay
            data, contact <a href={`mailto:${contact}`}>{contact}</a>.
          </>
        ) : (
          <>
            The operator must configure a privacy contact before using the app.
          </>
        )}{" "}
        Material changes to the purposes of data use require accepting a new
        policy version before further reposting.
      </p>
      <PolicyLinks />
    </main>
  );
}
