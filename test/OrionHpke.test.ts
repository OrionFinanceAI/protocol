import { expect } from "chai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORION_INTENT_V1,
  ORION_PORTFOLIO_V1,
  bytesToHex,
  deriveRecipientKeyPair,
  encodeIntentPlaintext,
  encodePortfolioPlaintext,
  hexToBytes,
  orionDecrypt,
  orionEncrypt,
  orionEncryptDeterministic,
  parseOrionCiphertext,
} from "./helpers/orionHpke";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(__dirname, "vectors/hpke-orion-v1.json"), "utf8")) as {
  recipient: { ikm_r: string; skR: string; pkR: string };
  client_ephemeral: { ikm_e: string; enc: string };
  portfolio: {
    tokens: string[];
    shares: string[];
    pt: string;
    portfolio_blob: string;
  };
  intent: {
    tokens: string[];
    weights: number[];
    pt: string;
    intent_blob: string;
  };
  guest_enc_seed_check: {
    epoch_state_commit: string;
    enc_seed: string;
    skE: string;
    pkE: string;
  };
};

describe("Orion HPKE (ORION_HPKE_V1)", function () {
  const skR = hexToBytes(vectors.recipient.skR);
  const pkR = hexToBytes(vectors.recipient.pkR);
  const ikmE = hexToBytes(vectors.client_ephemeral.ikm_e);
  const portfolioPt = hexToBytes(vectors.portfolio.pt);
  const intentPt = hexToBytes(vectors.intent.pt);
  const portfolioBlob = hexToBytes(vectors.portfolio.portfolio_blob);
  const intentBlob = hexToBytes(vectors.intent.intent_blob);

  it("§17.1 DeriveKeyPair(ikm_r) yields fixture skR/pkR", async function () {
    const derived = await deriveRecipientKeyPair(hexToBytes(vectors.recipient.ikm_r));
    expect(bytesToHex(derived.skR)).to.equal(vectors.recipient.skR);
    expect(bytesToHex(derived.pkR)).to.equal(vectors.recipient.pkR);
  });

  it("encodePortfolioPlaintext matches §17.3 pt", function () {
    const pt = encodePortfolioPlaintext(
      vectors.portfolio.tokens,
      vectors.portfolio.shares.map((s) => BigInt(s)),
    );
    expect(bytesToHex(pt)).to.equal(vectors.portfolio.pt);
    expect(pt.length).to.equal(256);
  });

  it("encodeIntentPlaintext matches §17.4 pt", function () {
    const pt = encodeIntentPlaintext(vectors.intent.tokens, vectors.intent.weights);
    expect(bytesToHex(pt)).to.equal(vectors.intent.pt);
    expect(pt.length).to.equal(256);
  });

  it("OpenBase recovers §17.3 portfolio plaintext", async function () {
    const pt = await orionDecrypt(skR, portfolioBlob, ORION_PORTFOLIO_V1);
    expect(bytesToHex(pt)).to.equal(vectors.portfolio.pt);
  });

  it("OpenBase recovers §17.4 intent plaintext", async function () {
    const pt = await orionDecrypt(skR, intentBlob, ORION_INTENT_V1);
    expect(bytesToHex(pt)).to.equal(vectors.intent.pt);
  });

  it("deterministic SealBase matches §17.3 portfolio_blob", async function () {
    const blob = await orionEncryptDeterministic(pkR, portfolioPt, ORION_PORTFOLIO_V1, ikmE);
    expect(bytesToHex(blob)).to.equal(vectors.portfolio.portfolio_blob);
    expect(blob.length).to.equal(304);
    expect(bytesToHex(blob.subarray(0, 32))).to.equal(vectors.client_ephemeral.enc);
  });

  it("deterministic SealBase matches §17.4 intent_blob", async function () {
    const blob = await orionEncryptDeterministic(pkR, intentPt, ORION_INTENT_V1, ikmE);
    expect(bytesToHex(blob)).to.equal(vectors.intent.intent_blob);
    expect(blob.length).to.equal(304);
  });

  describe("§17.6 negatives", function () {
    it("rejects truncated blob before open", async function () {
      expect(() => parseOrionCiphertext(portfolioBlob.subarray(0, 47))).to.throw(/too short/);
      await expect(orionDecrypt(skR, portfolioBlob.subarray(0, 47), ORION_PORTFOLIO_V1)).to.be.rejected;
    });

    it("fails open on bitflip after offset 32", async function () {
      const flipped = new Uint8Array(portfolioBlob);
      flipped[40] ^= 0x01;
      await expect(orionDecrypt(skR, flipped, ORION_PORTFOLIO_V1)).to.be.rejected;
    });

    it("fails open with wrong info", async function () {
      await expect(orionDecrypt(skR, portfolioBlob, "ORION_INTENT_V2" as "ORION_INTENT_V1")).to.be.rejected;
    });

    it("fails cross-type open", async function () {
      await expect(orionDecrypt(skR, portfolioBlob, ORION_INTENT_V1)).to.be.rejected;
      await expect(orionDecrypt(skR, intentBlob, ORION_PORTFOLIO_V1)).to.be.rejected;
    });

    it("fails open with non-empty aad", async function () {
      await expect(orionDecrypt(skR, portfolioBlob, ORION_PORTFOLIO_V1, new Uint8Array([1]))).to.be.rejected;
    });
  });

  describe("CSPRNG production path", function () {
    it("round-trips portfolio and intent", async function () {
      const pBlob = await orionEncrypt(pkR, portfolioPt, ORION_PORTFOLIO_V1);
      expect(pBlob.length).to.equal(48 + portfolioPt.length);
      expect(bytesToHex(await orionDecrypt(skR, pBlob, ORION_PORTFOLIO_V1))).to.equal(vectors.portfolio.pt);

      const iBlob = await orionEncrypt(pkR, intentPt, ORION_INTENT_V1);
      expect(iBlob.length).to.equal(48 + intentPt.length);
      expect(bytesToHex(await orionDecrypt(skR, iBlob, ORION_INTENT_V1))).to.equal(vectors.intent.pt);
    });

    it("rejects zero pkR", async function () {
      await expect(orionEncrypt(new Uint8Array(32), portfolioPt, ORION_PORTFOLIO_V1)).to.be.rejectedWith(/zero key/);
    });
  });

  it("§17.5 enc_seed DeriveKeyPair intermediates (derivation check)", async function () {
    // Optional gate: DeriveKeyPair(enc_seed) matches published skE/pkE.
    // Full guest-seal OrionCiphertext is out of Phase 2 scope.
    const { skR: skE, pkR: pkE } = await deriveRecipientKeyPair(hexToBytes(vectors.guest_enc_seed_check.enc_seed));
    expect(bytesToHex(skE)).to.equal(vectors.guest_enc_seed_check.skE);
    expect(bytesToHex(pkE)).to.equal(vectors.guest_enc_seed_check.pkE);
  });
});
