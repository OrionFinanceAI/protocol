import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployUpgradeableProtocol } from "../helpers/deployUpgradeable";

import {
  OrionConfig,
  InternalStateOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  MockUnderlyingAsset,
} from "../../typechain-types";

describe("Orchestrators - zero deposits and zero intents", function () {
  let orionConfig: OrionConfig;
  let InternalStateOrchestrator: InternalStateOrchestrator;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;
  let transparentVault: OrionTransparentVault;
  let underlyingAsset: MockUnderlyingAsset;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    [owner, strategist, automationRegistry, user] = await ethers.getSigners();

    const deployed = await deployUpgradeableProtocol(owner, undefined, automationRegistry);

    underlyingAsset = deployed.underlyingAsset;
    orionConfig = deployed.orionConfig;
    InternalStateOrchestrator = deployed.InternalStateOrchestrator;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    // Configure protocol
    await liquidityOrchestrator.setTargetBufferRatio(100); // 1%

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

  it("completes upkeep with zero TVL and zero intents without errors", async function () {
    // Fast forward time to trigger upkeep
    const epochDuration = await InternalStateOrchestrator.epochDuration();
    await time.increase(epochDuration + 1n);

    // Start
    const [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(0);
  });

  it("should not move forward when vault has no total assets and no pending deposits but has valid intent", async function () {
    // Submit a valid intent to the vault
    const intent = [
      {
        token: await underlyingAsset.getAddress(),
        weight: 1000000000, // 100% (100% of 1e9)
      },
    ];
    await transparentVault.connect(strategist).submitIntent(intent);

    // Verify the vault has no total assets and no pending deposits
    expect(await transparentVault.totalAssets()).to.equal(0);
    expect(await transparentVault.pendingDeposit(await orionConfig.maxFulfillBatchSize())).to.equal(0);

    // Verify the vault has a valid intent
    const [intentTokens, _intentWeights] = await transparentVault.getIntent();
    expect(intentTokens.length).to.be.gt(0);

    // Fast forward time to trigger upkeep
    const epochDuration = await InternalStateOrchestrator.epochDuration();
    await time.increase(epochDuration + 1n);

    // Check that upkeep is needed
    const [upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    void expect(upkeepNeeded).to.be.true;

    // Perform upkeep - should complete but not move to next phase
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);

    // Should remain in Idle phase (0) because no vaults were processed
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(0);
  });
});
