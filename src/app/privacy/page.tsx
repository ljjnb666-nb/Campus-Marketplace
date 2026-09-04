import { redirect } from "next/navigation";

// Phase 5：隐私政策迁移为版本化 policy source（/legal/privacy），
// 旧路由永久重定向，避免出现第二份会漂移的静态文本。
export default function PrivacyRedirectPage() {
  return redirect("/legal/privacy");
}
