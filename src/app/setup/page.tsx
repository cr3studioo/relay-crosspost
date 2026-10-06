import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Repeat2 } from "lucide-react";
const steps = [
  [
    "Create your database",
    "Create a Supabase Free project. Run the SQL files in supabase/migrations in filename order in its SQL Editor. Create your single email/password user under Authentication, disable sign-ups, and insert that user's UUID into app_owner.",
  ],
  [
    "Deploy the dashboard",
    "Import this repository into Vercel on Hobby. Add the variables from .env.example, set APP_URL to the production HTTPS address, and redeploy. Use the same encryption key in the dashboard and worker.",
  ],
  [
    "Connect your accounts",
    "Choose YouTube, Instagram, or both in Settings. For YouTube, configure Google and connect your channel. For Instagram, use a Creator or Business account linked to a Facebook Page and configure Meta. Only selected destinations need to be connected.",
  ],
  [
    "Start the free worker",
    "Add the worker's secrets to GitHub Actions. Run the retrieval probe, set your TikTok profile in Settings, and run the worker to import the history. The queue stays paused.",
  ],
  [
    "Verify one post",
    "If YouTube is selected, complete its API public-upload audit and confirm it in Settings. Run Verify with one chosen queued TikTok ID. Once publication to your selected destinations succeeds, resume the queue in the dashboard.",
  ],
];
export default function Setup() {
  return (
    <main className="setup-page">
      <Link className="brand dark-brand" href="/">
        <Repeat2 size={26} /> relay<span>↗</span>
      </Link>
      <Link className="text-link" href="/">
        <ArrowLeft size={15} /> Back to dashboard
      </Link>
      <span className="eyebrow">LET’S GET YOU CONNECTED</span>
      <h1>Your free publishing setup.</h1>
      <p className="lead">
        Five steps, then your videos can take it from here.
        <br />
        The repository’s README includes the exact commands and environment
        variables.
      </p>
      <div className="setup-steps">
        {steps.map(([title, description], i) => (
          <article key={title}>
            <span className="step-number">0{i + 1}</span>
            <div>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
          </article>
        ))}
      </div>
      <div className="panel">
        <h2>OAuth callback URLs</h2>
        <p>
          Replace YOUR-APP with your Vercel production domain. These must
          exactly match your developer app configuration.
        </p>
        <code>https://YOUR-APP.vercel.app/api/oauth/youtube/callback</code>
        <code>https://YOUR-APP.vercel.app/api/oauth/instagram/callback</code>
      </div>
      <div className="notice">
        A public GitHub repository keeps standard worker runs free. Your tokens
        belong in server environment variables and GitHub Secrets.
      </div>
      <div className="setup-links">
        <a
          href="https://supabase.com/dashboard"
          target="_blank"
          rel="noreferrer"
        >
          Supabase <ArrowUpRight size={15} />
        </a>
        <a href="https://vercel.com/new" target="_blank" rel="noreferrer">
          Vercel <ArrowUpRight size={15} />
        </a>
        <a
          href="https://console.cloud.google.com/"
          target="_blank"
          rel="noreferrer"
        >
          Google Cloud <ArrowUpRight size={15} />
        </a>
        <a
          href="https://developers.facebook.com/apps/"
          target="_blank"
          rel="noreferrer"
        >
          Meta apps <ArrowUpRight size={15} />
        </a>
      </div>
    </main>
  );
}
