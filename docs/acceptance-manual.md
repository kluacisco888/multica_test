---
title: 验收手册（访问、逐项检查、备份迁移、接 CloudFront）
issue: EURO-31
---

# 验收手册

给维护者自己用：怎么从自己的电脑访问服务器上的应用、按功能逐项检查什么、怎么备份并迁移到自己的服务器，以及以后接 CloudFront 要改哪些配置。部署和命令的细节以 [README](../README.md) 为准，本手册只按验收顺序把它们串起来；用户故事和自动化测试的对应关系见 [端到端覆盖矩阵](e2e-coverage.md)。

## 1. 访问应用

应用只监听服务器的 `127.0.0.1`，不暴露到公网，从自己电脑用 SSH 端口转发访问：

```bash
ssh -L 8090:127.0.0.1:8090 <用户>@<服务器>
# 浏览器打开 http://127.0.0.1:8090
```

- 冒号前是自己电脑上的端口，冒号后是服务器上的端口（`.env` 的 `APP_PORT`，默认 8090）。自己电脑 8090 被占用时换前一个，例如 `ssh -L 18090:127.0.0.1:8090 …`，然后打开 http://127.0.0.1:18090 。
- 要同时看两套部署（例如正式的 8090 和迁移演练留下的 18391），一条命令写多个 `-L`：`ssh -L 8090:127.0.0.1:8090 -L 18391:127.0.0.1:18391 <服务器>`。
- 只转发不登录 shell：加 `-N`。
- 不要转发 3000、8080（Multica）和 80（系统 nginx）来验收，那不是本应用。
- 登录账号：第一次启动时按 `.env` 的 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 创建的管理员；忘了就在服务器上 `docker compose exec app dida reset-password admin`。
- 打开前可以先在服务器上确认服务正常：`curl http://127.0.0.1:8090/api/health` 返回 `"status":"ok","db":"ok"`。

## 2. 逐项检查

桌面浏览器（宽度 ≥ 1280）和手机（或开发者工具里 390px 宽）各走一遍。每项后面是用户故事编号（spec EURO-2）。自动化测试已经覆盖了这些路径（见覆盖矩阵），手动验收主要看界面和交互是否和滴答清单一致；发现差异另开 issue。

### 部署与账户

- [ ] `curl http://127.0.0.1:8090/api/health` 正常；`ss -ltnp` 里应用只在 `127.0.0.1:<APP_PORT>` 上监听（1、3）
- [ ] 用管理员登录，刷新后仍是登录状态；退出登录回到登录页；修改密码后旧密码登不上（7、8）
- [ ] 设置 →「用户管理」：添加用户、停用（对方立即被登出）、启用、重置密码（9）
- [ ] 服务器上 `docker compose exec app dida reset-password <账号>` 能重置密码（10）
- [ ] 用另一个用户登录，看不到第一个用户的清单、任务、附件（11）

### 清单与组织

- [ ] 收件箱在最前，不能删除、不能归档（12）
- [ ] 新建清单，改名、改颜色和图标、删除（任务进回收站）（13）
- [ ] 新建文件夹，把清单拖进去，折叠后刷新仍是折叠的；拖动调整侧栏顺序（14、15）
- [ ] 归档清单：侧栏「已归档的清单」里，任务不出现在今天 / 最近 7 天；取消归档恢复（16）
- [ ] 打开清单的「不进智能清单」：任务不出现在智能清单里，但搜索和过滤器仍能找到（17）
- [ ] 标签：新建、嵌套一层子标签、改名改色、删除；按标签查看任务（18、19）

### 任务

- [ ] 输入标题回车新建；标题和 Markdown 描述可编辑（20、21）
- [ ] 优先级高 / 中 / 低 / 无颜色不同；`1/2/3/0` 快捷键改优先级（22、105）
- [ ] 截止日期（全天、带时间）、时间段、不设日期；带时间的任务按设置的时区显示（23–26）
- [ ] 完成、取消完成、放弃（不计入完成）（27、28）
- [ ] 删除进回收站，回收站里还原、彻底删除（29、30）
- [ ] 移到别的清单、拖拽排序、置顶（31–33）
- [ ] 多选（Ctrl/Cmd+点击、Shift+点击）后批量完成、删除、移动、改日期、改优先级、打标签（34）
- [ ] 子任务最多 5 层；Tab / Shift+Tab 缩进和取消缩进（35、36）
- [ ] 切换成检查清单，勾选检查项（37）
- [ ] 上传附件（图片能预览、PDF 在对话框里预览、其他文件下载），50MB 以上被拒绝（38）
- [ ] 评论：Enter 发送、编辑、删除（39）
- [ ] 「已完成」里按时间看到已完成的任务（40）

### 重复任务与智能识别

- [ ] 每天 / 每周几 / 每月 / 每年 / 每隔 N；按截止日期或完成日期（41、42）
- [ ] 完成重复任务生成下一次；过期 6 天的每日任务完成后下一次是今天（43、44）
- [ ] 每个工作日、每个休息日、每月第一个 / 最后一个工作日、跳过法定节假日；日历上国庆调休的周末被当作工作日（45–48）
- [ ] 结束条件：到某天、重复 N 次（49）
- [ ] 输入「每天上午背单词」「明天上午提醒我去取快递」「下周三下午3点开会」「每个工作日晚上跑步」，识别结果和滴答一致；识别部分高亮、点击取消（51–56）
- [ ] `#标签`、`~清单`、`!高`、`*提前30分钟` 生效（55）
- [ ] 设置 → 更多设置 → 智能识别：各开关和模糊时间生效（57、58）

### 智能清单、过滤器、搜索、视图

- [ ] 侧栏：今天、明天、最近 7 天、已完成、不重要的、回收站；可以隐藏；过期任务在「今天」里单独一组（59–61）
- [ ] 过滤器按清单、标签、日期、优先级组合（62）
- [ ] `Ctrl+K` 搜索标题、描述、检查项、评论，归档清单里的也能搜到（63）
- [ ] 排序和分组选项（64）
- [ ] 看板：增减分栏、跨分栏拖动；智能清单的看板按日期 / 优先级分栏（66、67）
- [ ] 时间线：横条拖动改日期、拖两端改开始 / 截止（68）
- [ ] 日历：月 / 周 / 日 / 多日，拖动改日期和时间，点空白新建；农历、节日、休 / 班标记（69–71）
- [ ] 四象限：拖到另一象限改优先级，可以改象限规则（72、73）

### 提醒与通知渠道

- [ ] 设置 →「提醒与通知」：添加飞书渠道（Webhook，签名选填）和邮件渠道（QQ 邮箱预设），「发送测试消息」真的收到（74–76）
- [ ] 渠道列表里 Webhook 和授权码只显示脱敏值（85）
- [ ] 默认渠道；给单个任务指定渠道（77、78）
- [ ] 带时间任务的多个提醒、全天任务 09:00 提醒，到点飞书 / 邮箱收到，页面开着时弹应用内提醒，能直接完成或稍后提醒（79–82）
- [ ] 故意把 Webhook 改错：重试后在设置里看到失败记录（83）

### 专注、习惯、倒数日、统计

- [ ] 番茄钟开始、暂停、继续、放弃；刷新或换浏览器后倒计时继续；结束有提示音（86–91）
- [ ] 正计时；关联任务；专注记录和统计（87、88、92）
- [ ] 习惯：每天 / 每周几 / 每周 N 次，数量型目标，打卡、补打卡、撤销，连续天数和月历（93–98）
- [ ] 倒数日、纪念日、每年重复、农历日期、提醒（99–101）
- [ ] 统计页：完成数、完成率、专注时长、习惯；成就分和等级（102、103）

### 外观、快捷键、移动端、导入导出、节假日

- [ ] 浅色 / 深色 / 跟随系统，8 种主题色（104）
- [ ] `N` 新建、`?` 快捷键速查面板（105、106）
- [ ] 手机宽度：侧栏是抽屉，底部导航任务 / 日历 / 专注 / 习惯 / 更多；右滑完成、左滑删除（107、108）
- [ ] 手机浏览器「添加到主屏幕」后独立窗口打开（109；Chrome 只在 HTTPS 或 localhost 下提示安装，通过 `ssh -L` 访问的 `127.0.0.1` 算 localhost）
- [ ] 设置里导出 JSON、导出任务 CSV；另一个用户导入 JSON 后数据一致；导入滴答官方 CSV（110–113）
- [ ] 设置 → 日期与时间：节假日数据最后更新时间，「立即更新」（114）

## 3. 备份与迁移到自己的服务器

数据只有两份：PostgreSQL 数据库（数据卷 `<项目>_pgdata`）和附件文件（数据卷 `<项目>_appdata` 的 `/data/attachments`）。`scripts/backup.sh` 把两者打成一个 `.tar.gz`；**`.env` 不在备份里，必须一起带走**：`APP_ENCRYPTION_KEY` 丢了，加密保存的通知渠道凭证就再也解不开（要重新填 Webhook 和授权码）；`POSTGRES_PASSWORD` 也要一致。

### 旧服务器

```bash
cd <仓库目录>
docker compose stop app        # 可选：停写入，数据库和附件是同一时刻的快照
scripts/backup.sh              # → backups/dida-clone-<UTC时间>.tar.gz
scp backups/dida-clone-*.tar.gz .env <新服务器>:~/
```

不停 `app` 也能备份（`pg_dump` 本身是一致快照），但数据库和附件是先后两步打包的，中间有人上传或删除附件就可能对不上；迁移时建议先停。

### 新服务器

需要 Docker（compose v2.24+）和 git。

```bash
git clone https://github.com/kluacisco888/multica_test.git && cd multica_test
cp ~/.env .env                 # 旧服务器的 .env，原样使用
docker compose build
scripts/restore.sh ~/dida-clone-<UTC时间>.tar.gz   # 提示时输入项目名 dida-clone 确认
curl http://127.0.0.1:8090/api/health
```

`restore.sh` 会先停 `app`、清空并恢复数据库、替换附件目录，再启动 `app`；启动时自动执行数据库迁移，所以新服务器上的代码比备份新也可以。

### 核对数据一致

迁移前后各在服务器上跑一次，输出应该完全相同（行数 + 校验和；附件是 sha256）。迁移前先停 `app`，否则会话等数据会在两次之间变化。这里只列用户数据的关键表；`scripts/migration-drill.sh` 比对的是全部表：

```bash
docker compose exec -T postgres psql -U dida -d dida -At <<'SQL'
SELECT format('SELECT %L, count(*), md5(coalesce(string_agg(md5(x::text), %L ORDER BY md5(x::text)), %L)) FROM %I.%I x',
              table_name, ',', '', table_schema, table_name)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  AND table_name IN ('users', 'folders', 'lists', 'tags', 'tasks', 'checklist_items', 'attachments', 'comments',
                     'notification_channels', 'habits', 'habit_checkins', 'countdowns', 'focus_sessions')
ORDER BY table_name
\gexec
SQL
docker compose run --rm --no-deps -T --entrypoint sh app -c 'cd /data && find attachments -type f | sort | xargs -r sha256sum'
```

确认无误后登录新服务器的应用，打开一个带附件的任务下载看看，再在设置里对一个通知渠道点「发送测试消息」（能发出去说明 `APP_ENCRYPTION_KEY` 带对了）。之后再停掉旧服务器（`docker compose down`；确认不再需要后才加 `-v` 删数据卷）。

### 迁移演练脚本

`scripts/migration-drill.sh` 在本机把上面整个流程完整走一遍，用来证明备份、恢复和部署确实可用，不碰任何正在运行的服务：

1. 先记录 Multica（compose 项目 `multica`）和系统 nginx 的状态：容器 id、启动时间、重启次数，nginx 主进程和启动时间，80 / 3000 / 8080 的监听。
2. 「旧服务器」：`git archive HEAD` 到新的临时目录，`cp .env.example .env`（端口 18391、随机密码和密钥），compose 项目 `dida-drill-old`，`docker compose up -d --build`，通过 HTTP 填入各种数据（文件夹、清单、看板分栏、标签、任务、子任务、检查项、附件、评论、过滤器、通知渠道、倒数日、习惯和打卡、专注记录、设置、回收站）。
3. 停 `app`，对每张表取行数和校验和、对每个附件文件取 sha256，然后 `scripts/backup.sh`，旧服务器停机。
4. 「新服务器」：另一个全新的 `git archive`，只拿到备份文件和旧 `.env`，compose 项目 `dida-drill-new`，`docker compose build`，`scripts/restore.sh`（像人一样在提示里输入项目名），再取一次指纹，必须和第 3 步完全相同。
5. 用 HTTP 检查恢复后的部署：健康检查、普通用户和管理员登录、读任务和回收站、下载两个附件逐字节比对、其他用户 404、未登录 401、通知渠道凭证仍能解密；再 `docker compose up -d --build` 重新部署一次，同样检查一遍。
6. 两个项目 `down -v`、删除演练镜像和临时目录，确认什么都没剩下，并且 Multica 和 nginx 的状态与第 1 步完全相同。

```bash
scripts/migration-drill.sh                    # 全部清理
DRILL_KEEP=1 scripts/migration-drill.sh       # 留下恢复后的新服务器，打印账号和清理命令
DRILL_PORT=18491 scripts/migration-drill.sh   # 18391 被占用时换端口
```

想亲眼看恢复后的数据：用 `DRILL_KEEP=1` 跑，然后 `ssh -L 18391:127.0.0.1:18391 <服务器>`，打开 http://127.0.0.1:18391 ，用脚本最后打印的 `drill` 账号登录（清单「项目A」里的「写迁移手册」带两个附件）。看完执行脚本打印的清理命令。CI 的 `compose` 任务每次都跑这个脚本。

## 4. 以后接 CloudFront

代码不用改，只改 `.env` 和服务器上的网络配置（README「端口与外部地址」）：

| 配置 | 改成 | 原因 |
| --- | --- | --- |
| `PUBLIC_URL` | `https://<CloudFront 或自己的域名>` | 是 `https://` 时登录 Cookie 自动加 `Secure` |
| `TRUST_PROXY` | 回源经过的那一跳：本机 nginx 转发时保持默认 `loopback,…`；CloudFront 直接回源到应用时写 CloudFront 的回源网段，或 `1`（只信任最近一跳） | 决定是否采信 `X-Forwarded-For/-Proto/-Host`；`GET /api/health` 的 `request` 字段可以确认效果 |
| `APP_BIND` / `APP_PORT` | 保持 `127.0.0.1:8090`，由本机 nginx（或 ALB）对外；只有 CloudFront 直接回源到这台机器时才改成 `0.0.0.0`，并用安全组只放行 CloudFront 的托管前缀列表 `com.amazonaws.global.cloudfront.origin-facing` | 不让应用直接暴露在公网 |

CloudFront 分配：

- 源：本机 nginx 或 ALB 的地址。应用只按 `PUBLIC_URL` 决定 Cookie 是否加 `Secure`，不依赖 `X-Forwarded-Proto`；想让 `/api/health` 的 `request.protocol` 也显示 `https`，在 nginx 里加 `proxy_set_header X-Forwarded-Proto https;`。
- `/api/*` 行为：允许全部 HTTP 方法；缓存策略 `CachingDisabled`；源请求策略 `AllViewer`（转发全部头、Cookie `dida_session` 和查询字符串）。附件上传是 `POST` 请求体直传（最多 50MB）。
- 默认行为（前端静态文件、`/manifest.webmanifest`、`/icons/*`）：可以缓存；`index.html` 不要长期缓存，否则发版后要手动失效。
- 查看器协议：重定向到 HTTPS。HTTPS 下手机浏览器才会提示「添加到主屏幕」。
- 改完 `.env` 后 `docker compose up -d` 让配置生效，再用 `curl https://<域名>/api/health` 确认 `publicUrl` 是 `https://…`，然后通过域名登录一次（Cookie 带 `Secure`，刷新后仍是登录状态）。

## 5. 常见问题

- `ssh -L` 后浏览器打不开：先在服务器上 `curl http://127.0.0.1:<APP_PORT>/api/health`；`docker compose ps` 看 `app` 是否 healthy，`docker compose logs app --tail 100` 看错误。
- 恢复后通知渠道「无法解密渠道凭证」：`.env` 的 `APP_ENCRYPTION_KEY` 不是旧服务器那份。换回原来的 `.env` 后 `docker compose up -d`；原 key 找不到就在设置里重新填凭证。
- 恢复后登不上：账户在备份里，用旧服务器上的账号密码；忘了就 `docker compose exec app dida reset-password <账号>`。
