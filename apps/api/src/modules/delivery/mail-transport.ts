import nodemailer from 'nodemailer';
import { z } from 'zod';
export type ReportMail = {
  to: string;
  subject: string;
  text: string;
  messageId: string;
  filename: string;
  pdf: Uint8Array;
};
export interface ReportMailer {
  mode: 'disabled' | 'local' | 'smtp';
  configured: boolean;
  from: string | null;
  send(message: ReportMail): Promise<void>;
}
export class MailSendError extends Error {
  constructor(readonly uncertain: boolean) {
    super(
      uncertain
        ? 'Mail acceptance is uncertain. Check the mailbox before any resend.'
        : 'SMTP did not accept the message. Check email configuration and retry.',
    );
  }
}
export function createReportMailer(env: NodeJS.ProcessEnv = process.env): ReportMailer {
  const mode = env.DELIVERY_MODE ?? 'disabled';
  if (!['disabled', 'local', 'smtp'].includes(mode)) throw new Error('Invalid DELIVERY_MODE');
  const from = env.DELIVERY_FROM ?? (mode === 'local' ? 'reports@cornven.test' : '');
  const configured =
    mode !== 'disabled' &&
    z.string().email().safeParse(from).success &&
    (mode === 'local' || Boolean(env.SMTP_HOST));
  if (!configured)
    return {
      mode: mode as ReportMailer['mode'],
      configured: false,
      from: from || null,
      async send() {
        throw new MailSendError(false);
      },
    };
  if (mode === 'local' && env.NODE_ENV === 'production')
    throw new Error('Local mail capture is development-only');
  const port = mode === 'local' ? 51025 : Number(env.SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP_PORT');
  return {
    mode: mode as 'local' | 'smtp',
    configured,
    from,
    async send(message) {
      const transport = nodemailer.createTransport({
        host: mode === 'local' ? '127.0.0.1' : env.SMTP_HOST,
        port,
        secure: mode === 'smtp' && port === 465,
        requireTLS: mode === 'smtp' && port !== 465,
        ...(mode === 'smtp' && env.SMTP_USER
          ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } }
          : {}),
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const info = await Promise.race([
          transport.sendMail({
            from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            messageId: message.messageId,
            attachments: [
              {
                filename: message.filename,
                content: Buffer.from(message.pdf),
                contentType: 'application/pdf',
              },
            ],
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              transport.close();
              reject(new MailSendError(true));
            }, 45000);
          }),
        ]);
        if (!info.accepted.length || info.rejected.length) throw new MailSendError(false);
      } catch (error) {
        if (error instanceof MailSendError) throw error;
        const e = error as { code?: string; responseCode?: number };
        const definitive =
          ['ECONNREFUSED', 'EDNS', 'EAUTH'].includes(e.code ?? '') ||
          (e.responseCode !== undefined && e.responseCode >= 400);
        throw new MailSendError(!definitive);
      } finally {
        if (timer) clearTimeout(timer);
        transport.close();
      }
    },
  };
}
