import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, networkHelpers } from "../helpers/hh";
import { deployUpgradeableProtocol } from "../helpers/deployUpgradeable";
import { resetNetwork } from "../helpers/resetNetwork";

import type {
  OrionConfig,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  MockUnderlyingAsset,
} from "../typechain-types";

describe("Orchestrators - zero deposits and zero intents", function () {
  let orionConfig: OrionConfig;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;
  let transparentVault: OrionTransparentVault;
  let underlyingAsset: MockUnderlyingAsset;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, strategist, automationRegistry, user] = await ethers.getSigners();

    const deployed = await deployUpgradeableProtocol(owner, undefined, automationRegistry);

    underlyingAsset = deployed.underlyingAsset;
    orionConfig = deployed.orionConfig;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    // Configure protocol
    await liquidityOrchestrator.setTargetBufferRatio(100); // 1%
    await liquidityOrchestrator.setSlippageTolerance(50); // 0.5% slippage

    // Create transparent vault (no intent submitted)
    const tx = await transparentVaultFactory
      .connect(owner)
      .createVault(strategist.address, "ZeroState TV", "ZTV", 0, 0, 0, ethers.ZeroAddress);
    const rcpt = await tx.wait();
    const ev = rcpt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const parsedEvent = transparentVaultFactory.interface.parseLog(ev!);
    const tvAddress = parsedEvent?.args[0];
    transparentVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      tvAddress,
    )) as unknown as OrionTransparentVault;

    // Mint underlying assets to user for potential deposits
    await underlyingAsset.mint(user.address, ethers.parseUnits("10000", 12));

    // Ensure no deposits or intents present
    expect(await transparentVault.pendingDeposit(await orionConfig.maxFulfillBatchSize())).to.equal(0);
    expect(await transparentVault.pendingRedeem(await orionConfig.maxFulfillBatchSize())).to.equal(0);
  });

  it("starts epoch commitment for a registered zero-state vault", async function () {
    expect(await transparentVault.totalAssets()).to.equal(0);

    const epochDuration = await liquidityOrchestrator.epochDuration();
    await networkHelpers.time.increase(epochDuration + 1n);

    expect(await liquidityOrchestrator.checkUpkeep()).to.equal(true);
    await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x");

    // All registered transparent vaults enter epoch accounting, even with zero TVL.
    expect(await liquidityOrchestrator.currentPhase()).to.equal(1n); // StateCommitment
    expect(await liquidityOrchestrator.checkUpkeep()).to.equal(true);
  });

  it("starts epoch commitment when vault has intent but no TVL or pending deposits", async function () {
    const intent = [
      {
        token: await underlyingAsset.getAddress(),
        weight: 1000000000, // 100% (100% of 1e9)
      },
    ];
    await transparentVault.connect(strategist).submitIntent(intent);

    expect(await transparentVault.totalAssets()).to.equal(0);
    expect(await transparentVault.pendingDeposit(await orionConfig.maxFulfillBatchSize())).to.equal(0);

    const [intentTokens] = await transparentVault.getIntent();
    expect(intentTokens.length).to.be.gt(0);

    const epochDuration = await liquidityOrchestrator.epochDuration();
    await networkHelpers.time.increase(epochDuration + 1n);

    expect(await liquidityOrchestrator.checkUpkeep()).to.equal(true);
    await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x");

    expect(await liquidityOrchestrator.currentPhase()).to.equal(1n); // StateCommitment
    expect(await liquidityOrchestrator.checkUpkeep()).to.equal(true);
  });
});
