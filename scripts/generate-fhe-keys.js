const fs = require('fs');
const seal = require('node-seal');

async function generateKeys() {
  const SEAL = await seal();
  const parms = SEAL.EncryptionParameters(SEAL.SchemeType.bfv);

  parms.setPolyModulusDegree(2048);
  parms.setCoeffModulus(SEAL.CoeffModulus.BFVDefault(2048));
  parms.setPlainModulus(SEAL.PlainModulus.Batching(2048, 20));

  const context = SEAL.Context(parms, true, SEAL.SecurityLevel.tc128);

  if (!context.parametersSet()) throw new Error('Invalid parameters');

  const keyGenerator = SEAL.KeyGenerator(context);

  // Generate public and secret keys
  const publicKey = keyGenerator.createPublicKey();
  const secretKey = keyGenerator.secretKey();

  // Serialize keys (Uint8Array)
  const publicKeyData = publicKey.save();
  const secretKeyData = secretKey.save();

  // Convert to hex strings for environment variables or storage
  const fhePublicKeyHex = Buffer.from(publicKeyData).toString('hex');
  const fhePrivateKeyHex = Buffer.from(secretKeyData).toString('hex');

  const output = `
FHE Public Key Hex:
${fhePublicKeyHex}

FHE Private Key Hex:
${fhePrivateKeyHex}
  `;

  // Write output to file
  fs.writeFileSync('fhe-keys.txt', output.trim());

  console.log('✅ Keys generated and saved to fhe-keys.txt');
}

generateKeys();
