import 'server-only'

/**
 * Sending mail.
 *
 * One function, over Resend's HTTP API rather than its SDK: this sends
 * one kind of message from one place, and a dependency to build a JSON
 * body would be a dependency to audit.
 *
 * Not configured is a normal state, not a crash. ClaimKit has to run on
 * a laptop with no API key and on a deployment where reminders have not
 * been turned on yet, and in both cases the right behaviour is to say
 * the message was not sent and carry on -- a reminder is a courtesy, and
 * failing a cron over it would hide the claims that did go out.
 */

export class EmailNotConfigured extends Error {
  constructor() {
    super('Email is not configured')
    this.name = 'EmailNotConfigured'
  }
}

export type Message = {
  to: string
  subject: string
  text: string
  html: string
}

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; reason: string; configured: boolean }

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.REMINDER_FROM)
}

export async function sendEmail(message: Message): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY
  const from = process.env.REMINDER_FROM

  if (!key || !from) {
    return { ok: false, reason: 'Email is not configured', configured: false }
  }

  let response: Response
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        // Both, always. A text part is what a screen reader, a filter
        // and a phone on 2G all do best with, and an HTML-only mail is
        // more likely to be treated as spam.
        text: message.text,
        html: message.html,
      }),
    })
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Could not reach the mail service',
      configured: true,
    }
  }

  if (!response.ok) {
    // The body carries Resend's own explanation -- a suppressed address,
    // an unverified domain -- and that sentence is the whole value of
    // the failure, so it is kept rather than flattened to a status code.
    const detail = await response.text().catch(() => '')
    return {
      ok: false,
      reason: `${response.status} ${detail.slice(0, 300)}`.trim(),
      configured: true,
    }
  }

  const body = (await response.json().catch(() => ({}))) as { id?: string }
  return { ok: true, id: body.id ?? '' }
}
