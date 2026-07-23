export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold text-slate-950">隐私政策</h1>
      <div className="mt-6 rounded-[28px] border border-slate-200 bg-white p-6 text-sm leading-7 text-slate-600">
        <p>
          公开资料仅包含昵称、头像、学校、校区、认证状态、注册时间、完成订单数量与好评率。
        </p>
        <p className="mt-4">
          完整学号、身份证、详细宿舍号、手机号和学生证图片不会在前台公开，学生证图片仅管理员可见。
        </p>
      </div>
    </div>
  );
}
