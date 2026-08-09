import { Aes128Gcm, CipherSuite, HkdfSha256, DhkemX25519HkdfSha256 } from "@hpke/core";
import { AbiCoder, getBytes, hexlify } from "ethers";

export type OrionHpkeInfo = "ORION_PORTFOLIO_V1" | "ORION_INTENT_V1";

export const ORION_PORTFOLIO_V1 = "ORION_PORTFOLIO_V1" as const;
export const ORION_INTENT_V1 = "ORION_INTENT_V1" as const;

/** Minimum OrionCiphertext length: enc(32) + tag(16). */
export const MIN_ORION_CIPHERTEXT_LENGTH = 48;

const EMPTY_AAD = new Uint8Array(0);
const utf8 = new TextEncoder();

let suiteSingleton: CipherSuite | undefined;

function suite(): CipherSuite {
  if (!suiteSingleton) {
    suiteSingleton = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes128Gcm(),
    });
  }
  return suiteSingleton;
}

function assertKeyLength(key: Uint8Array, label: string): void {
  if (key.length !== 32) {
    throw new Error(`${label} must be exactly 32 bytes, got ${key.length}`);
  }
}

function isZeroKey(key: Uint8Array): boolean {
  return key.every((b) => b === 0);
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Parse lowercase hex (optional 0x) into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.replace(/\s+/g, "");
  const h = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (h.length % 2 !== 0) throw new Error(`hex length must be even (got ${h.length})`);
  return getBytes(`0x${h}`);
}

/** Lowercase hex without 0x (fixture encoding). */
export function bytesToHex(bytes: Uint8Array): string {
  return hexlify(bytes).slice(2);
}

/** Lowercase hex with 0x (SDK / ethers). */
export function bytesToHex0x(bytes: Uint8Array): string {
  return hexlify(bytes);
}

export function parseOrionCiphertext(blob: Uint8Array): { enc: Uint8Array; ct: Uint8Array } {
  if (blob.length < MIN_ORION_CIPHERTEXT_LENGTH) {
    throw new Error(`OrionCiphertext too short: ${blob.length} < ${MIN_ORION_CIPHERTEXT_LENGTH}`);
  }
  return { enc: blob.subarray(0, 32), ct: blob.subarray(32) };
}

export function encodePortfolioPlaintext(tokens: string[], shares: bigint[]): Uint8Array {
  if (tokens.length !== shares.length) {
    throw new Error("tokens and shares length mismatch");
  }
  const encoded = AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]"], [tokens, shares]);
  return getBytes(encoded);
}

export function encodeIntentPlaintext(tokens: string[], weights: number[] | bigint[]): Uint8Array {
  if (tokens.length !== weights.length) {
    throw new Error("tokens and weights length mismatch");
  }
  const encoded = AbiCoder.defaultAbiCoder().encode(["address[]", "uint32[]"], [tokens, weights]);
  return getBytes(encoded);
}

/**
 * Seal plaintext to pkR (CSPRNG ephemeral). Production client path.
 */
export async function orionEncrypt(pkR: Uint8Array, plaintext: Uint8Array, info: OrionHpkeInfo): Promise<Uint8Array> {
  assertKeyLength(pkR, "pkR");
  if (isZeroKey(pkR)) throw new Error("pkR must not be the zero key");

  const s = suite();
  const recipientPublicKey = await s.kem.importKey("raw", toArrayBuffer(pkR), true);
  const { enc, ct } = await s.seal(
    { recipientPublicKey, info: utf8.encode(info) },
    toArrayBuffer(plaintext),
    EMPTY_AAD,
  );
  return concatBytes(new Uint8Array(enc), new Uint8Array(ct));
}

/**
 * Test-only SealBase with fixed ephemeral IKM (`ekm` / DeriveKeyPair).
 * Required for ORION_HPKE_SPEC §17.3 / §17.4 byte-for-byte conformance.
 */
export async function orionEncryptDeterministic(
  pkR: Uint8Array,
  plaintext: Uint8Array,
  info: OrionHpkeInfo,
  ikmE: Uint8Array,
): Promise<Uint8Array> {
  assertKeyLength(pkR, "pkR");
  assertKeyLength(ikmE, "ikmE");
  if (isZeroKey(pkR)) throw new Error("pkR must not be the zero key");

  const s = suite();
  const recipientPublicKey = await s.kem.importKey("raw", toArrayBuffer(pkR), true);
  const { enc, ct } = await s.seal(
    { recipientPublicKey, info: utf8.encode(info), ekm: toArrayBuffer(ikmE) },
    toArrayBuffer(plaintext),
    EMPTY_AAD,
  );
  return concatBytes(new Uint8Array(enc), new Uint8Array(ct));
}

/**
 * Open OrionCiphertext with skR.
 * @param aad Override AAD (default empty). Non-empty used only for §17.6 negatives.
 */
export async function orionDecrypt(
  skR: Uint8Array,
  blob: Uint8Array,
  info: OrionHpkeInfo,
  aad: Uint8Array = EMPTY_AAD,
): Promise<Uint8Array> {
  assertKeyLength(skR, "skR");
  const { enc, ct } = parseOrionCiphertext(blob);

  const s = suite();
  const recipientKey = await s.kem.importKey("raw", toArrayBuffer(skR), false);
  const pt = await s.open({ recipientKey, enc: toArrayBuffer(enc), info: utf8.encode(info) }, toArrayBuffer(ct), aad);
  return new Uint8Array(pt);
}

/** Derive recipient keypair from IKM (RFC 9180 DeriveKeyPair). */
export async function deriveRecipientKeyPair(ikm: Uint8Array): Promise<{ skR: Uint8Array; pkR: Uint8Array }> {
  assertKeyLength(ikm, "ikm");
  const s = suite();
  const kp = await s.kem.deriveKeyPair(toArrayBuffer(ikm));
  const skR = new Uint8Array(await s.kem.serializePrivateKey(kp.privateKey));
  const pkR = new Uint8Array(await s.kem.serializePublicKey(kp.publicKey));
  return { skR, pkR };
}
