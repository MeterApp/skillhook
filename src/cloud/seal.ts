// Values only the intended reader can open: X25519 key agreement with a fresh ephemeral key, HKDF-SHA256, AES-256-GCM.
// A secret the cloud asks this machine to generate is sealed to the requester's public key (the dashboard holds the
// private key in the browser), and a secret the cloud sends is sealed to this machine's key (`SKILLHOOK_CLOUD_PRIVATE_KEY`).
// Keys travel as base64url of the raw 32 bytes, which WebCrypto imports as `raw` X25519 keys.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import type { Sealed } from "./protocol.js";

const INFO = Buffer.from("skillhook-seal-v1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface MachineKeyPair {
  /** base64url of the raw 32-byte X25519 public key: goes to the cloud at pairing. */
  publicKey: string;
  /** base64url of the PKCS#8 DER private key: stays in `.env`. */
  privateKey: string;
}

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new SealError("not an X25519 public key");
  return Buffer.from(jwk.x, "base64url");
}

function publicFromRaw(raw: string): KeyObject {
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) throw new SealError("an X25519 public key is 32 bytes");
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: bytes.toString("base64url") }, format: "jwk" });
}

function privateFromDer(der: string): KeyObject {
  try {
    return createPrivateKey({ key: Buffer.from(der, "base64url"), format: "der", type: "pkcs8" });
  } catch {
    throw new SealError("the private key is not a PKCS#8 X25519 key");
  }
}

function deriveKey(shared: Buffer, ephemeralPublic: Buffer, recipientPublic: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralPublic, recipientPublic]), INFO, 32));
}

export function machineKeyPair(): MachineKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey: rawPublic(publicKey).toString("base64url"), privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url") };
}

/** The public half of a stored private key (what pairing sends). */
export function publicKeyOf(privateKey: string): string {
  return rawPublic(createPublicKey(privateFromDer(privateKey))).toString("base64url");
}

export function sealForRecipient(plaintext: string, recipientPublicKey: string): Sealed {
  const recipient = publicFromRaw(recipientPublicKey);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublic = rawPublic(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = deriveKey(shared, ephemeralPublic, rawPublic(recipient));
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { recipient_key: recipientPublicKey, ephemeral_public_key: ephemeralPublic.toString("base64url"), nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

export function openSealed(sealed: Pick<Sealed, "ephemeral_public_key" | "nonce" | "ciphertext">, privateKey: string): string {
  const own = privateFromDer(privateKey);
  const ephemeral = publicFromRaw(sealed.ephemeral_public_key);
  const shared = diffieHellman({ privateKey: own, publicKey: ephemeral });
  const key = deriveKey(shared, Buffer.from(sealed.ephemeral_public_key, "base64url"), rawPublic(createPublicKey(own)));
  const data = Buffer.from(sealed.ciphertext, "base64url");
  if (data.length < TAG_BYTES) throw new SealError("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64url"));
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new SealError("the sealed value does not open with this key (wrong key or tampered)");
  }
}
