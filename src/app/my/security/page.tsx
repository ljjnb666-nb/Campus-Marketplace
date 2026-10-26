import { requireVerifiedPageUser } from "@/lib/server-auth";
import { getOwnAccountSecurity } from "@/repositories/account-security-repository";
import { PasswordChangeForm, RevokeSessionForm } from "@/components/auth/account-session-controls";
import { PageContainer } from "@/components/ui/page-container";
import { EmailVerificationControl, MfaControls } from "@/components/auth/account-recovery-controls";

export const dynamic = "force-dynamic";

export default async function AccountSecurityPage() {
  const user = await requireVerifiedPageUser();
  const { sessions, events, emailVerified, mfaEnabled } = await getOwnAccountSecurity(user.id);
  return <PageContainer><main className="mx-auto max-w-3xl space-y-8 py-8">
    <h1 className="text-2xl font-bold">账号安全</h1>
    <EmailVerificationControl verified={emailVerified} />
    <MfaControls key={String(mfaEnabled)} enabled={mfaEnabled} />
    <PasswordChangeForm />
    <section className="space-y-3" aria-labelledby="sessions-title">
      <h2 id="sessions-title" className="text-lg font-semibold">登录设备</h2>
      <p className="text-sm text-slate-600">显示最近 50 次登录。设备名称为浏览器信息推断，不能作为设备身份凭证。</p>
      <div className="flex flex-wrap gap-3"><RevokeSessionForm mode="OTHERS" label="退出其他设备" /><RevokeSessionForm mode="ALL" label="退出所有设备" /></div>
      <ul className="space-y-3">{sessions.map((session) => {
        const active = session.active;
        return <li key={session.id} className="rounded-xl border p-4 space-y-2">
          <p>{session.deviceLabel} {session.id === user.sessionId ? "（当前会话）" : ""} · {active ? "登录有效" : "已退出或过期"}</p>
          <p className="text-sm text-slate-500">登录：{session.createdAt} · 最近活动：{session.lastSeenAt}</p>
          {active && <RevokeSessionForm mode="ONE" sessionId={session.id} label="退出此设备" />}
        </li>;
      })}</ul>
    </section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">最近安全记录</h2>
      <ul>{events.map((event) => <li key={event.id}>{event.label} · {event.at}</li>)}</ul>
      {events.length === 0 && <p>暂无安全记录。</p>}
    </section>
  </main></PageContainer>;
}
