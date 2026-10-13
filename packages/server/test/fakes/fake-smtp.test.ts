import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeMail, startFakeSmtp, type FakeSmtpServer } from './fake-smtp.js';

describe('fake SMTP server', () => {
  let smtp: FakeSmtpServer;
  afterEach(() => smtp.close());

  function transport(auth?: { user: string; pass: string }) {
    return nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: false,
      ignoreTLS: true,
      ...(auth ? { auth } : {}),
    });
  }

  it('captures sender, recipients, subject and body of an authenticated mail', async () => {
    smtp = await startFakeSmtp({ credentials: { username: 'me@qq.com', password: 'auth-code' } });
    await transport({ user: 'me@qq.com', pass: 'auth-code' }).sendMail({
      from: 'me@qq.com',
      to: 'me@qq.com',
      subject: '提醒：交周报',
      text: '交周报\n.\n第二行',
    });

    const [mail] = await smtp.waitForMessages(1);
    expect(mail).toMatchObject({
      from: 'me@qq.com',
      to: ['me@qq.com'],
      auth: { username: 'me@qq.com', password: 'auth-code' },
    });
    expect(mail?.subject).toContain('=?UTF-8?'); // non-ASCII subject arrives MIME-encoded
    expect(mail?.raw).toContain('Content-Type: text/plain');
    expect(decodeMail(mail!.raw)).toEqual({ subject: '提醒：交周报', text: '交周报\n.\n第二行' });
  });

  it('decodes long base64 and quoted-printable bodies', async () => {
    smtp = await startFakeSmtp();
    const long = `${'很长的中文正文，'.repeat(30)}100% 完成`;
    await transport().sendMail({ from: 'a@example.com', to: 'b@example.com', subject: '长'.repeat(40), text: long });
    await transport().sendMail({ from: 'a@example.com', to: 'b@example.com', subject: 'ascii', text: `caf\u00e9 ${'x'.repeat(100)} 50%` });
    const [first, second] = await smtp.waitForMessages(2);
    expect(decodeMail(first!.raw)).toEqual({ subject: '长'.repeat(40), text: long });
    expect(decodeMail(second!.raw).text).toBe(`caf\u00e9 ${'x'.repeat(100)} 50%`);
  });

  it('rejects wrong credentials', async () => {
    smtp = await startFakeSmtp({ credentials: { username: 'me@qq.com', password: 'right' } });
    await expect(
      transport({ user: 'me@qq.com', pass: 'wrong' }).sendMail({ from: 'me@qq.com', to: 'me@qq.com', text: 'x' }),
    ).rejects.toThrow(/535/);
    expect(smtp.messages).toHaveLength(0);
  });

  it('can fail deliveries on demand to exercise retries', async () => {
    smtp = await startFakeSmtp();
    smtp.failNext(451);
    const mail = { from: 'a@example.com', to: 'b@example.com', text: 'retry me' };
    await expect(transport().sendMail(mail)).rejects.toThrow(/451/);
    await transport().sendMail(mail);
    expect(smtp.messages).toHaveLength(1);
  });
});
