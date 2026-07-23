# 校园集市设计系统规范 (Design System Specs)

本文档规范“校园集市”全站视觉与交互标准，适用于 Tailwind CSS + Shadcn UI + CSS Variables。

---

## 1. 容器与版式规范 (Layout & Page Containers)

### 1.1 宽度标准
- **普通页面 (Standard Page)**: `max-w-6xl` (`1152px` 或 `1200px`)
- **宽列表/广场页面 (Wide Marketplace)**: `max-w-7xl` (`1280px`)
- **阅读/表单页面 (Form & Article Page)**: `max-w-3xl` (`768px`) 或 `max-w-4xl` (`896px`)
- **管理后台 (Admin Workspace)**: `max-w-[1400px]` 全屏响应式

### 1.2 页面结构容器组件
必须使用统一的 UI Layout 组件包包裹：
- `<PageContainer>`：管理外层 padding 与 max-width。
- `<PageHeader>`：规范统一的主标题、副标题、面包屑导航与右侧操作栏。
- `<PageSection>`：规范区块间距（默认 `space-y-8` 或 `space-y-12`）。
- `<ContentGrid>`：规范列表与内容双栏网格。

---

## 2. 间距系统 (Spacing Scale)

严禁在页面中自由使用任意像素间距。统一采用 Tailwind 标准间距 Scale：

| Token | 像素值 | 使用场景 |
|---|---|---|
| `gap-1` / `p-1` | 4px | 微型图标与文字间距 |
| `gap-2` / `p-2` | 8px | 标签内边距、次级元素间距 |
| `gap-3` / `p-3` | 12px | 紧凑按钮内边距、小卡片间距 |
| `gap-4` / `p-4` | 16px | 标准元素内边距、卡片小间距 |
| `gap-6` / `p-6` | 24px | 标准卡片 P-6、表单项 Gap-6 |
| `gap-8` / `py-8` | 32px | 区块与区块间距 Section Gap |
| `gap-12` / `py-12` | 48px | 页面大区块间距 Large Section Gap |
| `gap-16` / `py-16` | 64px | Hero 区域大上下边距 |

---

## 3. 圆角规范 (Border Radius Tokens)

消除随意出现的 `rounded-[28px]`、`rounded-[32px]` 等异形尺寸，统一收敛为标准设计 Token：

- **输入框 / 按钮 / 小标签**: `rounded-xl` (`12px`)
- **卡片 / Card / 列表项**: `rounded-2xl` (`16px`)
- **主要容器 / Modal 框 / Section Card**: `rounded-3xl` (`24px`)
- **底部抽屉 (Drawer) / Modal 顶角**: `rounded-t-3xl` 或 `rounded-3xl`
- **头像 / 圆形 Badge**: `rounded-full`

---

## 4. 字体层级规范 (Typography Scale)

| 语义层级 | Class 组合 | 像素大小/字重 | 使用位置 |
|---|---|---|---|
| **页面主标题 (Page Title)** | `text-2xl sm:text-3xl font-bold tracking-tight text-slate-900` | 28px - 32px / Bold | 页面顶栏、大区块主标 |
| **页面副标题 (Page Subtitle)** | `text-sm sm:text-base text-slate-500` | 14px - 16px / Regular | 顶栏描述、辅助导语 |
| **商品/服务名称 (Item Title)** | `text-xl sm:text-2xl font-bold text-slate-900` | 20px - 24px / Bold | 详情页大标题 |
| **卡片标题 (Card Title)** | `text-base font-semibold text-slate-900` | 16px / SemiBold | 商品/跑腿卡片标题 |
| **价格数字 (Price Hero)** | `text-2xl sm:text-3xl font-extrabold text-indigo-600 tracking-tight` | 24px - 30px / ExtraBold | 详情页核心价格 |
| **卡片价格 (Card Price)** | `text-lg font-bold text-indigo-600` | 18px / Bold | 列表卡片价格 |
| **正文文本 (Body Text)** | `text-sm text-slate-600 leading-relaxed` | 14px / Regular | 描述信息、正文段落 |
| **辅助说明 (Caption/Muted)**| `text-xs text-slate-400` | 12px / Regular | 时间、浏览量、脚注 |
| **表单 Label** | `text-sm font-medium text-slate-700` | 14px / Medium | 输入框上方 Label |

---

## 5. 色彩体系与语义 (Color System)

依托 Shadcn OKLCH 规范，全站收缩为统一色彩集：

- **Primary (主色)**: `indigo-600` (`#4f46e5`) - 代表活力、科技与校园安全信赖感。
- **Primary Hover**: `indigo-700`
- **Primary Light (弱背景)**: `indigo-50` / `indigo-100/50`
- **Secondary (次要/中性)**: `slate-900` (黑/深灰次要按键) 与 `slate-100` (轻量按钮)
- **Background (背景)**: `slate-50/50` 或 `white`
- **Surface/Card (卡片底色)**: `white` 带 `border-slate-200/80`
- **Success (成功/完成)**: `emerald-600` / `emerald-50`
- **Warning (警告/待处理)**: `amber-600` / `amber-50`
- **Destructive (危险/删除)**: `rose-600` / `rose-50`
- **Text Primary**: `slate-900`
- **Text Secondary**: `slate-600`
- **Text Muted**: `slate-400`

---

## 6. 阴影与边框规范 (Elevations & Borders)

减少硬卡片叠加，使用微阴影与柔柔边框：

- **Standard Border**: `border border-slate-200/80`
- **Card Hover Elevation**: `hover:shadow-md hover:border-slate-300 transition-all duration-200`
- **Floating Overlay (Modal/Drawer)**: `shadow-xl shadow-slate-900/10`
- **Header Floating**: `backdrop-blur-md bg-white/80 border-b border-slate-200/80`
