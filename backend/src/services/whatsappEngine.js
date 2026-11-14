/**
 * Ported from the wa-kit reference (server/services/whatsappEngine.js).
 * The kit's 'web' engine alternative (whatsapp-web.js, headless Chrome) is
 * not included and not needed here — this only ever imports the Baileys
 * implementation.
 */
import * as impl from './whatsappBaileysService.js';

export const resolveUserKey = impl.resolveUserKey;
export const getWhatsAppSession = impl.getWhatsAppSession;
export const startWhatsAppSession = impl.startWhatsAppSession;
export const logoutWhatsAppSession = impl.logoutWhatsAppSession;
export const sendWhatsAppText = impl.sendWhatsAppText;
export const sendWhatsAppImage = impl.sendWhatsAppImage;
export const listWhatsAppGroups = impl.listWhatsAppGroups;
export const shutdownAllWhatsAppSessions = impl.shutdownAllWhatsAppSessions;
