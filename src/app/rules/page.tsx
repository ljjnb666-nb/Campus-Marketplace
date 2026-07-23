export default function RulesPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold text-slate-950">平台规则</h1>
      <div className="mt-6 rounded-[28px] border border-slate-200 bg-white p-6 text-sm leading-7 text-slate-600">
        <p>
          禁止内容包括：代写作业、代考、论文代写、违禁品交易、账号买卖、虚假兼职与违法金融服务。
        </p>
        <p className="mt-4">
          允许的学习类服务包括：课程辅导、题目讲解、编程答疑、作业批改、PPT
          排版、格式调整和资料整理。
        </p>
      </div>
    </div>
  );
}
