export const POLICY_VERSION = "2026-10-06";
export function policyAccepted(settings: {
  policy_version?: string | null;
  policy_accepted_at?: string | null;
}): boolean {
  return (
    settings.policy_version === POLICY_VERSION && !!settings.policy_accepted_at
  );
}
