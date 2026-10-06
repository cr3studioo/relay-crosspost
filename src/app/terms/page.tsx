import Link from "next/link";
import { PolicyLinks } from "@/components/policy-links";
import { POLICY_VERSION } from "@/lib/policy";
export default function Terms() {
  return (
    <main className="setup-page policy-page">
      <Link className="text-link" href="/">
        ← Back to Relay
      </Link>
      <h1>Relay terms of use</h1>
      <p className="lead">
        Effective {POLICY_VERSION}. Relay is a free tool for the provisioned
        owner to repost their own videos to accounts they authorize.
      </p>
      <h2>Your content and choices</h2>
      <p>
        You must own or have permission to publish your videos, captions and
        audio on each selected destination. A music license available on TikTok
        may not permit reuse on YouTube or Instagram. You are responsible for
        accurate audience and disclosure settings. This installation is
        configured for general-audience short videos, not made for children,
        without paid promotion or realistic synthetic-media disclosures. Pause
        automation if those assumptions no longer fit your content.
      </p>
      <p>
        Choose destinations, title and description templates, and YouTube
        visibility in Settings. Relay first uploads privately for processing,
        then applies your selected public, unlisted or private visibility at the
        scheduled completion time. Visibility choices apply to unfinished and
        future Relay uploads; completed videos are not changed automatically.
        Saving a changed visibility pauses the queue and requires a new setup
        test. Resuming authorizes automated uploads and visibility updates to
        the displayed channel using these preferences. You can pause, retry or
        skip items.
      </p>
      <h2>Platform terms</h2>
      <p>
        By using Relay’s YouTube features, you agree to be bound by the{" "}
        <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>.
        You must also follow the terms and content policies of TikTok and any
        connected Instagram account. Relay uses official destination APIs and
        does not bypass platform restrictions or remove watermarks. Google’s
        audit approval is required before this project may make API uploads
        public or unlisted.
      </p>
      <h2>Operation and availability</h2>
      <p>
        Relay checks roughly every 15 minutes and starts queued videos at least
        one hour apart during your configured posting window. Processing,
        scheduler delays, network failures and platform limits can change actual
        times. A local worker requires the computer to remain awake and
        connected. A failure on one selected destination delays later videos;
        successful destinations are retained. The app does not guarantee exact
        simultaneous publication or uninterrupted availability. It does not
        purchase paid plans or charge subscriptions.
      </p>
      <h2>Privacy and ending access</h2>
      <p>
        The <Link href="/privacy">privacy policy</Link> describes data use and
        deletion. Disconnecting YouTube revokes access and clears Relay’s
        YouTube references, with retries if Google is unavailable. It leaves
        videos held by YouTube in place. Completed source IDs remain recorded to
        prevent duplicates. Keep credentials private and pause the worker before
        changing the application’s accounts or deployment.
      </p>
      <PolicyLinks />
    </main>
  );
}
