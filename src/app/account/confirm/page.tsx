import { ConfirmAccountChallengeForm } from "@/components/auth/account-recovery-controls";
export const metadata = { referrer: "no-referrer" as const, robots: { index: false, follow: false } };
export default function ConfirmAccountPage() {
  return <main className="mx-auto max-w-lg space-y-6 px-4 py-12"><h1 className="text-2xl font-bold">确认账号安全操作</h1><ConfirmAccountChallengeForm /></main>;
}
