# 界面约定（设计 token 与组件）

后续界面子任务都照这里做，保持和参照图（ADR-0007）一致的观感。

## 文件

| 位置 | 内容 |
| --- | --- |
| `src/design/tokens.css` | 设计 token：颜色、字号、间距、布局尺寸、圆角、阴影 |
| `src/ui/ui.css` | 共享组件和表单、Markdown 的样式（`ui-*`、`field`、`markdown`） |
| `src/ui/controls.tsx` | `Button`、`IconButton`、`TaskCheckbox`、`MenuButton`、`Dialog` |
| `src/ui/Icon.tsx` | 自绘线性图标（24 视框、1.75 描边、`currentColor`） |
| `src/ui/Markdown.tsx` | 安全渲染 Markdown（禁用原始 HTML，链接新窗口打开） |
| `src/ui/Brand.tsx` | 产品名和 Logo（自有设计，不用官方素材） |
| `src/app/app.css` | 应用外壳、侧栏、任务列表、详情、登录页的布局 |

## Token 规则

- 组件只用 `var(--…)`，不写裸颜色和裸尺寸。新增颜色先加到 `tokens.css`，并注明用途。
- 数值来自参照截图实测（1440×900）：侧栏导航条 50px，侧栏 240px，任务列 650px，标题栏 64px，侧栏项 38px，任务行 40px，品牌蓝 `#4772fa`，侧栏底色 `#f5f7ff`，选中项 `#dfe6fd`，正文 `#191919`。
- 无障碍优先于像素：参照图里对比度不到 WCAG AA 的文字色（灰色辅助文字 `#a2a3a3`、分组标题 `#b6b8bd`、白字蓝底按钮 `#4772fa`）在 token 里已加深，`tokens.css` 注释里写了原值。
- 移动布局断点是 `max-width: 767px`（`MOBILE_QUERY`），CSS 和 `useMediaQuery` 用同一个值。

## 组件规则

- 用原生元素：按钮用 `<button>`，弹窗用 `<dialog>`（`Dialog`，自带焦点限制和 Esc 关闭），表单控件都有 `<label>`。
- 只有图标的控件必须传 `label`（作为可访问名称和 tooltip），图标本身 `aria-hidden`。
- 菜单用 `MenuButton`：↑/↓/Home/End 移动，Esc 关闭并把焦点还给按钮；单选菜单（如"移动到清单"）给 `checked`。
- 鼠标拖拽一定要有键盘/触屏替代（侧栏用菜单里的「上移 / 下移」）。
- 悬停才显示的操作用 `opacity` 隐藏（不用 `display: none`），获得焦点时显示，移动端常显。
- Playwright 按可访问名称找元素（`getByRole`、`getByLabel`），所以改文案就是改测试契约。
