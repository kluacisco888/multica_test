import { AccountError, type Accounts } from './accounts.js';

/*
 * Admin CLI commands (spec 用户故事 4、10). The entry point `cli.ts` wires real
 * stdin/stdout and the database; tests call `runCli` with fakes.
 *
 * Passwords are never taken from argv (visible in `ps` and shell history):
 * they are prompted for on a terminal, or read from stdin when piped.
 */

export interface CliIo {
  /** Read a password: hidden prompt (asked twice) on a TTY, else one line of stdin. */
  readPassword(prompt: string): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

export const CLI_USAGE = `用法: dida <命令> [参数]

  create-user <账号> [--admin]   新建用户（--admin 设为管理员），随后输入密码
  reset-password <账号>          重置密码，随后输入新密码；该用户所有会话立即失效
  disable-user <账号>            停用用户：无法登录，已有会话立即失效（不能停用最后一个管理员）
  enable-user <账号>             重新启用用户
  list-users                     列出所有用户

在容器里运行：docker compose exec app dida reset-password admin
非交互：printf '%s\\n' '新密码' | docker compose exec -T app dida reset-password admin`;

/** Run one CLI command; returns the process exit code. */
export async function runCli(argv: string[], accounts: Accounts, io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  const username = args[0];

  const needUser = () => {
    if (!username || args.length !== 1) throw new UsageError();
    return username;
  };

  try {
    switch (command) {
      case 'create-user': {
        const name = needUser();
        for (const flag of flags) if (flag !== '--admin') throw new UsageError();
        const password = await io.readPassword(`为 ${name} 设置密码: `);
        const account = await accounts.create({ username: name, password, isAdmin: flags.has('--admin') });
        io.out(`已创建${account.isAdmin ? '管理员' : '用户'} ${account.username}`);
        return 0;
      }
      case 'reset-password': {
        const name = needUser();
        if (flags.size) throw new UsageError();
        if (!(await accounts.findByUsername(name))) throw new AccountError('user_not_found', `用户不存在：${name}`);
        const password = await io.readPassword(`${name} 的新密码: `);
        await accounts.resetPassword(name, password);
        io.out(`已重置 ${name} 的密码，该用户的所有会话已失效`);
        return 0;
      }
      case 'disable-user':
      case 'enable-user': {
        const name = needUser();
        if (flags.size) throw new UsageError();
        const disable = command === 'disable-user';
        await accounts.setDisabled(name, disable);
        io.out(disable ? `已停用 ${name}，该用户的所有会话已失效` : `已启用 ${name}`);
        return 0;
      }
      case 'list-users': {
        if (rest.length) throw new UsageError();
        for (const a of await accounts.list()) {
          const tags = [a.isAdmin ? '管理员' : '用户', a.disabled ? '已停用' : '正常'];
          io.out(`${a.username}\t${tags.join('\t')}\t${a.createdAt.toISOString()}`);
        }
        return 0;
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(CLI_USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`未知命令：${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.message) io.err(error.message);
      io.err(CLI_USAGE);
      return 2;
    }
    if (error instanceof AccountError) {
      io.err(`错误：${error.message}`);
      return 1;
    }
    throw error;
  }
}

class UsageError extends Error {
  constructor(message = '') {
    super(message);
  }
}
