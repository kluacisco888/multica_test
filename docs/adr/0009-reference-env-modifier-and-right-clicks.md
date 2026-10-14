---
status: accepted
amends: ADR-0008
---

# 参照环境允许修饰键点击和右键

多选（Shift 连选、Ctrl/Cmd 点选）和右键菜单只能靠按住修饰键点击、点右键才能显示出来。ADR-0008 只允许导航类的点击，这些界面拿不到参照图。维护者在 EURO-22 上同意放宽规则：截图工具的 click 步骤可以带修饰键（Shift、Ctrl、Meta、Alt），也可以点右键（`button: right`）。写保护不变：非 GET/HEAD/OPTIONS 请求和全部 WebSocket 连接照样拦截。

## 规则

- 修饰键点击和右键只能用来改变页面上的选中状态、打开右键菜单。打开菜单以后，不点会新建、修改、删除、完成、移动的菜单项。
- 带修饰键时不能点链接：目标在 `a[href]`、`area[href]`、`[role=link]` 里，或者点击中心落在这样的元素上，截图工具直接拒绝。
- 页面不许打开新页面。修饰键点击打开的新标签页或新窗口不经过请求拦截，所以截图工具在页面里阻止弹窗；只要出现新页面或者有弹窗被阻止，这次运行就失败。
- 参照环境不允许启动后台 worker（Worker、SharedWorker）。worker 里的 WebSocket 不经过请求拦截，所以截图工具给页面文档加上 `worker-src 'none'`，被挡下的 worker 在 `blockedRequests` 里记作 `WORKER`；如果还有 worker 启动了，这次运行失败。将来要是滴答开始用 worker，截图可能和真实界面有出入，看到 `WORKER` 记录就该检查。
- ADR-0008 的其他规则照常适用：操作写成脚本，PR 里附上脚本和 `blockedRequests`；不打字，不拖动；一定要发写请求才能显示的页面，请维护者在 noVNC 里截图。

## Consequences

- 选中任务以后，误按快捷键或者误点菜单项就可能发出写请求。写请求都被拦着，最坏的情况也只是截图失败，小号里的数据不会变。
