import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { getCollection } from './mongo.service.js';

/**
 * Ported from the wa-kit reference (server/services/whatsappAuthStore.js +
 * server/models/WhatsappAuthState.js), rewritten to use this app's own
 * `getCollection()` (native `mongodb` driver) instead of the kit's Mongoose
 * model — this app never uses Mongoose anywhere (see mongo.service.js).
 *
 * Persists Baileys' linked-device credentials/keys into THIS app's own
 * Mongo database (same connection as every other collection — see
 * config/db.js), as a drop-in replacement for Baileys' own
 * `useMultiFileAuthState` (which writes to local disk — unusable on a
 * `node --watch`/ephemeral deploy, since a restart would wipe the login and
 * force a QR re-scan every time).
 *
 * Collection: `_whatsapp_auth_state`, one document per {userKey, keyId}:
 *   - keyId 'creds' holds the main credential blob
 *   - keyId '<signal key type>-<id>' holds one entry of Baileys' signal key store
 * `data` is JSON.stringify(value, BufferJSON.replacer) so Buffers survive
 * the round trip through Mongo (stored as a plain string, not BSON binary).
 */
const COLLECTION = '_whatsapp_auth_state';

const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
const decode = (text) => JSON.parse(text, BufferJSON.reviver);

/** Drop-in replacement for Baileys' `useMultiFileAuthState`, backed by Mongo. */
export async function useMongoAuthState(userKey) {
  const col = getCollection(COLLECTION);

  const readDoc = async (keyId) => {
    const doc = await col.findOne({ userKey, keyId });
    if (!doc?.data) return null;
    try {
      return decode(doc.data);
    } catch {
      return null;
    }
  };

  const writeDoc = async (keyId, value) => {
    await col.updateOne(
      { userKey, keyId },
      { $set: { data: encode(value), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  };

  const removeDoc = (keyId) => col.deleteOne({ userKey, keyId });

  const creds = (await readDoc('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          const docs = await col
            .find({ userKey, keyId: { $in: ids.map((id) => `${type}-${id}`) } })
            .toArray();

          const byKeyId = new Map(docs.map((d) => [d.keyId, d.data]));
          for (const id of ids) {
            const raw = byKeyId.get(`${type}-${id}`);
            if (!raw) continue;
            let value;
            try {
              value = decode(raw);
            } catch {
              continue;
            }
            // Baileys expects this one type back as a protobuf message, not
            // the plain object JSON gives us.
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          const ops = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              const keyId = `${type}-${id}`;
              if (value) {
                ops.push({
                  updateOne: {
                    filter: { userKey, keyId },
                    update: { $set: { data: encode(value), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
                    upsert: true
                  }
                });
              } else {
                ops.push({ deleteOne: { filter: { userKey, keyId } } });
              }
            }
          }
          if (ops.length) await col.bulkWrite(ops, { ordered: false });
        }
      }
    },
    saveCreds: () => writeDoc('creds', creds),
    /** Wipe every stored record for this session (explicit logout / loggedOut). */
    clearState: async () => {
      await col.deleteMany({ userKey });
    },
    removeCreds: () => removeDoc('creds')
  };
}
