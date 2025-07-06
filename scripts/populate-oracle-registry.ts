// scripts/register-oracles.ts
import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

/* -------- helpers ------------------------------------------------------- */

function csv(name: string): string[] {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v
    .split(",")
    .map((s) => s.trim().replace(/['"]/g, ""))
    .filter((s) => s.length);
}

function validate(addr: string, tag: string): string {
  if (!ethers.isAddress(addr)) throw new Error(`Invalid ${tag}: ${addr}`);
  return ethers.getAddress(addr); // checksums it
}

/* -------- main ---------------------------------------------------------- */

async function main() {
  const [deployer] = await ethers.getSigners();

  /* env ──────────────────────────────────────────────────────────────── */
  const assetsRaw = csv("UNIVERSE_LIST");
  const oraclesRaw = csv("ORACLE_ADDRESSES");
  const registry = validate(process.env.ORACLE_REGISTRY_ADDRESS || "", "registry");

  if (assetsRaw.length !== oraclesRaw.length)
    throw new Error(
      `UNIVERSE_LIST (${assetsRaw.length}) and ORACLE_ADDRESSES (${oraclesRaw.length}) must have the same length`,
    );

  const assets = assetsRaw.map((a) => validate(a, "asset"));
  const oracles = oraclesRaw.map((o) => validate(o, "oracle"));

  console.log(`Populating OracleRegistry @ ${registry}`);
  console.log(`Caller/owner:              ${await deployer.getAddress()}`);
  console.log(`Pairs to add:              ${assets.length}\n`);

  /* bind registry interface */
  const OracleRegistry = await ethers.getContractAt("OracleRegistry", registry);

  /* loop serially (clearer logs) */
  for (let i = 0; i < assets.length; i++) {
    const [asset, oracle] = [assets[i], oracles[i]];
    console.log(`🔧  setAdapter(${asset}, ${oracle}) …`);

    const tx = await OracleRegistry.setAdapter(asset, oracle);
    await tx.wait();

    console.log(`✅  registered (tx: ${tx.hash})`);
  }

  console.log("\n🎉  All oracles registered.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
