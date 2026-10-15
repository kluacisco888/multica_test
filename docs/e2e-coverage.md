---
title: 端到端覆盖矩阵（用户故事 1–115）
issue: EURO-33
---

# 端到端覆盖矩阵

spec（EURO-2）里的每条用户故事，对应到验证它的 E2E 用例；不适合做 E2E 的，写明由哪一层的测试覆盖。

- E2E 用例在 `e2e/` 下，写作 `文件 › 用例标题的开头`。除非另外说明，每条都跑桌面（1440px）和移动（390px）两个 project。
- 「主流程 N」指 `e2e/acceptance-flows.spec.ts` 里的第 N 条跨功能主流程（EURO-33）。
- 「API」指 `packages/server/test/api/` 下的 HTTP 集成测试（真实 Fastify + PostgreSQL，时钟可注入）；「单元」指 `packages/shared/src/*.test.ts`；「假接收端」指 `packages/server/test/fakes/`。
- 全部 E2E 用例都在 `docker compose` 部署的环境里跑：`pnpm test:e2e:compose`（`scripts/e2e-compose.mjs`，见 README「测试」）。CI 的 `check` 任务照常跑 `scripts/e2e-server.mjs` 的那一套。

## 部署与账户

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 1 | 一条 `docker compose up -d` 启动 | `scripts/e2e-compose.mjs` 每次都从零 `up -d --build --wait`，全部 E2E 在这套环境里跑 | CI `compose` 任务：`docker compose up -d --build --wait` + 健康检查 |
| 2 | 配置都在 `.env`，有 `.env.example` | `scripts/e2e-compose.mjs` 照 `cp .env.example .env` 生成本次运行的 `.env`，只改端口、密钥和测试替身地址 | `packages/server/src/config.test.ts` |
| 3 | 默认 `127.0.0.1:8090`，可在 `.env` 改 | compose 运行用 `APP_PORT=18190`，Playwright 直接连 `127.0.0.1:18190` | `config.test.ts`；`docker-compose.yml` 端口绑定 `${APP_BIND}:${APP_PORT}` |
| 4 | `.env` 或命令创建首个管理员 | `auth.spec.ts › log in with the administrator created from .env on first start` | API `accounts.test.ts › creates the admin on first start only…`、`create-user creates a user or an admin…` |
| 5 | 备份、恢复脚本（数据库 + 附件） | —（脚本操作，不是浏览器行为） | CI `compose` 任务：`scripts/backup.sh` → `scripts/restore.sh` 到第二个项目；`scripts/backup-restore-smoke.sh`（附件上传、备份、恢复、下载、比对） |
| 6 | 反向代理 / CloudFront 后面也能用，外部地址可配 | compose 运行的 `GET /api/health` 回显 `publicUrl` 和经过代理头的 `request` | API `health.test.ts › applies X-Forwarded-* headers from a trusted proxy`；`config.test.ts`（`PUBLIC_URL`、`TRUST_PROXY`） |
| 7 | 账号密码登录并保持登录 | `auth.spec.ts › log in: wrong password shows a message, then the right one signs in and survives a reload` | API `auth.test.ts` |
| 8 | 退出登录、修改密码 | `auth.spec.ts › log out returns…`、`› change password…` | API `auth.test.ts` |
| 9 | 管理员添加、停用用户、重置密码 | `admin.spec.ts › 管理员 adds a user, disables, enables and resets their password`；主流程 9 | API `admin.test.ts`、`admin-review.test.ts` |
| 10 | 命令行重置管理员密码 | `auth.spec.ts › reset-password from the CLI…`（compose 运行里是容器里的 `dida reset-password`） | API `accounts.test.ts › reset-password…` |
| 11 | 只能看到自己的数据 | 主流程 9（另一个用户的任务：搜索为空，GET/PATCH 404）；`attachments-review.spec.ts › 附件 URL: other account 404…`；`timeline.spec.ts › cannot move another user's task` | API `access-control.test.ts › answers 404 for another user's resource…`、`changes.test.ts › isolates users…` |

## 清单与组织

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 12 | 内置收件箱 | `shell.spec.ts › 收件箱: quick add with Enter…`、`› 清单 with colour and icon…; 收件箱 cannot be deleted` | API `lists.test.ts` |
| 13 | 新建、重命名、删除清单，颜色和图标 | `shell.spec.ts › 清单 with colour and icon, move a task to it, rename and delete…` | API `lists.test.ts` |
| 14 | 一层文件夹，可折叠 | `shell.spec.ts › 文件夹 collapse and sidebar order persist after reload`；主流程 2 | API `lists.test.ts` |
| 15 | 侧栏拖动排序 | `shell.spec.ts › 文件夹 collapse and sidebar order persist after reload` | 单元 `sidebar-order.test.ts`、`list-drag.test.ts` |
| 16 | 归档清单：侧栏隐藏、不进智能清单、可取消 | `trash-archive.spec.ts › 归档 a 清单…`；`trash-archive-review.spec.ts › 取消归档 from the banner by keyboard`；主流程 6（归档后今天、最近 7 天都没有它） | API `trash-archive.test.ts` |
| 17 | 不进智能清单开关（搜索、过滤器仍能找到） | `smart-lists.spec.ts › 智能清单: … 不进智能清单 keeps a 清单 out…`、`› 过滤器: create with combined conditions…`、`› 全局搜索: … including a 不进智能清单 清单` | API `smart-lists-filters-search.test.ts` |
| 18 | 标签、父子标签、多个标签、按标签看 | `tags.spec.ts › nested 标签: tag tasks, a parent 标签 view includes its children…`；主流程 2、10 | API `tags.test.ts`；单元 `tags.test.ts` |
| 19 | 标签改名、改色、删除 | `tags.spec.ts › nested 标签: … rename, recolour and delete` | API `tags.test.ts`、`tags-review.test.ts` |

## 任务

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 20 | 快速新建，回车保存 | `shell.spec.ts › 收件箱: quick add with Enter…`；`shortcuts.spec.ts › Enter in 添加任务 saves the task…` | API `tasks.test.ts` |
| 21 | 编辑标题和 Markdown 描述 | `shell.spec.ts › 收件箱: … edit title and Markdown description…` | API `tasks.test.ts` |
| 22 | 优先级和颜色 | `tags.spec.ts › 优先级 from the task detail and from the right-click menu, with the reference colours` | API `tasks.test.ts` |
| 23 | 只设截止日期，全天或带时间 | `dates.spec.ts › due date, range, all-day ⇄ timed…`；`dates-keyboard.spec.ts › date picker works with the keyboard only…` | API `task-dates.test.ts › sets a due date only…` |
| 24 | 一段时间，在日历和时间线上横跨几天 | `dates.spec.ts › due date, range…`；`calendar.spec.ts › 月视图: … drag a 日期区间…`；`timeline.spec.ts › drag bars and their ends…` | 单元 `task-dates.test.ts`、`timeline.test.ts` |
| 25 | 不设日期 | `dates.spec.ts › … clear…`；`timeline.spec.ts › … 待安排`；主流程 2（没日期的任务在待安排） | API `task-dates.test.ts` |
| 26 | 按时区存储显示，默认 Asia/Shanghai | `dates.spec.ts › … and a time zone change`；`calendar.spec.ts › 月视图: … a timed task set in another time zone` | API `task-dates.test.ts › defaults the time zone to Asia/Shanghai…`、`› after a time zone change…` |
| 27 | 完成、取消完成 | `shell.spec.ts › 收件箱: … complete and un-complete`；主流程 8 | API `tasks.test.ts` |
| 28 | 放弃：保留记录，不计完成 | `trash-archive.spec.ts › 放弃 from the right-click menu and the detail…`；`statistics.spec.ts › 统计: 完成数 without 放弃…` | API `trash-archive.test.ts › keeps the task with its own timestamp, never as completed…` |
| 29 | 删除进回收站，30 天内可还原，30 天后清理 | `trash-archive.spec.ts › 删除 into the 回收站…`；主流程 6 | 30 天清理不适合 E2E：API `trash-archive.test.ts › cleans up after 30 days by the injected clock, keeping the tombstones`、`trash-purge-attachments-comments.test.ts › the 30-day cleanup (injected clock) does the same…` |
| 30 | 回收站还原或彻底删除 | `trash-archive.spec.ts › 删除 into the 回收站, then 还原, 彻底删除 and 清空回收站`；`trash-archive-review.spec.ts › 删除 a task with a 子任务, 还原 it…`；主流程 6 | API `trash-archive.test.ts` |
| 31 | 移到另一个清单 | `shell.spec.ts › 清单 with colour and icon, move a task to it…` | API `tasks.test.ts` |
| 32 | 清单里拖拽排序 | `sort-pin-batch.spec.ts › 拖拽排序 and 置顶…`；`mobile.spec.ts › 手势和鼠标拖拽排序互不干扰…`（390px） | API `sort-pin-batch.test.ts`；单元 `sort-key.test.ts` |
| 33 | 置顶 | `sort-pin-batch.spec.ts › 拖拽排序 and 置顶: the order and the 已置顶 group survive a reload` | API `sort-pin-batch.test.ts` |
| 34 | 多选批量完成、删除、移动、改日期、改优先级、打标签 | `sort-pin-batch.spec.ts › 多选 with Ctrl / Shift + click and the six 批量操作`；主流程 10 | API `sort-pin-batch.test.ts`、`sort-pin-batch-edges.test.ts`；单元 `task-selection.test.ts` |
| 35 | 子任务，完整属性，最多 5 层 | `subtasks.spec.ts › 子任务: add in the detail pane…`、`› 子任务 stop at 5 levels…`；主流程 8 | API `subtasks.test.ts`；单元 `task-tree.test.ts` |
| 36 | Tab 缩进、Shift+Tab 取消缩进 | `subtasks.spec.ts › 子任务: … Tab / Shift+Tab…`；`shortcuts.spec.ts › Tab indents the selected task…`；`subtasks-keyboard.spec.ts › Tab never traps focus…` | API `subtasks.test.ts` |
| 37 | 检查清单模式 | `subtasks.spec.ts › 检查清单: convert from 描述, check, add, reorder, delete, convert back`；主流程 8 | API `checklist.test.ts`、`subtasks-checklist-edges.test.ts` |
| 38 | 附件（50MB）预览和下载 | `attachments-comments.spec.ts › 附件: upload, preview, download, refuse over 50MB, delete`；主流程 8 | API `attachments.test.ts`；单元 `attachments.test.ts` |
| 39 | 评论 | `attachments-comments.spec.ts › 评论: write, edit and delete…`；主流程 8 | API `comments.test.ts` |
| 40 | 看已完成的任务，按时间查看 | `shell.spec.ts › 收件箱: … complete and un-complete`（已完成分组）；`smart-lists.spec.ts › 智能清单: …`（已完成智能清单）；主流程 8 | API `smart-lists-filters-search.test.ts › 已完成 and 不重要的` |

## 重复任务

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 41 | 每天、每周几天、每月、每年、每隔 N | `repeat.spec.ts › a daily 重复任务 from the 重复 menu…`、`› 自定义重复: every 2 days…`；主流程 5（每年，导入后保留） | 单元 `repeat-rule.test.ts › intervals, basis and end conditions`；API `repeat-tasks.test.ts` |
| 42 | 按截止日期或完成日期计算 | `repeat.spec.ts › 自定义重复: every 2 days 按完成日期…` | 单元 `repeat-rule.test.ts`；API `repeat-tasks.test.ts › 按完成日期 counts from the day it was completed` |
| 43 | 完成时生成下一次 | `repeat.spec.ts › a daily 重复任务 … completing it shows the next instance`；主流程 1 | API `repeat-tasks.test.ts › the next instance copies the task…`、`repeat-tasks.edge.test.ts › two concurrent completions…` |
| 44 | 过期 6 天的每天任务，下一次排到今天，不补生成 | —（需要固定“今天”和过期 6 天的数据，E2E 用真实时钟） | 单元 `repeat-rule.test.ts › spec Q27 › a daily task 6 days overdue…`；API `repeat-tasks.test.ts › a daily task 6 days overdue: the next instance is today` |
| 45 | 每个工作日（法定节假日和调休） | 主流程 1（智能识别出的工作日重复：第一次和下一次都落在服务器节假日数据里的工作日） | 单元 `repeat-rule.test.ts › 工作日 / 休息日 with holiday data`、`workday-calendar.test.ts`；API `repeat-tasks.test.ts › every 工作日 uses the built-in holiday data (国庆 2026)` |
| 46 | 每个休息日 | —（UI 与 45 同一个重复菜单；日期判断在下层） | 单元 `repeat-rule.test.ts › 工作日 / 休息日 with holiday data` |
| 47 | 每月第一个 / 最后一个工作日 | — | 单元 `repeat-rule.test.ts › 工作日 / 休息日 with holiday data` |
| 48 | 跳过法定节假日 | — | 单元 `repeat-rule.test.ts › 跳过法定节假日` |
| 49 | 结束条件：到某天或 N 次 | `repeat.spec.ts › 自定义重复: every 2 days 按完成日期, 3 times…` | 单元 `repeat-rule.test.ts › intervals, basis and end conditions` |
| 50 | 下一年节假日未公布时按周一到周五，数据更新后改到正确工作日 | —（要换节假日数据并等后台任务） | API `repeat-tasks.test.ts › 节假日数据更新 moves open next instances to the corrected 工作日`；`holidays.test.ts › emits 节假日数据更新 when next year gets announced` |

## 智能识别

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 51 | 每天上午背单词 | `smart-input.spec.ts › 模糊时间 settings change what 上午 means` | 单元 `smart-input.test.ts`（模糊时间以滴答为准，见 EURO-39） |
| 52 | 明天上午提醒我去取快递 | `smart-input.spec.ts › a click on a highlight cancels that part`、`› 明天: 提醒我续费 stays tomorrow, with a reminder` | 单元 `smart-input.test.ts` |
| 53 | 下周三下午 3 点开会 | `smart-input.spec.ts › highlights what is recognised…`（下午3点） | 单元 `smart-input.test.ts` |
| 54 | 每个工作日晚上跑步 | 主流程 1（每个工作日上午10点提醒我站会：重复、时间、提醒都识别） | 单元 `smart-input.test.ts` |
| 55 | `#标签` `~清单` `!高` `*提前30分钟` | `smart-input.spec.ts › highlights what is recognised…`；主流程 2（`#客户 !高`） | 单元 `smart-input.test.ts` |
| 56 | 高亮，点一下取消 | `smart-input.spec.ts › a click on a highlight cancels that part`；看板、四象限、日历里的输入框：`› 看板: …`、`› 四象限: …`、`› 日历: …` | — |
| 57 | 默认从标题去掉，可设置保留 | `smart-input.spec.ts › unticking 移除文本中的日期 / 移除任务标题中的标签 keeps that text…` | API `smart-input-settings.test.ts` |
| 58 | 改模糊时间钟点，或关掉智能识别 | `smart-input.spec.ts › 模糊时间 settings…`、`› 日期识别 off…` | API `smart-input-settings.test.ts` |

## 智能清单、过滤器与搜索

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 59 | 今天、明天、最近 7 天、已完成、不重要的、回收站 | `smart-lists.spec.ts › 智能清单: 今天 groups 已过期…`；主流程 6、8、10 | API `smart-lists-filters-search.test.ts`；单元 `smart-lists.test.ts` |
| 60 | 隐藏智能清单 | `smart-lists.spec.ts › 智能清单: … hide and show` | API `smart-lists-filters-search.test.ts` |
| 61 | 过期任务在今天里单独一组 | `smart-lists.spec.ts › 智能清单: 今天 groups 已过期…` | 单元 `smart-lists.test.ts` |
| 62 | 过滤器：清单、标签、日期、优先级组合 | `smart-lists.spec.ts › 过滤器: create with combined conditions, edit, delete`；主流程 2（标签 + 优先级） | API `smart-lists-filters-search.test.ts`；单元 `filters.test.ts` |
| 63 | 全局搜索：标题、描述、检查项、评论，含归档清单 | `smart-lists.spec.ts › 全局搜索: title, 描述 and 检查项…`；主流程 6（归档清单）、主流程 8（评论、检查项） | API `smart-lists-filters-search.test.ts`、`smart-lists-filters-search-edges.test.ts` |
| 64 | 排序和分组 | `smart-lists.spec.ts › 排序和分组: per view, remembered, keyboard operable` | 单元 `task-view.test.ts` |

## 视图

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 65 | 列表视图（默认） | `shell.spec.ts › 收件箱: …`、`› screenshots of the main screen…` | — |
| 66 | 清单看板，增减分栏，拖动任务 | `kanban.spec.ts › 清单看板: add, rename, reorder and delete 分栏…`；`kanban-review.spec.ts › 删除分组…`；主流程 2 | API `kanban.test.ts`、`kanban-review.test.ts` |
| 67 | 智能清单和过滤器的看板，分栏自动生成 | `kanban.spec.ts › 智能清单看板: automatic columns…`；`kanban-review.spec.ts › 过滤器看板…`；主流程 10 | 单元 `kanban.test.ts` |
| 68 | 时间线，拖动横条改日期 | `timeline.spec.ts › drag bars and their ends, keyboard moves, and 待安排`（拖动只在桌面；390px 用键盘移动）；主流程 2 | API `timeline.test.ts`；单元 `timeline.test.ts` |
| 69 | 日历月、周、日、多日，拖到其他日期或时间 | `calendar.spec.ts › 月视图: …`、`› 周 / 日 / 多日: …`（拖动只在桌面）；主流程 1（桌面拖动；390px 在详情里改日期） | API `calendar.test.ts` |
| 70 | 农历、传统节日、法定节假日、调休补班 | `calendar.spec.ts › 月视图: 农历 and 休 / 班…` | 单元 `lunar.test.ts`、`calendar.test.ts`；API `calendar.test.ts` |
| 71 | 日历空白处新建 | `calendar.spec.ts › 月视图: … add on a day…`、`› 周 / 日 / 多日: add at a time slot…` | — |
| 72 | 四象限，修改每个象限的规则 | `matrix.spec.ts › 四象限: default quadrants by 优先级… edited rules survive a reload`；主流程 2、10 | API `matrix.test.ts`；单元 `matrix.test.ts` |
| 73 | 象限之间拖动改优先级 | `matrix.spec.ts › 四象限: … moving a task changes its 优先级…`（390px 用「移动到象限」菜单） | API `matrix.test.ts` |

## 提醒与通知渠道

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 74 | 飞书机器人渠道，签名 secret 选填 | `notification-channels.spec.ts › 飞书 channel: add with secret, send a signed test message…`；主流程 1、7 | API `channels.test.ts`（飞书签名按 HMAC-SHA256 核对）；假接收端 `fake-webhook.test.ts` |
| 75 | 邮件渠道，QQ 邮箱预设 | `notification-channels.spec.ts › 邮件 channel: QQ preset…`；主流程 7 | API `channels.test.ts`；假接收端 `fake-smtp.test.ts` |
| 76 | 发送测试消息 | `notification-channels.spec.ts › 飞书 channel: … send a signed test message`、`› 邮件 channel: … the right one delivers`（假接收端收到） | API `channels.test.ts` |
| 77 | 多个渠道，设默认 | `notification-channels.spec.ts › 飞书 channel: …`（设为默认渠道）；主流程 7（飞书默认 + 邮件非默认） | API `channels.test.ts` |
| 78 | 单个任务指定渠道，不指定发默认 | 主流程 1（默认渠道：飞书收到）、主流程 7（只发邮件：假 SMTP 收到，飞书没收到）；`reminders.spec.ts › the date picker sets several reminders, a custom one and where they go` | API `reminders.test.ts › sends only to the channels chosen for the task` |
| 79 | 带时间任务的多个提醒和自定义 | `reminders.spec.ts › the date picker sets several reminders, a custom one…`；主流程 7 | API `reminders.test.ts › sends each reminder of a timed task at its instant…` |
| 80 | 全天任务默认 09:00 提醒，可改 | `reminders.spec.ts › the date picker sets several reminders…`（全天选项）、`› 设置: 全天提醒时间…` | API `reminders.test.ts › reminds an all-day task at the 全天提醒时间…` |
| 81 | 重复任务每次实例都提醒 | 主流程 1（下一次实例带同样的准时提醒） | API `reminders.test.ts › the next instance of a 重复任务 reminds by the same rules` |
| 82 | 应用内提醒，可完成或稍后提醒 | `reminders.spec.ts › the 应用内提醒 pops up…`、`› 稍后提醒 hides the alert…`；主流程 1、7（从应用内提醒点完成） | API `reminders.test.ts › lists fired reminders until dismissed…`、`› 稍后提醒 reminds again…` |
| 83 | 失败重试 3 次（1、5、15 分钟），之后看到失败记录 | `reminders.spec.ts › 设置: 全天提醒时间 and the list of failed reminders`（失败记录的界面） | 重试间隔不适合 E2E：API `reminders.test.ts › retries 1, 5 and 15 minutes after a failure, then records the failure`、`reminders-review.test.ts › an SMTP 5xx rejection is retried…`（假接收端按需失败） |
| 84 | 停机期间错过的提醒恢复后补发（24 小时内） | —（要停服务） | API `reminders.test.ts › sends reminders due at most 24 hours ago and skips older ones`、`› a retry is given up only when…`、`reminder-crash.test.ts`；`habit-reminders.test.ts › catches up after a downtime of less than 24 hours…` |
| 85 | 授权码和 Webhook 加密存储，界面只显示脱敏值 | `notification-channels.spec.ts › 飞书 channel: …`、`› 邮件 channel: …`（页面只有 `****`） | 单元 `packages/server/src/notify/credentials.test.ts`；API `channels.test.ts`、`channels-review.test.ts` |

## 番茄专注

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 86 | 番茄钟默认 25/5/15、每 4 个长休，可调 | `focus.spec.ts › start a 番茄…`（默认 25:00）、`› a 1-minute 番茄 ends…`（番茄设置）；主流程 3 | API `focus.test.ts › goes into a 短休息 by itself…, and a 长休息 after the 4th`；单元 `focus.test.ts` |
| 87 | 正计时 | `focus.spec.ts › start a 番茄 …`（运行中正计时被锁定） | API `focus.test.ts › counts up until 结束, pauses excluded, and is recorded` |
| 88 | 关联任务或不关联 | `focus.spec.ts › start a 番茄 for a task…`；主流程 3 | API `focus.test.ts` |
| 89 | 暂停、继续、放弃 | `focus.spec.ts › start a 番茄 for a task, pause, reload, 继续 and 放弃` | API `focus.test.ts › 放弃 ends the 番茄 without a record or a break` |
| 90 | 刷新或换设备后继续 | `focus.spec.ts › … pause, reload…`；主流程 3（运行中刷新） | API `focus.test.ts`（计时在服务端） |
| 91 | 结束时页面提示音；页面关着走通知渠道 | `focus.spec.ts › a 1-minute 番茄 ends while the page is open…`（页面内提示） | 页面关着的投递：API `focus.test.ts › page closed: the server ends the 番茄 and the fake receiver gets the message` |
| 92 | 专注记录、按天周月统计、任务累计时长 | `focus.spec.ts › a 1-minute 番茄 ends…`（记录、概览、任务用时）；主流程 3 | API `focus.test.ts`；单元 `focus.test.ts` |

## 习惯打卡

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 93 | 每天、每周固定几天、每周 N 次 | `habits.spec.ts › 打卡, 补打卡, 撤销…`（每周固定几天）、`› 习惯 list with habits` | API `habits.test.ts`；单元 `habits.test.ts` |
| 94 | 完成一次或数量型目标 | `habits.spec.ts › 打卡, 补打卡, 撤销…`（喝水 3 杯） | API `habits.test.ts` |
| 95 | 习惯提醒 | `habits.spec.ts › 打卡, 补打卡, 撤销…`（添加提醒） | 投递：API `habit-reminders.test.ts` |
| 96 | 打卡、补打卡、撤销 | `habits.spec.ts › 打卡, 补打卡, 撤销…`；主流程 4 | API `habits.test.ts`、`habits-edge.test.ts` |
| 97 | 连续天数、月度日历、完成率 | `habits.spec.ts › 打卡, 补打卡, 撤销, 连续 and 完成率…`；主流程 4 | 单元 `habits.test.ts` |
| 98 | 归档或删除习惯 | `habits.spec.ts › … 归档 and 删除` | API `habits.test.ts` |

## 倒数日

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 99 | 倒数日和纪念日 | `countdowns.spec.ts › 倒数日 cards, add with 农历 and 每年…` | API `countdowns.test.ts`；单元 `countdowns.test.ts` |
| 100 | 每年重复，农历日期 | `countdowns.spec.ts › 倒数日 cards, add with 农历 and 每年…` | 单元 `countdown-dates.test.ts`、`lunar.test.ts` |
| 101 | 倒数日提醒 | `countdowns.spec.ts › 倒数日 cards…`（设置提醒） | 投递：API `countdowns.test.ts › sends a reminder on time to every default channel…` |

## 统计、主题与快捷键

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 102 | 每天、周、月的完成数、完成率、专注时长、习惯 | `statistics.spec.ts › 统计: 完成数 without 放弃, 成就值, trends by 日 / 周 and 本周打卡进展`；主流程 3（专注时长）、主流程 4（打卡完成率） | API `statistics.test.ts`、`statistics-review.test.ts`；单元 `statistics.test.ts` |
| 103 | 成就分和等级 | `statistics.spec.ts › 统计: … 成就值…` | 单元 `achievement.test.ts` |
| 104 | 浅色、深色、跟随系统，约 8 种主题色 | `theme.spec.ts › 外观: 深色 changes every screen…`、`› 外观: 跟随系统…`、`› 外观: each 颜色系列…` | API `theme-settings.test.ts`；单元 `theme.test.ts` |
| 105 | 快捷键 N、Ctrl+K、1/2/3/0、Tab | `shortcuts.spec.ts › keyboard › …`（每个快捷键一条） | — |
| 106 | `?` 打开速查面板 | `shortcuts.spec.ts › ? opens the 快捷键 panel…`、`› ? opens the panel on the 390px layout too` | — |

## 移动端

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 107 | 手机布局：抽屉侧栏，底部导航 | `mobile.spec.ts › 移动布局 › 底部导航…`、`› 390px: every main page fits the screen`（只跑 390px）；全部主流程的 390px 一轮都用底部导航和「更多」切换模块 | — |
| 108 | 左滑删除、右滑完成 | `mobile.spec.ts › 移动布局 › 右滑完成任务、左滑删除任务 (touch)`（只跑 390px） | — |
| 109 | 添加到主屏幕 | `mobile.spec.ts › PWA › Chrome reports the app as installable…` | — |

## 导入导出

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 110 | 整个账户导出 JSON | `backup.spec.ts › 生成备份, 导出 CSV and 导入本地备份…`；主流程 5 | API `backup.test.ts`；单元 `backup.test.ts` |
| 111 | 任务导出 CSV | `backup.spec.ts › 生成备份, 导出 CSV…` | API `backup.test.ts` |
| 112 | 导入本应用的 JSON | `backup.spec.ts › … 导入本地备份 into another account`；主流程 5（各类数据导入前后一致） | API `backup.test.ts`、`backup-review.test.ts` |
| 113 | 导入滴答 CSV | `backup.spec.ts › 导入滴答清单备份…`；主流程 9 | API `backup-ticktick.test.ts`；单元 `ticktick-csv.test.ts`（mock 示例 `packages/server/test/fixtures/ticktick-backup.mock.csv`） |

## 节假日数据

| # | 用户故事 | E2E | 其他层 / 说明 |
| --- | --- | --- | --- |
| 114 | 设置页显示最后更新时间，可立即更新 | `settings.spec.ts › 节假日数据 shows the last update time and updates on 立即更新`（compose 运行里从本机的 holiday-cn 替身拉取） | API `holidays.test.ts`、`holiday-jobs.test.ts` |
| 115 | 拉取失败时用镜像内置数据 | —（要让数据源失败） | API `holidays.test.ts › falls back to the built-in data and logs it`、`› before the first fetch uses the built-in data…`、`› keeps the stored data and logs a warning when fetching fails` |
