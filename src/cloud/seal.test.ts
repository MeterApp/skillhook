import type { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { machineKeyPair, openSealed, publicKeyOf, SealError, sealForRecipient } from "./seal.js";

describe("sealed values", () => {
  it("round-trips to the holder of the private key and to nobody else", () => {
    const pair = machineKeyPair();
    expect(Buffer.from(pair.publicKey, "base64url")).toHaveLength(32);
    expect(publicKeyOf(pair.privateKey)).toBe(pair.publicKey);
    const sealed = sealForRecipient("placeholder generated value", pair.publicKey);
    expect(sealed.recipient_key).toBe(pair.publicKey);
    expect(sealed.ciphertext).not.toContain("placeholder");
    expect(openSealed(sealed, pair.privateKey)).toBe("placeholder generated value");
    // Every seal uses a fresh ephemeral key and nonce.
    const again = sealForRecipient("placeholder generated value", pair.publicKey);
    expect(again.ephemeral_public_key).not.toBe(sealed.ephemeral_public_key);
    expect(again.ciphertext).not.toBe(sealed.ciphertext);
    expect(() => openSealed(sealed, machineKeyPair().privateKey)).toThrow(SealError);
    const tampered = Buffer.from(sealed.ciphertext, "base64url");
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => openSealed({ ...sealed, ciphertext: tampered.toString("base64url") }, pair.privateKey)).toThrow(SealError);
    expect(() => sealForRecipient("x", Buffer.from("short").toString("base64url"))).toThrow(SealError);
    expect(() => openSealed(sealed, "not-a-key")).toThrow(SealError);
  });

  it("opens in a browser the way the dashboard does it (WebCrypto X25519, HKDF-SHA256, AES-GCM)", async () => {
    const { subtle } = globalThis.crypto;
    const browser = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as webcrypto.CryptoKeyPair;
    const browserPublic = Buffer.from(await subtle.exportKey("raw", browser.publicKey)).toString("base64url");
    const sealed = sealForRecipient("for the person who asked", browserPublic);
    const ephemeral = await subtle.importKey("raw", Buffer.from(sealed.ephemeral_public_key, "base64url"), { name: "X25519" }, false, []);
    const bits = await subtle.deriveBits({ name: "X25519", public: ephemeral }, browser.privateKey, 256);
    const hkdf = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const salt = Buffer.concat([Buffer.from(sealed.ephemeral_public_key, "base64url"), Buffer.from(browserPublic, "base64url")]);
    const aes = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: Buffer.from("skillhook-seal-v1") }, hkdf, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sealed.nonce, "base64url") }, aes, Buffer.from(sealed.ciphertext, "base64url"));
    expect(Buffer.from(plain).toString("utf8")).toBe("for the person who asked");

    // And the other way: the dashboard seals to the machine's public key.
    const machine = machineKeyPair();
    const eph = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as webcrypto.CryptoKeyPair;
    const ephPublic = Buffer.from(await subtle.exportKey("raw", eph.publicKey)).toString("base64url");
    const machinePublic = await subtle.importKey("raw", Buffer.from(machine.publicKey, "base64url"), { name: "X25519" }, false, []);
    const shared = await subtle.deriveBits({ name: "X25519", public: machinePublic }, eph.privateKey, 256);
    const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: Buffer.concat([Buffer.from(ephPublic, "base64url"), Buffer.from(machine.publicKey, "base64url")]), info: Buffer.from("skillhook-seal-v1") }, await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, Buffer.from("placeholder value for the machine"));
    expect(openSealed({ ephemeral_public_key: ephPublic, nonce: Buffer.from(iv).toString("base64url"), ciphertext: Buffer.from(ciphertext).toString("base64url") }, machine.privateKey)).toBe("placeholder value for the machine");
  });
});
