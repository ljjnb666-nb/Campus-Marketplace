import { redirect } from "next/navigation";

// Phase 5：平台规则迁移为版本化 policy source（/legal/rules），
// 旧路由永久重定向，避免出现第二份会漂移的静态文本。
export default function RulesRedirectPage() {
  return redirect("/legal/rules");
}
