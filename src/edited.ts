import cache from './cache';
import * as db from './db';
import * as middleware from './middleware';
import * as staff from './staff';
import { Context } from './interfaces';
import * as log from './logger';
import { ISupportee } from './db';

function displayName(firstName: string, userId: string): string {
  const { config } = cache;
  const esc = middleware.strictEscape;
  let name = config.anonymous_tickets
    ? firstName
    : `[${esc(firstName)}](tg://user?id=${userId})`;
  if (userId && !String(name).includes(String(userId))) {
    name = `${name} (${userId})`;
  }
  return name;
}

async function findTicketFromStaffEdit(
  msg: NonNullable<Context['editedMessage']>,
  category: string | null,
): Promise<ISupportee | null> {
  const replyMsg = msg.reply_to_message;
  const replyText = (replyMsg && (replyMsg.text || replyMsg.caption)) || '';
  const replyMessageId =
    msg.external_reply?.message_id ?? replyMsg?.message_id ?? null;

  if (replyMessageId) {
    const byInternal = await db.getTicketByInternalId(replyMessageId);
    if (byInternal) return byInternal;
  }

  if (replyText) {
    const extractedId = staff.extractTicketId(replyText);
    if (extractedId) {
      const ticketId = parseInt(extractedId, 10);
      if (ticketId) {
        const byId =
          (await db.getTicketById(ticketId, category)) ||
          (await db.getByTicketId(String(ticketId)));
        if (byId) return byId;
      }
    }
    const supporteeId = staff.extractSupporteeId(replyText);
    if (supporteeId) {
      const byUser = await db.getTicketByUserId(supporteeId, category);
      if (byUser) return byUser;
    }
  }

  return null;
}

async function handleStaffEditedMessage(
  ctx: Context,
  msg: NonNullable<Context['editedMessage']>,
  body: string,
): Promise<boolean> {
  if (body.startsWith('!note ') || body.startsWith('!internal ')) return false;

  const category = ctx.session?.groupCategory || null;
  const ticket = await findTicketFromStaffEdit(msg, category);
  if (!ticket) {
    log.info('Staff edit ignored: could not match a ticket');
    return false;
  }

  const userMessageId = db.getStaffReplyUserMessageId(ticket, msg.message_id);
  if (!userMessageId) {
    log.info(
      `Staff edit ignored: no stored user message for ticket #T${ticket.ticketId} (reply before mapping was added)`,
    );
    return false;
  }

  const name = ticket.name || 'User';
  const replyContent = staff.ticketMsg(name, {
    text: body,
    from: msg.from || ctx.from || { first_name: 'Staff' },
  });
  const ok = await middleware.editMessage(ticket.userid, userMessageId, replyContent);
  if (ok) {
    log.info(`Updated user ${ticket.userid} in place for ticket #T${ticket.ticketId}`);
    await db.addTicketMessage(
      ticket.ticketId,
      'staff',
      ctx.from?.id != null ? ctx.from.id.toString() : '',
      `[edited] ${body}`,
    );
  }
  return ok;
}

/**
 * User edits in private chat are posted to staff.
 * Staff edits of a ticket reply update the bot's matching message to the user in place.
 */
export async function handleEditedMessage(ctx: Context): Promise<boolean> {
  try {
    const { config } = cache;
    const msg = ctx.editedMessage;
    const body = msg && (msg.text || msg.caption);
    if (!msg || !body) {
      log.info('Edit ignored: no edited text/caption');
      return false;
    }

    const chatId = String(ctx.chat?.id || msg.chat?.id || '');
    if (chatId && chatId === String(config.staffchat_id)) {
      return await handleStaffEditedMessage(ctx, msg, body);
    }

    if (!config.forward_edited_messages) {
      log.info('Edit ignored: forward_edited_messages is off');
      return false;
    }

    const chatType = ctx.chat?.type || msg.chat?.type;
    if (chatType !== 'private' || ctx.session?.admin) {
      log.info(`Edit ignored: chat type is ${chatType}, admin=${!!ctx.session?.admin}`);
      return false;
    }

    const from = msg.from || ctx.from;
    if (!from) {
      log.info('Edit ignored: no from user');
      return false;
    }

    const userId = from.id.toString();
    const ticket = await db.getTicketByUserId(userId, ctx.session?.groupCategory);
    if (!ticket) {
      log.info(`Edit ignored: no ticket for user ${userId}`);
      return false;
    }
    if (ticket.status === 'banned') {
      log.info(`Edit ignored: ticket #T${ticket.ticketId} is banned`);
      return false;
    }

    const esc = middleware.strictEscape;
    const paddedId = ticket.ticketId.toString().padStart(6, '0');
    const name = displayName(from.first_name || 'User', userId);
    const text =
      `${config.language.ticket} #T${paddedId} ${config.language.from} ${name} ` +
      `${config.language.editedMessage}:\n\n${esc(body)}`;

    log.info(`Forwarding edit for ticket #T${paddedId}: ${body}`);
    await middleware.sendMessage(config.staffchat_id, config.staffchat_type, text).catch(log.error);
    if (ctx.session?.group && ctx.session.group !== config.staffchat_id) {
      await middleware.sendMessage(ctx.session.group, ticket.messenger, text).catch(log.error);
    }
    await db.addTicketMessage(
      ticket.ticketId,
      'user',
      userId,
      `[${config.language.editedMessage}] ${body}`,
    );
    return true;
  } catch (err) {
    log.error('Failed to forward edited message:', err);
    return false;
  }
}
