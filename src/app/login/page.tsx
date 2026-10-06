import Link from "next/link";
import { ArrowUpRight, Repeat2 } from "lucide-react";
import { login } from "../actions";
import { Submit } from "@/components/submit";
import { configured } from "@/lib/server";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!configured()) redirect("/setup");
  const { error } = await searchParams;
  return (
    <main className="auth-page">
      <Link className="brand" href="/">
        <Repeat2 size={26} /> relay<span>↗</span>
      </Link>
      <div className="auth-card">
        <span className="eyebrow">YOUR PRIVATE WORKSPACE</span>
        <h1>Welcome back.</h1>
        <p>One upload. More places to be seen.</p>
        {error && (
          <div className="notice warning">
            {error === "owner-not-provisioned"
              ? "Your user needs to be added to app_owner. See the setup guide."
              : "Could not sign in. Check your email and password."}
          </div>
        )}
        <form action={login}>
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <Submit>
            Sign in <ArrowUpRight size={17} />
          </Submit>
        </form>
        <Link className="text-link" href="/setup">
          Need help setting things up?
        </Link>
      </div>
      <p className="auth-footer">
        A little less uploading. A lot more creating.
      </p>
    </main>
  );
}
