/**
 * Outgoing notifications: a webhook (Slack, Discord, Microsoft Teams, ntfy or anything that accepts
 * a JSON POST) set in the admin panel. Sent in the background; a failing webhook never breaks the
 * change that triggered it.
 */

import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { prisma } from './db.js';

export const NotifySettings = z.object({
  /** Webhook URL; empty = off. */
  webhookUrl: z.string().trim().max(2000).refine((u) => u === '' || /^https?:\/\//i.test(u), 'Must start with http:// or https://').default(''),
  /** Base address of this server, used for links in messages, e.g. "https://wiring.example.com". */
  baseUrl: z.string().trim().max(500).default(''),
  events: z
    .object({
      mentions: z.boolean().default(true),
      comments: z.boolean().default(false),
      testFailures: z.boolean().default(true),
      backupFailures: z.boolean().default(true),
    })
    .default({}),
});
export type NotifySettings = z.infer<typeof NotifySettings>;
export type NotifyEvent = keyof NotifySettings['events'];

export async function getNotifySettings(): Promise<NotifySettings> {
  const row = await prisma.setting.findUnique({ where: { key: 'notify' } });
  const parsed = NotifySettings.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : NotifySettings.parse({});
}

export async function saveNotifySettings(s: NotifySettings) {
  await prisma.setting.upsert({ where: { key: 'notify' }, create: { key: 'notify', value: s }, update: { value: s } });
}

/** One payload that Slack (text), Discord (content), Teams (text) and plain receivers all understand. */
function payload(text: string) {
  return { text, content: text.slice(0, 2000), username: 'Wire-Node' };
}

export async function postWebhook(url: string, text: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload(text)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Webhook answered ${res.status} ${res.statusText}`);
}

/** Sends a notification if the event is switched on. `path` (e.g. "/projects/…") is linked when a base URL is set. */
export function notify(event: NotifyEvent, text: string, path?: string, log?: FastifyBaseLogger) {
  void (async () => {
    const s = await getNotifySettings();
    if (!s.webhookUrl || !s.events[event]) return;
    const link = path && s.baseUrl ? `\n${s.baseUrl.replace(/\/+$/, '')}${path}` : '';
    await postWebhook(s.webhookUrl, `${text}${link}`);
  })().catch((err) => log?.warn({ err }, 'Notification failed'));
}

/** Admin panel: notification settings. */
export async function notifyRoutes(app: import('fastify').FastifyInstance) {
  const { need } = await import('./auth.js');
  app.get('/api/admin/notify', async (req) => {
    need(req, 'users.manage');
    return getNotifySettings();
  });
  app.put('/api/admin/notify', async (req) => {
    need(req, 'users.manage');
    const s = NotifySettings.parse(req.body);
    await saveNotifySettings(s);
    return s;
  });
  app.post('/api/admin/notify/test', async (req) => {
    const user = need(req, 'users.manage');
    const s = NotifySettings.parse(req.body);
    if (!s.webhookUrl) throw Object.assign(new Error('Enter a webhook URL first'), { statusCode: 400 });
    try {
      await postWebhook(s.webhookUrl, `✅ Test message from Wire-Node, sent by ${user.name}.`);
    } catch (err) {
      throw Object.assign(new Error(`Sending failed: ${err instanceof Error ? err.message : String(err)}`), { statusCode: 400 });
    }
    return { ok: true };
  });
}
