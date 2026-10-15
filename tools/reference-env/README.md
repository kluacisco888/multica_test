# 参照环境：服务器上的 Chromium + noVNC

按 ADR-0007（ADR-0008 修订），用维护者的滴答小号做只读参照。服务器上跑一个 Chromium，通过 noVNC 给维护者登录；登录态保存在仓库外的浏览器配置目录里，`screenshot.mjs` 用 Playwright 加载这个目录对参照界面截图。

## 只读规则

- 只截图。不在参照账号里新建、修改或删除任何东西，包括任务、清单、标签、设置。需要看某个状态时，请维护者在小号里准备好，不要自己动手。
- 截图工具只导航和截图，不输入、不拖动，并且拦截所有非 GET/HEAD/OPTIONS 请求，以及全部 WebSocket 连接（WS 握手虽然是 GET，但连上后可以写数据）。输出里的 `blockedRequests` 会列出被拦截的请求，WebSocket 记为 `WS <地址>`。不要绕开这个工具去驱动已登录的浏览器。
- 光打开网址截不出来的界面（例如日历的周、日、多日视图），可以用 `--script` 交给工具一个导航脚本，只做导航类的点击、悬停、滚动（ADR-0008），见下面「导航脚本」。多选（Shift / Ctrl / Cmd + 点击）和右键菜单只改页面上的选中状态、打开菜单，也可以在脚本里做。PR 里附上用过的脚本和输出的 `blockedRequests`。
- 如果页面一定要发出被拦截的写请求才能显示，就停下来，请维护者在 noVNC 里截图，不要放开拦截。
- 不要在 noVNC 里的浏览器设置中开启「启动时继续浏览上次打开的网页」。截图工具在浏览器启动后才开始拦截，恢复出来的页面在这之前发出的请求拦不到。
- 截图里有个人数据，登录态在配置目录里，这两样都不提交进仓库。截图工具拒绝把文件写进仓库；配置目录默认在 `~/.dida-reference`（权限 700）。
- 全部验收结束后，运行 `./reference-env.sh purge --yes` 删除配置目录。

## 组成

| 进程 | 监听 | 说明 |
| --- | --- | --- |
| Xvfb | 显示 `:99`，不开 TCP | 虚拟屏幕 1920x1080 |
| Chromium | — | Playwright 自带的 Chromium，`--user-data-dir=~/.dida-reference/profile` |
| x11vnc | `127.0.0.1:5901`（关闭 IPv6） | 需要 VNC 密码 |
| websockify + noVNC | `127.0.0.1:6080` | 网页版 VNC 客户端 |

默认端口避开了机器上已有的服务（Multica 的 3000、8080、19514，nginx 的 80，ssh 的 22）。可以用环境变量改：`DIDA_REF_NOVNC_PORT`、`DIDA_REF_VNC_PORT`、`DIDA_REF_DISPLAY`、`DIDA_REF_HOME`、`DIDA_REF_NODE`。启动前脚本会检查端口和显示号，被别的进程占用就报错退出，不会去停别人的进程。

## 命令

```bash
cd tools/reference-env
./reference-env.sh setup          # 一次性：apt 装 Xvfb/x11vnc/noVNC/中文字体，npm ci，装 Chromium 及其系统库（需要 sudo、Node >= 20）
./reference-env.sh start          # 启动全部；已在运行的部分会跳过
./reference-env.sh status         # 查看进程、端口、noVNC 地址
./reference-env.sh password       # 打印 VNC 密码（首次 start 时随机生成，存在配置目录里）
./reference-env.sh stop           # 停止全部（登录态保留在配置目录里）
./reference-env.sh stop-browser   # 只停浏览器，截图前需要
./reference-env.sh start-browser  # 浏览器被关掉或截完图后重新打开
./reference-env.sh purge --yes    # 停止并删除配置目录（验收结束后）
```

有免密 sudo 时，四个进程用 `systemd-run` 起成临时单元 `dida-reference-{xvfb,chromium,x11vnc,novnc}.service`（不写任何配置文件，`systemctl status dida-reference-novnc` 可查），因此不会落在调用者的 cgroup 里，例如从 Multica 智能体启动时不会挂在 `multica-daemon.service` 下。没有 sudo 时退回 `setsid nohup`，pid 记在 `~/.dida-reference/run/`；也可以用 `DIDA_REF_NO_SYSTEMD=1` 强制这种方式。pid 文件里同时记了进程启动时间和 boot_id，和 `/proc` 对不上（服务器重启过、pid 被复用）就当作没在运行，`stop` 只删文件、不发信号。

临时单元在服务器重启后不会自动恢复。重启后手动运行一次 `./reference-env.sh start` 即可；登录态在配置目录里，一般不需要重新登录。

## 维护者登录

1. 在自己电脑上：`ssh -L 6080:localhost:6080 <用户>@<服务器>`，保持这个连接。
2. 在服务器上运行 `tools/reference-env/reference-env.sh password` 拿到 VNC 密码。
3. 在自己电脑的浏览器打开 `http://localhost:6080/vnc.html?autoconnect=1&resize=scale`，输入密码，在里面的 Chromium 登录滴答小号。
4. 登录完成后，关掉自己电脑上的标签页即可；服务器上的浏览器保持运行也没关系。

小号登录过期后，重复以上步骤。

## 截图

截图工具依赖 `node_modules`（被 gitignore）。新检出或报 `Cannot find package 'playwright'` 时，先在本目录运行 `npm ci`。

截图工具和 noVNC 里的浏览器不能同时使用配置目录，先停浏览器：

```bash
./reference-env.sh stop-browser
node screenshot.mjs https://dida365.com/webapp/ -o ~/reference-shots/inbox.png [--full-page] [--wait 3000] [--viewport 1440x900]
./reference-env.sh start-browser
```

输出路径必须在仓库外、以 `.png` 结尾。默认视口 1440x900、`zh-CN`、`Asia/Shanghai`。输出 JSON 里的 `finalUrl` 如果跳回了首页或登录页，说明登录态过期了。

### 导航脚本（ADR-0008）

```bash
node screenshot.mjs 'https://dida365.com/webapp/#q/all/tasks' -o ~/reference-shots/x/week.png --script week.json
```

脚本是一个 JSON 数组，页面加载并等待 `--wait` 之后按顺序执行，最后再截 `-o` 那张图。每一步只能是下面之一（选择器是 Playwright 选择器：`text="周"` 精确匹配文字，`text=周` 是包含，`role=button[name="今天"]`，或 CSS）：

| 步骤 | 作用 |
| --- | --- |
| `{ "click": "<选择器>" }` | 点击第一个匹配的可见元素；可加 `"modifiers": ["Shift" \| "Control" \| "Meta"]`（多选）和 `"button": "right"`（右键菜单）。带修饰键时不能点链接（`a[href]`、`[role=link]`，包括点击位置落在链接上），因为会开新标签页 |
| `{ "hover": "<选择器>" }` | 悬停（打开子菜单） |
| `{ "scroll": "<选择器>", "by": 400 }` | 让元素竖向滚动若干像素 |
| `{ "press": "Escape" }` | 只允许导航键：Escape、Tab、Shift+Tab、方向键、PageUp/PageDown、Home、End（不含 Enter 和空格） |
| `{ "wait": 1000 }` | 等若干毫秒（最多 120000） |
| `{ "waitFor": "<选择器>" }` | 等元素出现（15 秒超时） |
| `{ "screenshot": "month.png", "fullPage": false }` | 中途截一张，相对路径相对于 `-o` 所在目录，同样不能在仓库内 |
| `{ "download": "text=\"生成备份\"", "saveAs": "x.csv" }` | ADR-0010：点「生成备份」并接收浏览器下载（滴答直接给文件时）。只认这一个按钮，文件只能是 `.csv`、存到仓库外（权限 600） |
| `{ "fetchBackup": true, "saveAs": "x.csv", "waitMinutes": 10 }` | ADR-0010：滴答在后台生成备份时（弹窗「稍后可在通知中心下载文件」），用 GET 读通知列表 `https://api.dida365.com/api/v2/notification?autoMarkRead=false`（不标已读，地址写死在 `lib.mjs`），取最新一条成功的导出通知里的 https 下载地址并下载。最多等 `waitMinutes` 分钟 |

新标签页和新窗口一律不许打开，分两层（EURO-22 审查）：

- 浏览器层（CDP，挂在浏览器 target 上，在 Playwright 之下）：所有 target 的所有请求出浏览器之前都先在这里暂停。不属于我们打开的那个页面的 frame（也就是任何新标签页、新窗口，不管怎么开的）发出的请求一律失败，GET 也不放，所以新页面连自己的文档都拿不到；其余请求只放行 GET/HEAD/OPTIONS，sendBeacon 这类页面关掉后还会发的 keepalive 请求也拦得住。新出现的页面 target 立刻关掉，这次运行失败。
- 页面层（`addInitScript`）：`window.open`（各种写法）、`a.click()` 和 `dispatchEvent` 点击不在文档里的链接、指向别的标签页的链接和表单（含 `<base target>`、`formtarget`、不存在的具名窗口）、`form.submit()` / `requestSubmit()`、中键或带修饰键点链接，都在页面里直接阻止，报错更清楚。页面里已有的具名 iframe 仍可作为 target。

两种情况都让这次运行失败、不截图。

后台 worker（Worker、SharedWorker）一律不许启动（EURO-22 第 3 次审查：worker 里开的 WebSocket 不经过 `routeWebSocket`，CDP 的 `Fetch` 和 `Network.setBlockedURLs` 也都管不到 WebSocket）。做法是浏览器层给每个文档的响应加上 `Content-Security-Policy: worker-src 'none'`，由浏览器执行，about:blank / srcdoc / blob 这类继承文档策略的 iframe 也一样。被挡下的 worker 记进 `blockedRequests`，写作 `WORKER <地址>`；万一还有 worker 启动了，立刻关掉，这次运行失败。试过的其他办法：先挂起 worker 再下发设置（Playwright 自己也挂在 worker 上，会马上让它继续跑，抢不过）；只放行 HTTP 的代理（wss 和 https 都走 CONNECT 隧道，分不出来）。截至 EURO-22，滴答网页版的三个参照脚本里没有出现过创建 worker 的情况。
（试过用 `waitForDebuggerOnStart` 先挂起新页面再关：`window.open` 开的弹窗和打开它的页面共用渲染进程，挂起弹窗会把原页面一起冻住，点击一直不返回，所以改用按 frame 拦请求。）

一个脚本里 `download` 和 `fetchBackup` 合计最多一次（ADR-0010：每个子任务最多导出一次）。失败的运行也会在 stderr 打出 `blockedRequests`。

没有输入和拖动类的步骤；其他字段一律拒绝，整份脚本在启动浏览器之前就校验完。点击前工具会检查目标控件（离它最近的按钮 / 链接 / 菜单项）：输入框、下拉框、可编辑区域，以及文字里带「删除、新建、添加、完成、保存、确定、移动、归档、放弃、清空、退出、订阅、升级、编辑、上传」等字样的控件都拒绝点击，脚本报错退出、不截图。写请求的拦截不受脚本影响。

输出 JSON 多了 `script`、`steps`（每一步执行完时已拦截的请求数 `blockedSoFar`）和 `screenshots`。

例：日历周视图（先点左侧导航条的日历，再在视图下拉框里选「周」）：

```json
[
  { "click": "a[href*='#c']" },
  { "wait": 5000 },
  { "click": "text=\"月\"" },
  { "wait": 800 },
  { "click": "text=\"周\"" },
  { "wait": 5000 }
]
```

切换视图时滴答会发 `PUT /api/v2/user/preferences/settings` 保存视图偏好，工具会拦掉它；页面照样切换，只是小号里的默认视图不变。

## 测试

```bash
npm test
```
