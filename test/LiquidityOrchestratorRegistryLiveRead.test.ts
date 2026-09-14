/**
 * LO initialized before Config.priceAdapterRegistry was set: pricing live-reads Config,
 * so a zero cached slot is irrelevant after upgrade / with current impl.
 */
import { expect } from "chai";
import { ethers } from "./helpers/hh";
import { deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  LiquidityOrchestratorPriceHarness,
  MockSP1Verifier,
  MockUnderlyingAsset,
  OrionConfig,
  PriceAdapterRegistry,
} from "../typechain-types";

describe("LiquidityOrchestrator – priceAdapterRegistry live-read", function () {
  let owner: SignerWithAddress;
  let automationRegistry: SignerWithAddress;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, automationRegistry] = await ethers.getSigners();
  });

  it("prices via Config registry even when LO was initialized before registry was set", async function () {
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlying.waitForDeployment();

    const orionConfig = await deployUUPSProxy<OrionConfig>(
      "OrionConfig",
      [owner.address, await underlying.getAddress()],
      owner,
    );

    const MockSP1VerifierFactory = await ethers.getContractFactory("MockSP1Verifier");
    const mockVerifier = (await MockSP1VerifierFactory.deploy()) as unknown as MockSP1Verifier;
    await mockVerifier.waitForDeployment();

    const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
    // Initialize LO while Config.registry is still address(0) — mainnet mis-order.
    const priceHarness = await deployUUPSProxy<LiquidityOrchestratorPriceHarness>(
      "LiquidityOrchestratorPriceHarness",
      [await orionConfig.getAddress(), automationRegistry.address, await mockVerifier.getAddress(), vKey],
      owner,
    );
    await orionConfig.setLiquidityOrchestrator(await priceHarness.getAddress());

    const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
      "PriceAdapterRegistry",
      [await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    await expect(priceHarness.h_snapshotEpochPricesFromConfig()).to.not.be.rejected;

    const prices = await priceHarness.getAssetPrices([await underlying.getAddress()]);
    expect(prices[0]).to.equal(10n ** BigInt(await orionConfig.priceAdapterDecimals()));
  });
});
