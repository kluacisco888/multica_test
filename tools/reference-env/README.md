# 参照环境：服务器上的 Chromium + noVNC

按 ADR-0007，用维护者的滴答小号做只读参照。服务器上跑一个 Chromium，通过 noVNC 给维护者登录；登录态保存在仓库外的浏览器配置目录里，`screenshot.mjs` 用 Playwright 加载这个目录对参照界面截图。

## 只读规则

- 只截图。不在参照账号里新建、修改或删除任何东西，包括任务、清单、标签、设置。需要看某个状态时，请维护者在小号里准备好，不要自己动手。
- 截图工具只导航和截图，不点击、不输入，并且拦截所有非 GET/HEAD/OPTIONS 请求，以及全部 WebSocket 连接（WS 握手虽然是 GET，但连上后可以写数据）。输出里的 `blockedRequests` 会列出被拦截的请求，WebSocket 记为 `WS <地址>`。不要绕开这个工具去驱动已登录的浏览器。
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

## 测试

```bash
npm test
```
