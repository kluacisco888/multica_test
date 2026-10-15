# multica_test：复刻滴答清单

本项目的目标是像素级复刻[滴答清单](https://dida365.com/)（TickTick）的网页版。

产品名为「叮叮清单」，只在 `packages/shared/src/product.ts` 的 `PRODUCT_NAME` 定义一次，Web 和服务端都引用它；compose 项目名、镜像名、数据卷、数据库名等技术标识仍是 `dida-clone`。

验收和迁移：[验收手册](docs/acceptance-manual.md)（`ssh -L` 访问、按功能逐项检查、备份并迁移到自己的服务器、以后接 CloudFront 要改的配置）。

开发由 Multica 上的智能体小队「软件交付小队」完成，需求与任务记录在 Multica 项目「复刻滴答清单」中。智能体协作约定见 `AGENTS.md` 与 `docs/agents/`，术语见 `GLOSSARY.md`，决策见 `docs/adr/`。

## 部署

需要 Docker（含 compose v2.24+）。在仓库目录执行：

```bash
cp .env.example .env      # 先改 POSTGRES_PASSWORD，并按注释生成 APP_ENCRYPTION_KEY
docker compose up -d
curl http://127.0.0.1:8090/api/health
```

compose 项目名固定为 `dida-clone`，只有 `app` 和 `postgres` 两个服务，网络 `dida-clone_default`、数据卷 `dida-clone_pgdata`（数据库）和 `dida-clone_appdata`（附件，容器内 `/data/attachments`）都归这个项目独有。PostgreSQL 不对宿主机开放端口。应用启动时自动执行数据库迁移。

升级：`git pull && docker compose up -d --build`。停止：`docker compose down`（不加 `-v`，否则删数据卷）。

### 端口与外部地址

所有配置都在 `.env`：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `APP_BIND` | `127.0.0.1` | 宿主机监听地址。默认只监听本机回环，不暴露到公网 |
| `APP_PORT` | `8090` | 宿主机端口 |
| `PUBLIC_URL` | `http://127.0.0.1:8090` | 用户实际访问的地址；放到反向代理或 CloudFront 后面时改成对外域名 |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | 信任哪些来源的 `X-Forwarded-For/-Proto/-Host`。可写 `true`、`false`、跳数或逗号分隔的 IP/CIDR |

机器上已有的 Multica 占用 127.0.0.1:3000、127.0.0.1:8080 和自己的 postgres 容器，系统 nginx 占用 80 端口；默认配置与它们都不冲突，也不要把 `APP_PORT` 改成这些端口。

从自己电脑访问：`ssh -L 8090:127.0.0.1:8090 <服务器>`，然后打开 http://127.0.0.1:8090 。

`GET /api/health` 返回数据库状态，以及应用按 `TRUST_PROXY` 解析后看到的 `request.protocol/host/ip`，可以用来确认反向代理配置是否生效。

## 账户

不开放注册。第一个管理员在**第一次启动**时按 `.env` 的 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 创建：只在数据库里还没有任何用户时生效，重复启动不会重复创建，之后改 `.env` 里的密码也不会覆盖已有密码。没填 `INITIAL_ADMIN_PASSWORD` 的话，用下面的 `create-user` 建。

登录后会话保存在 httpOnly Cookie `dida_session` 里（SameSite=Lax；`PUBLIC_URL` 是 https 时加 Secure），30 天不用才过期，使用期间自动续期。服务端只保存令牌的 SHA-256；密码用 argon2id 哈希。修改密码会让其他设备上的登录失效。

管理命令在容器里运行（`dida` 是 `node /app/dist/cli.js` 的包装）：

```bash
docker compose exec app dida create-user <账号> [--admin]   # 新建用户，随后输入两次密码
docker compose exec app dida reset-password <账号>          # 忘记密码时重置；该用户所有会话立即失效
docker compose exec app dida disable-user <账号>            # 停用：无法登录，已有会话立即失效；不能停用最后一个管理员
docker compose exec app dida enable-user <账号>             # 重新启用
docker compose exec app dida list-users
```

密码不走命令行参数（会留在 shell 历史和 `ps` 里）：在终端里是隐藏输入，非交互时从标准输入读一行，例如 `printf '%s\n' '新密码' | docker compose exec -T app dida reset-password admin`。密码至少 8 位。

### 后台

管理员在 设置 →「用户管理」里添加用户、停用和启用用户、重置密码；普通用户看不到这个分类。接口都在 `/api/admin/` 下，`src/auth.ts` 对这个前缀统一加管理员检查：未登录 401，登录了但不是管理员 403 `forbidden`。角色和停用状态每次请求都从数据库读，降级或停用立即生效。

| 接口 | 说明 |
| --- | --- |
| `GET /api/admin/users` | 所有用户（不含密码哈希），按创建时间排序 |
| `POST /api/admin/users` | `username`、`password`（至少 8 位）、`isAdmin` 选填；重名 409 `username_taken` |
| `PATCH /api/admin/users/:id` | `{ "disabled": true/false }`。停用后该用户所有会话立即失效；不能停用自己（400 `cannot_disable_self`），不能停用最后一个未停用的管理员（400 `last_admin`，CLI 同样适用） |
| `POST /api/admin/users/:id/password` | `{ "password": "…" }`，204。该用户所有会话失效；重置自己的密码时保留当前会话 |

## 备份与恢复

```bash
scripts/backup.sh                       # → backups/dida-clone-<UTC时间>.tar.gz
scripts/restore.sh backups/xxx.tar.gz   # 覆盖当前项目的数据库和附件，需要输入项目名确认
```

备份文件是一个 `.tar.gz`，里面有 `manifest.json`、数据库 dump（`pg_dump -Fc`）和附件目录打包 `attachments.tar`。备份时应用可以在运行；恢复会先停 `app`，替换数据库和附件后再启动。

附件文件存在数据卷的 `/data/attachments/<用户 id>/<附件 id>`，数据库只记文件名、类型和大小，所以两者必须一起备份和恢复（脚本就是这样做的）。`scripts/backup-restore-smoke.sh` 会起两个临时 compose 项目（`dida-smoke-src` / `dida-smoke-dst`，端口 18291 / 18292），上传一个附件、备份、恢复到另一个项目，再下载比对字节，并确认其他用户拿到 404，最后 `down -v` 删除这两个临时项目；CI 的 compose 任务会跑它。

两个脚本都操作当前目录下的 compose 项目，用 `COMPOSE_PROJECT_NAME` 指定别的项目。例如在同一台机器上恢复一份副本做核对，不影响正在运行的服务：

```bash
COMPOSE_PROJECT_NAME=dida-restore APP_PORT=8091 scripts/restore.sh backups/xxx.tar.gz --yes
curl http://127.0.0.1:8091/api/health
docker compose -p dida-restore down -v   # 核对完删除副本
```

### 迁移到新服务器

1. 旧服务器：`scripts/backup.sh`。
2. 把**备份文件和 `.env` 一起**拷到新服务器的仓库目录。**`.env` 必须带走**：`APP_ENCRYPTION_KEY` 不在备份里，丢了它，加密保存的通知渠道凭证就再也解不开；`POSTGRES_PASSWORD` 也要保持一致。
3. 新服务器：`docker compose build && scripts/restore.sh <备份文件>`。
4. `curl http://127.0.0.1:8090/api/health` 确认正常后，再停掉旧服务器。

迁移前后核对数据（每张表的行数和校验和、附件 sha256）的命令见[验收手册](docs/acceptance-manual.md)「核对数据一致」。`scripts/migration-drill.sh` 在本机用两个临时 compose 项目（`dida-drill-old` / `dida-drill-new`，端口 18391）把这四步完整演练一遍：填入各类数据、备份、在只拿到备份和 `.env` 的全新目录里恢复、比对指纹、HTTP 检查、重新部署，最后全部清理，并确认 Multica 和系统 nginx 没被动过（EURO-31，CI 的 compose 任务也跑它）。

### 回滚数据库迁移

每个迁移 `packages/server/drizzle/<tag>.sql` 都有对应的 `drizzle/rollback/<tag>.sql`（测试会检查）。回滚最近一个迁移：

```bash
docker compose stop app
docker compose run --rm app node dist/db/rollback-cli.js
```

回滚后要先切回旧版本镜像再启动，否则应用启动时会把迁移重新执行一遍。

## 开发

需要 Node 24、pnpm 10（`corepack enable`）和 Docker。

```bash
pnpm install
pnpm exec playwright install chromium   # 首次
pnpm check        # lint + 类型检查 + 全部测试
```

结构：

```text
packages/
├── shared/   # 前后端共用：zod schema、类型、纯领域逻辑
├── server/   # Fastify API + 静态文件；drizzle/ 是迁移
└── web/      # React + Vite
e2e/          # Playwright
scripts/      # 备份、恢复、测试辅助
```

### 测试

`pnpm test` 一条命令跑完四层：

| 层 | 命令 | 位置 |
| --- | --- | --- |
| 纯逻辑单元测试 | `pnpm test:unit` | `packages/*/src/**/*.test.ts` |
| API 集成测试（真实 PostgreSQL） | `pnpm test:api` | `packages/server/test/api/` |
| 假 SMTP / 假 Webhook 测试工具 | `pnpm test:fakes` | `packages/server/test/fakes/` |
| Playwright 冒烟测试（1440px 和 390px） | `pnpm test:e2e` | `e2e/` |

API 测试和 e2e 用的 PostgreSQL：设置了 `TEST_DATABASE_URL` 就用它（CI 就是这样）；否则自动启动 `docker-compose.test.yml`（项目 `dida-clone-test`，`127.0.0.1:55432`，数据在 tmpfs）。每个测试文件建一个独立的数据库。用完可以 `pnpm test:db:down`。同一台机器上同时跑两套 e2e 时，给其中一套设 `E2E_PORT` 和 `E2E_DATABASE`（默认 18090 / `dida_e2e`）。

写 API 测试用 `packages/server/test/support/test-app.ts` 的 `createTestApp()`：真实 Fastify + 迁移好的独立数据库，时钟可注入，`createUser()` 建用户并真实登录，返回带会话 Cookie 的请求头。e2e 用 `e2e/support.ts` 的 `createUser()`（调用构建好的 `dida` CLI）给每个测试建独立用户；e2e 服务器的初始管理员是 `admin` / `e2e-admin-password`。

#### 在 compose 部署里跑 e2e（验收用）

```bash
pnpm test:e2e:compose -- --project=desktop      # 1440px 一轮
pnpm test:e2e:compose -- --project=mobile       # 390px 一轮
node scripts/e2e-compose.mjs --project-name dd-e2e --port 18190 --pg-port 18191 -- e2e/acceptance-flows.spec.ts
```

`scripts/e2e-compose.mjs` 每次都起一套全新的部署再测，测完清理：

1. 确认 `127.0.0.1` 上的端口空闲、compose 项目还不存在（拒绝 `dida-clone` 和 `multica` 这两个项目名）。
2. 照 `cp .env.example .env` 在 `test-results/compose-e2e/<项目名>/.env` 生成本次的配置，只改端口、随机密钥、e2e 管理员密码和节假日数据地址。仓库根目录的 `.env` 不用也不改。
3. `docker compose -p <项目名> -f docker-compose.yml -f docker-compose.e2e.yml up -d --build --wait`。叠加文件只给测试用：镜像打成 `dida-clone-app:e2e`（不覆盖 `dida-clone-app:local`）、PostgreSQL 映射到 `127.0.0.1:<pg-port>`（只给 `e2eSql` 用），容器里加上 `host.docker.internal`。
4. Playwright 直接连 `http://127.0.0.1:<port>`，不起 `scripts/e2e-server.mjs`。`dida …` 在 app 容器里执行；假 SMTP、假飞书和 holiday-cn 替身在测试进程里，监听 Docker 网桥（`docker0` 网关），容器通过 `host.docker.internal` 访问，消息不出本机（这几个替身本机上的其他容器也能连到，只在测试期间存在）。
5. 最后 `docker compose -p <项目名> down -v`，并检查这个项目没有剩下容器、数据卷和网络；有剩余就以失败退出。`--keep` 跳过清理，方便排查，清理命令会打印出来。

`e2e/acceptance-flows.spec.ts` 是跨功能的主流程（EURO-33）。用户故事 1–115 和测试的对应关系见 `docs/e2e-coverage.md`。

### CI

CI 定义在 `.github/workflows/ci.yml`，在 GitHub Actions 上对每个 PR 和 main 的每次推送运行，每个 PR 都要过 CI。`check` 任务跑的就是本地 `pnpm check` 的那几步（lint、构建、类型检查、四层测试，API 测试和 e2e 用 Postgres service 容器）；`compose` 任务再跑一遍 compose 部署和备份恢复的冒烟测试。

### 数据层约定（ADR-0004）

- 新建同步实体的表时，展开 `syncColumns()`（UUID 主键、`user_id`、`created_at`、`updated_at`、`revision`、`deleted_at`）并加 `syncIndex()`，然后在 `packages/server/src/sync/registry.ts` 注册。
- 写这些表一律通过 `app.sync.transaction(userId, ops => ...)`：`ops.insert / update / softDelete` 会分配该用户新的修订号、按注入的时钟写 `updated_at`，删除只写 `deleted_at` 留下墓碑，并且只能改自己的数据。
  唯一的例外：只改墓碑（已软删除行）里不对外下发的字段时可以直接写、不分配修订号，例如删除标签时清理回收站任务上的标签 id（`routes/tags.ts`）。
- `app.sync.transaction` 一开始就拿该用户修订号那一行的行锁（`lockRevision`，不加修订号），一直持有到提交。所以同一用户的写事务一个接一个执行，锁顺序也固定（先修订号行，再 advisory 锁和其他行锁）。事务里检查「标签 / 清单还在不在」再写任务，并发的删除标签、删除清单不会插进检查和写入之间（EURO-35）。
- `GET /api/changes?since=<revision>` 按实体类型返回 `upserts` 和 `tombstones`，以及当前 `revision`，下一次把它作为 `since` 传回。
- `/api` 下的接口默认都要登录（`src/auth.ts` 在 `onRoute` 里统一加 `app.authenticate`），未登录返回 401；只有声明了 `config: { public: true }` 的才公开（目前只有 health、login、logout，`test/api/access-control.test.ts` 会核对这份清单并逐个检查其余接口返回 401）。处理函数里用 `sessionUser(request)` 拿当前用户。
- 按 id 读资源用 `findOwned(app.db, table, userId, id)`，写用 `app.sync.transaction`：别人的、已删除的、不存在的、非法 id 一律返回 null，接口统一回 404。

### 清单、文件夹与任务 API

| 接口 | 说明 |
| --- | --- |
| `GET /api/lists` | 侧栏：`lists`（收件箱在最前，首次访问时自动创建）、`folders`、`openTaskCounts` |
| `POST/PATCH/DELETE /api/lists[/:id]` | 清单：名称、颜色、图标、`folderId`、`sortOrder`。收件箱不能改、不能删、不能归档（400 `inbox_protected`）；`archived: true/false` 归档 / 取消归档（响应里的 `archivedAt`），归档的清单仍在 `GET /api/lists` 里返回，由前端放进「已归档的清单」，其中的任务不进任何智能清单（`listInSmartLists()`，见下）；删除清单会把其中的任务移进回收站，还原时回到收件箱 |
| `POST/PATCH/DELETE /api/folders[/:id]` | 文件夹（只有一层）：名称、`collapsed`、`sortOrder`。删除文件夹时，其中的清单移到文件夹原来的位置 |
| `GET /api/tasks?listId=` 或 `?tagId=` | 未完成任务按排序键，已完成任务在后、最近完成的在前；按标签查看时跨清单，父标签包含子标签的任务 |
| `GET/POST/PATCH /api/tasks[/:id]` | 不指定清单进收件箱；新建和移入的任务排在最前；`status`：`open` / `completed` / `abandoned`（放弃，`abandonedAt` 记时间，`completedAt` 为空，不算完成）；`priority`：`high` / `medium` / `low` / `none`；`tagIds` 整体替换，只能用自己未删除的标签（否则 400 `invalid_tags`）；`dates` 见下 |
| `parentId`（POST / PATCH） | 子任务：跟父任务在同一个清单，新建时排在兄弟任务最后；最多 5 层（根任务算第 1 层），超过返回 400 `depth_exceeded`；父任务不存在、是别人的、是自己或自己的子任务返回 400 `invalid_parent`。移到别的清单时整棵子树一起走，子任务移走后变成顶层任务 |
| 完成规则 | 完成（放弃）任务会把下面所有未完成的子任务一起完成（放弃）；取消完成父任务不动子任务；把子任务改回未完成会把已完成或已放弃的上级一起改回未完成 |
| `DELETE /api/tasks/:id` | 删除：任务连同子任务、检查项移进回收站（软删除，`/api/changes` 里是墓碑），204 |
| `GET /api/trash` | 回收站：用户删除的那个任务（子任务跟着它，不单独列出），最近删除的在前，带 `deletedAt` |
| `POST /api/trash/:id/restore` | 还原：任务、子任务和检查项一起恢复（新修订号）；原清单已删除就回到收件箱，父任务不在了就变成顶层任务 |
| `DELETE /api/trash/:id`、`DELETE /api/trash` | 彻底删除一个 / 清空回收站：清空标题、描述、日期、标签和检查项文字，附件和评论也变成墓碑并清空文件名和评论内容，墓碑保留。附件文件在事务提交后删除；删除失败时附件行已是墓碑、文件还在，下一次清理（`trash.purge` 或下一次彻底删除）会重试。后台任务 `trash.purge`（pg-boss，每天 03:30 和启动时各一次）对删除满 30 天的任务做同样的清理。应用每次启动还会执行幂等的 `cleanUpPurged()`，补清理 EURO-32 之前彻底删除留下的附件和评论 |
| `kind`（PATCH） | `text` ⇄ `checklist`：描述每个非空行变成一个检查项（去掉 `- `、`1. `、`[x]` 等列表标记，`[x]` 记为已勾选），描述清空；切回时每个检查项变成一行描述（勾选状态不保留），检查项删除（墓碑） |
| `GET/POST /api/tasks/:id/checklist-items` | 检查项列表 / 新建（只能加到检查清单模式的任务上，否则 400 `not_checklist`），默认排在最后 |
| `PATCH/DELETE /api/checklist-items/:id` | 勾选、改文字、`sortOrder` 排序；删除是软删除。检查项在 `/api/changes` 里的实体类型是 `checklistItem` |
| `GET/PATCH /api/settings` | 设置：`timeZone`（IANA 名称，默认 `Asia/Shanghai`）、`hiddenSmartLists`（侧栏隐藏的智能清单）、`viewOptions`（每个视图的排序 / 分组和 `layout`：`list` 列表、`timeline` 时间线，不写就是列表；按视图合并，传 `null` 恢复默认）。`matrixQuadrants`：四象限的四个象限（`name` + 和过滤器相同的 `rules`），整体替换，必须正好 4 个，传 `null` 恢复默认；规则只能引用自己的清单和标签（400 `invalid_list` / `invalid_tags`），已删除的清单和标签读出时去掉。第一次修改时才建行，同步类型 `settings` |
| `GET /api/tasks?smart=` | 智能清单：`today` / `tomorrow` / `week` / `completed` / `notImportant`，规则在 `packages/shared/src/smart-lists.ts`。`excludeFromSmartLists`（不进智能清单）的清单和归档的清单不参与，判断只在 `listInSmartLists()` 一处，服务端和前端共用 |
| `GET /api/tasks?view=matrix` | 四象限：未完成和已完成的任务（不含放弃、已删除和归档清单里的），只返回某个象限会收下的。默认象限按优先级高 / 中 / 低 / 无划分；一个任务只进第一个符合规则的象限，哪个象限都不收的不显示。规则和分象限在 `packages/shared/src/matrix.ts`（`quadrantMatcher`），服务端和前端共用。拖到另一个象限就是 `PATCH /api/tasks/:id` 改 `priority`：象限规则里只有一个优先级时用它，否则按位置（一高、二中、三低、四无，`quadrantPriority`） |
| `GET /api/smart-lists` | 侧栏数量：今天 / 明天 / 最近7天的未完成任务数 |
| `GET/POST/PATCH/DELETE /api/filters[/:id]`、`GET /api/tasks?filterId=` | 过滤器：`rules` 是 `listIds`、`tagIds`（父标签含子标签）、`untagged`、`dates`（`overdue`/`today`/`tomorrow`/`week`/`noDate`）、`priorities`；同一项内任一满足，不同项全部满足，空项不限制。不进智能清单的清单照样能被选中。只能引用自己的清单和标签（400 `invalid_list` / `invalid_tags`），同步类型 `filter` |
| `GET /api/search?q=` | 全局搜索：标题、描述、检查项、评论（不分大小写，`%` `_` 按字面），返回 `tasks`、`matches`（每个任务在哪些字段命中）、`truncated`（最多 200 条）。每个字段是 `src/search.ts` 里 `searchSources` 的一项；不按清单过滤，所以不进智能清单和归档的清单都能搜到 |
| `GET/POST/PATCH/DELETE /api/tags[/:id]` | 标签：名称（不含空格和 `#`，同一用户内不分大小写唯一，重名 409 `tag_name_taken`）、颜色、`parentId`、`sortOrder`。只嵌套一层：父标签必须在顶层，有子标签的标签不能再放进别的标签（400 `invalid_parent`）。删除标签会把它从所有任务上去掉（任务本身不变），子标签移到顶层原来的位置 |

任务的 `dates`（`packages/shared/src/task-dates.ts`）：`null` 是不设日期；全天是 `{ allDay: true, startDate, dueDate }`，按日历日期存，不随时区换算；带时间是 `{ allDay: false, startAt, dueAt, timeZone }`，存 UTC 时间点，`timeZone` 由服务端按用户当时的设置写入，显示时一律用用户**当前**时区。`startDate` / `startAt` 为 null 就是只有截止日期。列表上的「今天 / 明天 / 周几 / 已过期」由 `describeTaskDates()` 算。

### 附件与评论

| 接口 | 说明 |
| --- | --- |
| `GET /api/tasks/:id/attachments` | 任务的附件，按上传时间排序：`fileName`、`mimeType`、`size`（字节）、`preview`（`image` / `pdf` / null） |
| `POST /api/tasks/:id/attachments?name=<文件名>[&id=<uuid>]` | 上传：请求体就是文件本身（不是 multipart），`Content-Type` 是文件类型。单个文件最多 50MB，超过返回 413 `file_too_large`（先看 `Content-Length`，没有时边收边数，超过就丢弃）。文件名不能含 `/`、`\` 和控制字符，最多 255 字 |
| `GET /api/attachments/:id/content` | 下载，只有附件所属用户能下，别人和不存在的一样回 404。只有 PNG / JPEG / GIF / WebP / AVIF / BMP 和 PDF 用 `inline` 返回给浏览器预览，其他类型（包括 SVG、HTML）一律按 `application/octet-stream` + `attachment` 下载，并带 `nosniff`，上传的文件不能在本站执行脚本。`?download=1` 强制下载 |
| `DELETE /api/attachments/:id` | 软删除：留墓碑，磁盘上的文件删掉 |
| `GET/POST /api/tasks/:id/comments` | 评论，按时间正序；`content` 去掉首尾空白后 1–5000 字，纯文本（没有 @人） |
| `PATCH/DELETE /api/comments/:id` | 编辑（写入 `editedAt`）、软删除 |

两者都是同步实体，`/api/changes` 里的类型是 `attachment` 和 `comment`。界面上：附件在描述下面，图片显示大图、点开预览，PDF 在对话框里预览，其他文件点卡片下载；上传入口在详情右下角「⋯」菜单的「上传附件」。评论在详情最下面，底栏的评论按钮打开输入框，Enter 发送、Shift+Enter 换行，每条评论的菜单里可以编辑和删除。

### 通知渠道（ADR-0005）

| 接口 | 说明 |
| --- | --- |
| `GET /api/notification-channels` | 当前用户的通知渠道，按创建时间排序；凭证只返回脱敏值（如 `https://open.feishu.cn/****90ab`、`****5678`） |
| `POST /api/notification-channels` | `type` 为 `feishu`（`webhookUrl` 必填，`secret` 选填）或 `email`（`host`、`port`、`security`=`ssl`/`starttls`/`none`、`username`、`password` 即授权码、`to`）；`isDefault` 可以有多个 |
| `PATCH /api/notification-channels/:id` | 凭证字段不传或传空字符串就保留原值；飞书 `secret: null` 关闭签名；渠道类型不能改 |
| `DELETE /api/notification-channels/:id` | 软删除 |
| `POST /api/notification-channels/:id/test` | 发送测试消息：成功 200，失败 502 `channel_send_failed`，`message` 是具体原因（飞书错误码、SMTP 返回等） |

Webhook URL、签名 secret 和授权码用 `APP_ENCRYPTION_KEY` 做 AES-256-GCM 加密后存在 `notification_channels.credentials`（密文与用户 id、渠道 id 绑定），脱敏值另存一列，所以列表和 `/api/changes` 不需要解密，也不会带出密文。没配 `APP_ENCRYPTION_KEY` 时应用照常启动，但保存和测试渠道返回 503 `encryption_key_missing`。

提醒、专注、习惯统一用 `app.notifier` 发消息（`src/notify/notifier.ts`）：

```ts
const ids = await app.notifier.defaultChannelIds(userId);
const result = await app.notifier.send(userId, channelId, { title: '提醒：交周报', body: '今天 18:00' });
// { ok: true } | { ok: false, error: '具体原因', retryable: boolean }  —— 不抛异常
```

`retryable` 为 true 表示网络错误、超时、HTTP 5xx、SMTP 4xx 这类可以稍后重试的失败；授权码错误、签名错误等需要用户改配置的为 false。

时间线（`packages/shared/src/timeline.ts`）：横条从开始日画到截止日（含两端），只有截止日期就是截止那一天的一格，没有日期的任务不画横条，放在右侧「待安排」里，拖到某一天就设成那天截止的全天任务。拖动整条两个日期一起移，拖动两端只改开始或截止日期，一端越过另一端时收成只有截止日期；带时间的任务按整天移动、保留当天钟点（按用户当前时区）。改日期仍走 `PATCH /api/tasks/:id`，没有新接口。键盘：横条上 ←/→ 移一天，Shift 改截止日期，Alt 改开始日期。

### 提醒调度与投递

任务上的 `reminders`：带时间的任务用 `{ type: 'before', minutes }`（0 = 准时，时间段从开始时间算），全天任务用 `{ type: 'day', daysBefore, time }`（`time: null` 表示用设置里的 `allDayReminderTime`，默认 09:00）。`reminderChannelIds` 为 null 时发到默认渠道。提醒和日期类型不符返回 400 `invalid_reminders`，`reminderChannelIds` 里有不存在或别人的渠道返回 400 `invalid_channels`；改日期类型时不符的提醒被去掉，清空日期时提醒一起清空。纯规则（触发时间、重试间隔、24 小时补发窗口、文案）在 `packages/shared/src/reminders.ts`。

调度表是 `reminder_deliveries`（提醒投递记录），逻辑在 `packages/server/src/reminders/scheduler.ts`：

- 任何写任务的事务（新建、修改、完成、放弃、删除、还原、重复任务生成下一次）提交前都会经过同步层的写钩子 `sync.onWrite(tasks, …)`，把这个任务待发的提醒对齐：时间变了就取消旧的、排新的，任务关闭或删除就取消。改全天提醒时间或时区也会重排。已经过去的时间不补排。
- `tick()` 发送到点的提醒：触发前再核对一次任务，逐个渠道发送，所有失败（包括签名错误、授权码错误这类要改配置的）都按 1、5、15 分钟重试三次，仍失败就记为失败；任务指定的渠道已被删除时，照常弹应用内提醒，并为每个已删除的渠道记一条失败（原因「渠道已删除」）。到点超过 24 小时才轮到的提醒记为 `missed`，不补发；停机超过 24 小时错过的重试记为失败。稍后提醒只在任务完成、放弃或删除时取消。
- pg-boss 队列 `reminders.tick`：启动时跑一次（补发停机期间的），每分钟跑一次兜底，另外每个触发 / 重试时间点各排一个 `startAfter` 任务，所以准时误差约 1–2 秒。

| 接口 | 说明 |
| --- | --- |
| `GET /api/reminders/alerts` | 应用内提醒：一小时内触发、还没关掉、任务仍未完成的提醒；页面每 15 秒拉一次 |
| `POST /api/reminders/alerts/:id/dismiss` | 关闭弹窗 |
| `POST /api/reminders/alerts/:id/snooze` | 稍后提醒：`{ minutes }`，到时再走一遍渠道和弹窗；同一条提醒只能稍后提醒一次（行锁），已关闭或已稍后提醒过的返回 409 `alert_dismissed` |
| `GET /api/reminders/failures` | 重试后仍失败的投递（最近 50 条），设置 →「提醒与通知」里显示 |

排序键是分数索引（`packages/shared/src/sort-key.ts`），拖拽只改被拖动的那一条；侧栏拖放规则在 `packages/shared/src/sidebar-order.ts`。界面的设计 token 和组件约定见 `packages/web/src/ui/README.md`。

### 拖拽排序、置顶与批量操作

| 接口 | 说明 |
| --- | --- |
| `POST /api/tasks/:id/move` | 拖拽排序：`{ afterId }` 放到同组任务 `afterId` 的后面（null 放到最前）。同组是同一清单、同一父任务的兄弟任务；已置顶的任务在用户的已置顶任务里排。`afterId` 不在同组返回 400 `invalid_position`。响应 `tasks` 是排序键变了的任务 |
| `PATCH /api/tasks/:id` 的 `pinned` | 置顶 / 取消置顶：任务的 `pinOrder` 不为 null 就是置顶，排在「已置顶」组的最前（新置顶的在前），`pinOrder` 按用户全局排（不分清单，跨清单的视图里已置顶分组的顺序也一致；代价是已置顶的键太长需要重新均分时，用户所有清单里的置顶任务都会拿到新修订号），`sortOrder` 不变，取消置顶回到原来的位置。只有顶层任务能置顶（400 `invalid_pin`），变成子任务时自动取消置顶；重复任务的下一次沿用置顶 |
| `POST /api/tasks/batch` | 批量操作：`{ ids, action }`，`action.op` 是 `complete`、`abandon`、`delete`（软删除进回收站）、`move`（`listId`，按给出的顺序放到目标清单最前）、`dates`（`dates` 或 null）、`priority`、`tags`（`add` / `remove`，保留其他标签）、`pin`。一个事务，全部成功或全部不变；有一个 id 不是自己未删除的任务就 404。最多 500 个 |

拖拽和新建任务通常只写一条排序键；同一位置插入很多次、键长度超过 `SORT_KEY_REBALANCE_LENGTH`（16）时，这一组任务一起换成均匀分布的短键（`placeAt`，`packages/server/src/task-order.ts`），每条都走同步层、有新修订号。界面：清单在「自定义」排序下可以拖动任务行（只在同组里），键盘用 Alt+↑/↓；Ctrl/Cmd+点击加减一条、Shift+点击连选（和参照一样从第一次点击的任务开始，跨分组），键盘是 Shift/Ctrl+Enter，Esc 取消；选中两条以上时右侧变成「已选择 N 项」，手机上是底部浮动工具栏（手机上 Ctrl/Shift+点击一条就进入多选），选中任务的右键菜单是批量菜单。选择逻辑在 `packages/shared/src/task-selection.ts`，放下位置在 `list-drag.ts`。

### 日历视图

| 接口 | 说明 |
| --- | --- |
| `GET /api/tasks?from=YYYY-MM-DD&to=YYYY-MM-DD` | 日历一页里的任务：按用户**当前**时区，任何一天落在 `from`–`to` 里的未完成和已完成任务（日期区间只要有重叠就算），不含放弃的、已删除的和归档清单里的。最多 62 天，`from` 晚于 `to` 或超长返回 400 |
| `GET /api/calendar/days?from=&to=` | 每天的农历（`lunarMonthName`、`lunarDayName`）、节日（传统节日在前，再是 `solarFestivals()` 的公历节日，如国庆节、万圣夜）、节气、格子里显示的 `label` 和 `labelKind`（节日 > 节气 > 初一显示月份 > 农历日；节日用节日色），以及 `mark`：`holiday`（休）/ `makeup_workday`（班）和所属假日名。农历来自 `@dida/shared/lunar`，休 / 班来自 `app.holidays.calendar()`，和重复任务用的工作日日历是同一份数据 |

界面在 `/calendar`（上次用的视图、今天）和 `/calendar/<month|week|day|multiDay>/<日期>`：月视图每周一行（和参照一样从周日开始），日期区间画成跨天的长条；视图在标题右边的下拉框里切换；周 / 日 / 多日（3 天）上面是日期和全天任务，下面是 24 小时时间格。拖动改日期的规则都在 `packages/shared/src/calendar.ts`：月视图里拖到别的日子是整体平移（`moveTaskByDays`，带时间的任务保持当前时区下的钟点，跨夏令时也一样）；拖到时间格是从那个时间开始、时长不变（`placeTaskAt`，全天任务变成一个时间点）；拖到全天栏变成全天任务、天数不变（`placeTaskOnDay`）。点空白的日子或时间格新建任务（进收件箱）。拖拽只支持鼠标；键盘和触屏打开任务后在详情里改日期。

### 番茄专注

计时状态在服务端（`focus_sessions`，同步类型 `focusSession`），每个用户同时最多一个进行中或暂停的专注（唯一索引）。状态机在 `packages/server/src/focus/service.ts`：每次读取或操作前先按注入时钟的“现在”结算——倒计时到点的番茄在到点那一刻记为完成，并从那一刻自动开始短休息或长休息（距上次长休息完成的第 `longBreakEvery` 个番茄后是长休息），休息到点后回到未开始。所以刷新、换设备、隔几小时再打开，看到的都是正确状态。纯规则（剩余时间、休息类型、统计、文案）在 `packages/shared/src/focus.ts`。

- 页面开着时（任何页面，不只专注页），倒计时到 0 就读一次当前专注，由此结算并播放提示音（Web Audio，第一次点按钮时解锁）。
- pg-boss 队列 `focus.tick`：启动时、每分钟、以及每个倒计时结束点后 15 秒（`FOCUS_NOTIFY_GRACE_MS`）跑一次，结算到点 15 秒后还没被页面结算的番茄（视为页面已关），并通过默认通知渠道（EURO-11 的 `app.notifier`）发「专注结束」，每个番茄最多一次；超过 24 小时才结算的只记录不发。休息结束不发通知。
- 番茄设置在 `PATCH /api/settings` 的 `pomodoro`（`focusMinutes` 1–180、`shortBreakMinutes` / `longBreakMinutes` 1–60、`longBreakEvery` 1–10，默认 25 / 5 / 15 / 4，按字段合并）。

| 接口 | 说明 |
| --- | --- |
| `GET /api/focus/current` | 当前专注（已结算）和服务端 `now` |
| `POST /api/focus/start` | `{ mode: 'pomodoro' \| 'stopwatch', taskId?, id? }`；已有进行中的专注返回 409 `focus_active`，休息中开始会先结束休息；别人的或不存在的任务 404 |
| `POST /api/focus/current/pause` · `resume` · `abandon` · `finish` | 暂停 / 继续 / 放弃（不留记录）/ 结束（正计时和休息；番茄不能提前结束，返回 409）。没有专注时 404 |
| `PATCH /api/focus/current` | `{ taskId }` 关联或取消关联任务 |
| `GET /api/focus/records` | 专注记录：完成的番茄和正计时，最近 100 条 |
| `GET /api/focus/stats?unit=day\|week\|month&date=` | 专注统计：周期内番茄数、专注时长、每天明细（周从周一开始）、每个任务用时，概览（今日 / 总计）和每个任务累计用时。按开始时间所在的日期（用户时区）归属 |

界面在 `/focus`（桌面从左侧导航条进入，手机从侧栏抽屉顶部的按钮进入）。

### 统计与成就分

`GET /api/statistics[?date=YYYY-MM-DD]`（只看当前用户）返回顶部汇总（任务、已完成、清单、使用天数）、概览（今日 / 总计的完成数、番茄、专注时长）、成就分，以及截至 `date` 所在周期的最近 7 天 / 7 周（周一开始）/ 7 个月的趋势：完成数、完成率（截止日在周期内、没放弃的任务里完成了多少）、番茄、专注时长、习惯打卡完成率，再加本周（周日开始）每天的打卡进展。放弃的任务不算完成，回收站里的任务不计入统计。日期一律按用户当前时区。界面在 `/statistics`（桌面左侧导航条「统计」，手机底部导航「更多」里）。

成就分（规则在 EURO-28 由维护者确认）每次根据任务和专注记录重新算，不存分数，规则只在 `packages/shared/src/achievement.ts`：按时完成（截止日当天或之前，或没设日期）+5，过期后完成 +2，番茄 +3（正计时每满 25 分钟算一个，放弃的专注不算），任务过期 −2（每个任务一次，补完成不退回），放弃、删除 0，取消完成收回加分；每天加分最多 +100，总分不低于 0。等级 10 级（新手 0、初级 100、勤奋者 300、挑战者 700、新星 1400、自由者 3000、飞跃者 6000、超级英雄 10000、传奇 20000、黄金 50000）。为了让「改日期、清空日期、彻底删除」不把已扣的过期分抹掉，任务上有一列 `overdue_on`（迁移 `0022_task_overdue_on`）：这类修改前，如果任务已经过期，就记下第一次过期的那天。

### 倒数日

| 接口 | 说明 |
| --- | --- |
| `GET /api/countdowns[?archived=true]` | 记录中（默认）或已归档的倒数日，置顶的在前。每项带按用户当前时区算好的 `next`：`date`（要显示的那一次的公历日期）、`days`、`status`（`upcoming` 还有 / `today` / `passed` 已经，即纪念日），农历倒数日另带 `lunar`（`monthName`、`dayName`） |
| `POST/PATCH/DELETE /api/countdowns[/:id]` | `name`、`icon`、`date`（录入的公历日期）、`calendar`（`solar` / `lunar`）、`repeat`（`none` / `yearly`）、`reminders`（只能是 `{ type: 'day', daysBefore, time }`，最多 5 个）、`reminderChannelIds`、`pinned`、PATCH 的 `archived: true/false`。删除是软删除，同步类型 `countdown` |

规则在 `packages/shared/src/countdown-dates.ts`（`@dida/shared/countdown`，复用 `@dida/shared/lunar`，不进前端包）：公历每年重复落在同月同日，2月29日在平年落在2月28日；农历每年重复按农历月日，小月没有三十就落在廿九；闰月的日期在有同一个闰月的年份落在闰月，其他年份落在同名的普通月。提醒是“下一次的前 N 天的某个时间”（`time: null` 用全天提醒时间），和任务提醒共用 `reminder_deliveries`（`countdown_id`）、重试、补发和失败记录；每次触发后自动排下一年的。倒数日提醒不进应用内提醒弹窗。界面在 `/countdowns`（`/countdowns/archived` 是已归档）。

### 智能识别

在「添加任务」里输入时，前端用 `packages/shared/src/smart-input.ts` 的 `parseSmartInput` 识别日期（今天/明天/后天、周X、下周X、下周、下个月、M月D日、D号、N天后、N小时后/N分钟后）、时间（上午/下午/晚上等模糊时间，早上 07:00、傍晚 17:00，以及 3点、下午3点半、15:40；不写日期的「9点」取最近的 9 点或 21 点）、重复规则（每天、每周X、每周X和周Y、每个工作日、每月D号、每年M月D日…）、「提醒我」（要和日期或时间一起写）、`*提前N分钟/小时/天`、`#标签`、`~清单`（只认已有清单）和 `!高`/`!中`/`!低`。规则按滴答的实际识别结果核对过（EURO-39）。识别出的部分在输入框里高亮，点一下（或 Tab 到它按回车）取消。保存时由 `smartCreateRequest` 合成 `POST /api/tasks` 的请求，没有的标签会先创建。

设置在「设置 → 更多设置 → 智能识别」，和滴答一样分成日期识别（日期、时间、重复、提醒）+「移除文本中的日期」、标签识别（`#标签`、`~清单`、`!优先级`）+「移除任务标题中的标签」、网址解析三个开关，默认全开。存在 `PATCH /api/settings` 的 `smartInput`（`dateParse`、`removeDate`、`tagParse`、`removeTag`、`urlParse`，以及 `morning`/`afternoon`/`evening` 模糊时间，默认 09:00/15:00/20:00；只改传入的字段）。EURO-27 存下的旧设置（`enabled` 总开关、`keepText` 保留识别文字）读取时自动换成新结构：总开关关掉的三个都关，保留识别文字的两个「移除」都不勾；下次修改时按新结构写回。网址解析目前只保存开关，还不会改写标题。

### 移动布局与 PWA

屏幕宽度小于 768px 时用移动布局：侧栏是抽屉，底部导航有 任务、日历、专注、习惯、更多（四象限、倒数日、搜索、设置）；打开任务详情、习惯详情或多选时底部导航让位。任务行上用手指右滑（超过行宽 25%、至少 72px）完成或取消完成，左滑删除（进回收站）；鼠标不触发，滑动距离不够会弹回。

应用带 Web App Manifest（`/manifest.webmanifest`，由 `packages/web/vite.config.ts` 生成）和图标（`packages/web/public/icons/`），可以「添加到主屏幕」，以独立窗口打开。没有 Service Worker：不做离线缓存，也不做 Web Push。Chrome 只在 HTTPS 或 localhost 下提示安装。改了 Logo 后运行 `node scripts/generate-pwa-icons.mjs` 重新生成图标。

### 节假日数据与农历（ADR-0006）

- 后端每天 04:15（`DEFAULT_TIMEZONE`）和每次启动时，从 `HOLIDAY_DATA_URL`（默认 jsDelivr 上的 NateScarlet/holiday-cn）拉取当年和下一年的 `<year>.json`，存进 `holiday_years` 表。定时任务用 pg-boss（表在数据库的 `pgboss` schema 里，启动时自动安装）。
- 拉取失败只记 warn 日志，继续用数据库里已有的数据；数据库里没有的年份用镜像内置的 `packages/server/holidays/<year>.json`；两边都没有（比如下一年还没公布）就按周一到周五算工作日。发版前可以用 `scripts/update-bundled-holidays.sh` 更新内置数据。
- 设置 → 日期与时间里显示最后更新时间，「立即更新」调 `POST /api/holidays/refresh`。`GET /api/holidays/status`、`GET /api/holidays/:year` 读当前数据。节假日数据所有用户共用（是公开数据），不按用户隔离，接口仍然要求登录。
- 数据实际变化时发出「节假日数据更新」事件：`app.holidays.onUpdated(({ years, calendar }) => …)`，`calendar` 是新的工作日日历，供重复任务重新计算日期。
- 工作日日历在 `packages/shared/src/workday-calendar.ts`（`createWorkdayCalendar(years).dayInfo('2026-10-10')`）；农历在 `@dida/shared/lunar`（`solarToLunar`、`lunarToSolar`、`traditionalFestivals`，封装 `lunar-javascript`，单独的入口，不进前端主包）。
