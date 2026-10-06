import Link from "next/link";
export function PolicyLinks() {
  return (
    <nav className="policy-links" aria-label="Policies">
      <Link href="/privacy">Privacy policy</Link>
      <Link href="/terms">Terms of use</Link>
      <a href="https://www.youtube.com/t/terms">YouTube terms</a>
    </nav>
  );
}
