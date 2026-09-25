import * as db from './db';
import cache from './cache';
import { buildInlineKeyboard, reply, sendMessage } from './middleware';
import { Addon, Context } from './interfaces';
import { ISupportee } from './db';
import * as staff from './staff';
import * as log from './logger'

const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Generates the reply markup for a private reply.
 *
 * @param ctx - The current bot context.
 * @returns The reply markup object.
 */
const replyMarkup = (ctx: Context): { html: string; inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>> } => {
  const { config } = cache;
  const { language, direct_reply } = config;
  const { from, message, session } = ctx;
  const { modeData } = session;
  return {
    html: '',
    inline_keyboard: [
      [
        direct_reply
          ? {
            text: language.replyPrivate,
            url: `https://t.me/${from.username}`,
          }
          : {
            text: language.replyPrivate,
            callback_data: `${from.id}---${message.from.first_name}---${modeData.category}---${modeData.ticketid}`,
          },
      ],
    ],
  };
};

/**
 * Handles forwarding of files (document, photo, video, sticker) to staff.
 *
 * @param type - The type of file ('document', 'photo', 'video' or 'sticker').
 * @param bot - The bot addon instance.
 * @param ctx - The bot context.
 */
/**
 * Resolves the single ticket a staff media reply is aimed at.
 * A reply never falls back to the sender, and never uses a leftover private-reply session.
 */
async function resolveStaffReplyTicket(ctx: Context): Promise<{ ticket: ISupportee; replyText: string } | null> {
  const replyMsg = ctx.message?.reply_to_message;
  if (!replyMsg) return null;
  const replyText = replyMsg.text || replyMsg.caption || '';
  const replyMessageId = ctx.message.external_reply?.message_id ?? replyMsg.message_id ?? null;

  if (replyMessageId) {
    const byInternal = await db.getTicketByInternalId(replyMessageId);
    if (byInternal) return { ticket: byInternal, replyText };
  }

  if (replyText) {
    const extractedId = staff.extractTicketId(replyText);
    if (extractedId) {
      const ticketId = parseInt(extractedId, 10);
      if (ticketId) {
        const byId =
          (await db.getTicketById(ticketId, ctx.session.groupCategory)) ||
          (await db.getByTicketId(String(ticketId)));
        if (byId) return { ticket: byId, replyText };
      }
    }
    const supporteeId = staff.extractSupporteeId(replyText);
    if (supporteeId) {
      const byUser = await db.getTicketByUserId(supporteeId, ctx.session.groupCategory);
      if (byUser) return { ticket: byUser, replyText };
    }
  }

  return null;
}

async function fileHandler(type: string, bot: Addon, ctx: Context) {
  const { message, session } = ctx;
  const { config } = cache;
  const isStaffChat = session.admin && ctx.chat.type !== 'private';
  const staffReply = isStaffChat ? await resolveStaffReplyTicket(ctx) : null;

  // Staff replied to a ticket: deliver only to that ticket's user.
  // Ignore modeData — a private-reply session must not redirect or duplicate the file.
  if (isStaffChat && message?.reply_to_message) {
    if (!staffReply?.ticket?.userid) {
      reply(ctx, config.language.ticketClosedError);
      return;
    }
  }

  let userid: string | null = staffReply?.ticket.userid ?? null;
  const replyText = staffReply?.replyText ?? '';

  if (!userid) {
    if (isStaffChat && session.mode === 'private_reply' && session.modeData?.userid) {
      userid = String(session.modeData.userid);
    } else if (!isStaffChat) {
      userid = message.from.id;
    }
  }
  if (!userid) {
    reply(ctx, config.language.ticketClosedError);
    return;
  }

  const userInfo = isStaffChat ? undefined : await forwardFile(ctx);
  let receiverId: string | number = config.staffchat_id;
  let isPrivate = false;

  const ticket = staffReply?.ticket ?? await db.getTicketByUserId(userid.toString(), session.groupCategory);
  if (!ticket) {
    if (isStaffChat) {
      reply(ctx, config.language.ticketClosedError);
    } else {
      reply(ctx, config.language.textFirst);
    }
    return;
  }

  let captionText = `#T${(ticket.ticketId ?? ticket.id ?? 0)
    .toString()
    .padStart(6, '0')} ${userInfo}\n${message.caption || ''}`;
  if (isStaffChat) {
    receiverId = ticket.userid;
    captionText = message.caption || '';
  } else if (session.mode === 'private_reply' && session.modeData?.userid) {
    receiverId = session.modeData.userid;
    isPrivate = true;
  }

  const fileResult = await ctx.getFile();
  const fileId = (fileResult as { file_id: string }).file_id;
  const commonOptions = {
    caption: captionText,
    reply_markup: isPrivate ? replyMarkup(ctx) : {},
  };

  // Send the file based on its type
  let messageId: string | null | undefined = undefined;
  // Category-group copies are for a user's own upload. A staff reply stays with one user.
  const shouldForwardToGroup = (
    !isStaffChat &&
    session.group !== '' &&
    session.group !== config.staffchat_id &&
    Object.keys(session.modeData).length > 0
  );

  switch (type) {
    case 'document':
      messageId = (await bot.sendDocument(receiverId, fileId, commonOptions)) as string | null;
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendDocument(session.group, fileId, {
          caption: captionText,
          reply_markup: buildInlineKeyboard(ctx.from.id, message.from.first_name, session.groupCategory, (ticket.ticketId ?? ticket.id ?? 0) as number),
        })).catch(log.error);
      }
      break;
    case 'photo':
      messageId = (await bot.sendPhoto(receiverId, fileId, commonOptions)) as string | null;
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendPhoto(session.group, fileId, {
          caption: captionText,
          reply_markup: buildInlineKeyboard(ctx.from.id, message.from.first_name, session.groupCategory, (ticket.ticketId ?? ticket.id ?? 0) as number),
        })).catch(log.error);
      }
      break;
    case 'video':
      messageId = (await bot.sendVideo(receiverId, fileId, commonOptions)) as string | null;
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendVideo(session.group, fileId, {
          caption: captionText,
          reply_markup: buildInlineKeyboard(ctx.from.id, message.from.first_name, session.groupCategory, (ticket.ticketId ?? ticket.id ?? 0) as number),
        })).catch(log.error);
      }
      break;
    case 'sticker': {
      // Stickers cannot carry a caption: send the sticker, then the ticket header as text (#107)
      if (!bot.sendSticker) return;
      const stickerFileId = message.sticker?.file_id || fileId;
      messageId = (await bot.sendSticker(receiverId, stickerFileId)) as string | null;
      const headerMessenger = session.admin && userInfo === undefined ? ticket.messenger : config.staffchat_type;
      if (captionText.trim()) {
        sendMessage(receiverId, headerMessenger, captionText).catch(log.error);
      }
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendSticker(session.group, stickerFileId)).catch(log.error);
      }
      break;
    }
  }
  if (messageId) {
    db.addIdAndName(ticket.ticketId, messageId, ctx.message.from.first_name);
  }

  // Send confirmation message if enabled
  if (!config.autoreply_confirmation) return;
  let confirmationMessage = `${config.language.confirmationMessage}${config.show_user_ticket
    ? config.language.yourTicketId + ' #T' + (ticket.ticketId ?? ticket.id ?? 0).toString().padStart(6, '0')
    : ''
    }`;
  if (isStaffChat) {
    const pipeMatch = replyText.match(/#T\d+\s*\|\s*(.+?)\s*\|/);
    const nameMatch = pipeMatch || replyText.match(
      new RegExp(`${escapeRegex(config.language.from)} (.*) ${escapeRegex(config.language.language)}`)
    );
    const label = ticket.name || nameMatch?.[1];
    if (!label) return;
    confirmationMessage = `${config.language.file_sent} ${label}`;
  }
  sendMessage(ctx.chat.id, ticket.messenger, confirmationMessage).catch(log.error);
};

/**
 * Handles file forwarding with caching and spam protection.
 *
 * @param ctx - The bot context.
 * @param callback - Callback function receiving user information.
 */
async function forwardFile(ctx: Context): Promise<string | undefined> {
  const ticket = await db.getTicketByUserId(ctx.message.from.id.toString(), ctx.session.groupCategory);
  let ok = false;
  if (!ticket || !ticket.status) {
    await db.add(ctx.message.from.id.toString(), 'open', null, ctx.messenger);
    ok = true;
  }
  if (ok || (ticket && ticket.status !== 'banned')) {
    const sentCount = cache.ticketSent[cache.userId];
    if (sentCount === undefined) {
      setTimeout(() => {
        delete cache.ticketSent[cache.userId];
      }, cache.config.spam_time);
      cache.ticketSent[cache.userId] = 0;
      return forwardHandler(ctx);
    } else if (sentCount < cache.config.spam_cant_msg) {
      cache.ticketSent[cache.userId] = sentCount + 1;
      return forwardHandler(ctx);
    } else if (sentCount === cache.config.spam_cant_msg) {
      cache.ticketSent[cache.userId] = sentCount + 1;
      sendMessage(ctx.chat.id, ticket?.messenger ?? 'telegram', cache.config.language.blockedSpam, {}).catch(log.error);
    }
  }
};

/**
 * Determines if the message comes from a private chat and returns user info.
 *
 * @param ctx - The bot context.
 * @param callback - Callback function receiving user info (or undefined).
 */
function forwardHandler(ctx: Context): string | undefined {
  if (ctx.chat.type === 'private') {
    cache.userId = ctx.message.from.id;
    const userInfo = `| ${ctx.message.from.first_name} (${ctx.message.from.id}) | ${ctx.message.from.language_code}\n\n`;
    return userInfo;
  } else {
    return undefined;
  }
};

export { fileHandler, forwardFile, forwardHandler };
