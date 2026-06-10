import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { AbiCoder, keccak256 } from "ethers";
import { ethers } from "./helpers/hh";

import type {
  ConfigurableExecutionAdapter,
  LiquidityOrchestratorHarness,
  MockUnderlyingAsset,
  OrionConfig,
  OrionTransparentVault,
  PriceAdapterRegistry,
  TransparentVaultFactory,
  UpgradeableBeacon,
} from "../typechain-types";
import { deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import { STATES_STRUCT_TYPE } from "../scripts/decode-states-struct";

const abiCoder = AbiCoder.defaultAbiCoder();

type VaultStateInput = {
  processRedeem: boolean;
  totalAssetsForRedeem: bigint;
  totalAssetsForDeposit: bigint;
  finalTotalAssets: bigint;
  managementFee: bigint;
  performanceFee: bigint;
  tokens: string[];
  shares: bigint[];
};

type StatesStructInput = {
  vaults: VaultStateInput[];
  sellLeg: {
    sellingTokens: string[];
    sellingAmounts: bigint[];
    sellingEstimatedUnderlyingAmounts: bigint[];
  };
  buyLeg: {
    buyingTokens: string[];
    buyingAmounts: bigint[];
    buyingEstimatedUnderlyingAmounts: bigint[];
  };
  bufferAmount: bigint;
  epochProtocolFees: bigint;
  nettedRebalanceVolumeUnderlying: bigint;
};

function encodeStatesStruct(states: StatesStructInput): string {
  return abiCoder.encode([STATES_STRUCT_TYPE], [states]);
}

function outputCommitment(states: StatesStructInput): string {
  return keccak256(encodeStatesStruct(states));
}

describe("StatesStruct / VaultState schema", function () {
  let harness: LiquidityOrchestratorHarness;
  let orionConfig: OrionConfig;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockUnderlyingAsset;
  let executionAdapter: ConfigurableExecutionAdapter;
  let mockAssetAddress: string;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let user: SignerWithAddress;

  const UNDERLYING_DECIMALS = 6;

  async function createVault(): Promise<OrionTransparentVault> {
    const tx = await transparentVaultFactory
      .connect(owner)
      .createVault(strategist.address, "Schema Vault", "SV", 0, 0, 0, ethers.ZeroAddress);
    const receipt = await tx.wait();
    const log = receipt?.logs.find((l) => {
      try {
        return transparentVaultFactory.interface.parseLog(l)?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const vaultAddress = transparentVaultFactory.interface.parseLog(log!)?.args?.[0];
    return ethers.getContractAt("OrionTransparentVault", vaultAddress) as unknown as Promise<OrionTransparentVault>;
  }

  async function impersonateLo(): Promise<SignerWithAddress> {
    const loAddress = await harness.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [loAddress]);
    await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1"))]);
    return ethers.getSigner(loAddress);
  }

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, strategist, user] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlyingAsset = (await MockUnderlyingAssetFactory.deploy(UNDERLYING_DECIMALS)) as unknown as MockUnderlyingAsset;
    await underlyingAsset.waitForDeployment();

    orionConfig = await deployUUPSProxy<OrionConfig>(
      "OrionConfig",
      [owner.address, await underlyingAsset.getAddress()],
      owner,
    );

    const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
      "PriceAdapterRegistry",
      [owner.address, await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    const SP1VerifierGatewayFactory = await ethers.getContractFactory("SP1VerifierGateway");
    const sp1VerifierGateway = await SP1VerifierGatewayFactory.deploy(owner.address);
    await sp1VerifierGateway.waitForDeployment();
    const SP1VerifierFactory = await ethers.getContractFactory("SP1Verifier");
    const sp1Verifier = await SP1VerifierFactory.deploy();
    await sp1Verifier.waitForDeployment();
    await sp1VerifierGateway.addRoute(await sp1Verifier.getAddress());

    const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
    harness = await deployUUPSProxy<LiquidityOrchestratorHarness>(
      "LiquidityOrchestratorHarness",
      [owner.address, await orionConfig.getAddress(), owner.address, await sp1VerifierGateway.getAddress(), vKey],
      owner,
    );
    await orionConfig.setLiquidityOrchestrator(await harness.getAddress());

    const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vaultImpl = await VaultImplFactory.deploy();
    await vaultImpl.waitForDeployment();
    const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
    const vaultBeacon = (await BeaconFactory.deploy(
      await vaultImpl.getAddress(),
      owner.address,
    )) as unknown as UpgradeableBeacon;
    await vaultBeacon.waitForDeployment();

    transparentVaultFactory = await deployUUPSProxy<TransparentVaultFactory>(
      "TransparentVaultFactory",
      [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
      owner,
    );
    await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());

    const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
    const mockAsset = await MockERC4626Factory.deploy(await underlyingAsset.getAddress(), "Mock Asset", "MA");
    await mockAsset.waitForDeployment();
    mockAssetAddress = await mockAsset.getAddress();

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    const priceAdapter = await MockPriceAdapterFactory.deploy();
    await priceAdapter.waitForDeployment();

    const ConfigurableExecutionAdapterFactory = await ethers.getContractFactory("ConfigurableExecutionAdapter");
    executionAdapter = (await ConfigurableExecutionAdapterFactory.deploy(
      await underlyingAsset.getAddress(),
    )) as unknown as ConfigurableExecutionAdapter;
    await executionAdapter.waitForDeployment();
    await executionAdapter.setSellReturnAmount(ethers.parseUnits("100", UNDERLYING_DECIMALS));

    await orionConfig.addWhitelistedAsset(
      mockAssetAddress,
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
  });

  async function queueRedeem(vault: OrionTransparentVault): Promise<bigint> {
    const redeemShares = await vault.balanceOf(user.address);
    await vault.connect(user).approve(await vault.getAddress(), redeemShares);
    await vault.connect(user).requestRedeem(redeemShares);
    return redeemShares;
  }

  it("round-trips StatesStruct with processRedeem true and false", function () {
    const states: StatesStructInput = {
      vaults: [
        {
          processRedeem: true,
          totalAssetsForRedeem: 100n,
          totalAssetsForDeposit: 200n,
          finalTotalAssets: 900n,
          managementFee: 1n,
          performanceFee: 2n,
          tokens: [ethers.Wallet.createRandom().address],
          shares: [42n],
        },
        {
          processRedeem: false,
          totalAssetsForRedeem: 0n,
          totalAssetsForDeposit: 50n,
          finalTotalAssets: 500n,
          managementFee: 0n,
          performanceFee: 0n,
          tokens: [],
          shares: [],
        },
      ],
      sellLeg: {
        sellingTokens: [ethers.Wallet.createRandom().address],
        sellingAmounts: [0n],
        sellingEstimatedUnderlyingAmounts: [0n],
      },
      buyLeg: {
        buyingTokens: [],
        buyingAmounts: [],
        buyingEstimatedUnderlyingAmounts: [],
      },
      bufferAmount: 123n,
      epochProtocolFees: 4n,
      nettedRebalanceVolumeUnderlying: 5n,
    };

    const encoded = encodeStatesStruct(states);
    const [decoded] = abiCoder.decode([STATES_STRUCT_TYPE], encoded);

    expect(decoded.vaults[0].processRedeem).to.equal(true);
    expect(decoded.vaults[1].processRedeem).to.equal(false);
    expect(decoded.vaults[1].totalAssetsForRedeem).to.equal(0n);
    expect(decoded.sellLeg.sellingAmounts[0]).to.equal(0n);
  });

  it("changes output commitment when processRedeem is included", function () {
    const baseVault = {
      totalAssetsForRedeem: 0n,
      totalAssetsForDeposit: 0n,
      finalTotalAssets: 100n,
      managementFee: 0n,
      performanceFee: 0n,
      tokens: [] as string[],
      shares: [] as bigint[],
    };

    const emptyLegs = {
      sellLeg: { sellingTokens: [], sellingAmounts: [], sellingEstimatedUnderlyingAmounts: [] },
      buyLeg: { buyingTokens: [], buyingAmounts: [], buyingEstimatedUnderlyingAmounts: [] },
      bufferAmount: 0n,
      epochProtocolFees: 0n,
      nettedRebalanceVolumeUnderlying: 0n,
    };

    const withTrue = outputCommitment({
      ...emptyLegs,
      vaults: [{ ...baseVault, processRedeem: true }],
    });
    const withFalse = outputCommitment({
      ...emptyLegs,
      vaults: [{ ...baseVault, processRedeem: false }],
    });

    expect(withTrue).to.not.equal(withFalse);
    expect(withTrue).to.equal(outputCommitment({ ...emptyLegs, vaults: [{ ...baseVault, processRedeem: true }] }));
  });

  it("skips redeem fulfillment when processRedeem is false", async function () {
    const vault = await createVault();
    const depositAmount = ethers.parseUnits("1000", UNDERLYING_DECIMALS);

    await underlyingAsset.mint(user.address, depositAmount);
    await underlyingAsset.connect(user).approve(await vault.getAddress(), depositAmount);
    await vault.connect(user).requestDeposit(depositAmount);

    const loSigner = await impersonateLo();
    await vault.connect(loSigner).fulfillDeposit(depositAmount);
    await vault.connect(loSigner).updateVaultState([await underlyingAsset.getAddress()], [0n], depositAmount);

    const redeemShares = await queueRedeem(vault);
    expect(await vault.pendingRedeemCount()).to.equal(1n);
    void redeemShares;

    const underlying = await underlyingAsset.getAddress();
    const targetTvl = ethers.parseUnits("900", UNDERLYING_DECIMALS);

    await harness.exposed_processSingleVaultOperations(
      await vault.getAddress(),
      false,
      0n,
      0n,
      targetTvl,
      0n,
      0n,
      [underlying],
      [0n],
    );

    expect(await vault.pendingRedeemCount()).to.equal(1n);
    expect(await vault.totalAssets()).to.equal(targetTvl);
  });

  it("fulfills redeem when processRedeem is true", async function () {
    const vault = await createVault();
    const depositAmount = ethers.parseUnits("1000", UNDERLYING_DECIMALS);

    await underlyingAsset.mint(user.address, depositAmount);
    await underlyingAsset.connect(user).approve(await vault.getAddress(), depositAmount);
    await vault.connect(user).requestDeposit(depositAmount);

    const loSigner = await impersonateLo();
    await vault.connect(loSigner).fulfillDeposit(depositAmount);
    await vault.connect(loSigner).updateVaultState([await underlyingAsset.getAddress()], [0n], depositAmount);

    const redeemShares = await queueRedeem(vault);
    expect(await vault.pendingRedeemCount()).to.equal(1n);
    void redeemShares;

    const redeemBasis = ethers.parseUnits("1000", UNDERLYING_DECIMALS);
    await underlyingAsset.mint(await harness.getAddress(), redeemBasis);

    const underlying = await underlyingAsset.getAddress();

    await harness.exposed_processSingleVaultOperations(
      await vault.getAddress(),
      true,
      0n,
      redeemBasis,
      ethers.parseUnits("900", UNDERLYING_DECIMALS),
      0n,
      0n,
      [underlying],
      [0n],
    );

    expect(await vault.pendingRedeemCount()).to.equal(0n);
  });

  it("skips redeem fulfillment when processRedeem is false even if totalAssetsForRedeem is non-zero", async function () {
    const vault = await createVault();
    const depositAmount = ethers.parseUnits("1000", UNDERLYING_DECIMALS);

    await underlyingAsset.mint(user.address, depositAmount);
    await underlyingAsset.connect(user).approve(await vault.getAddress(), depositAmount);
    await vault.connect(user).requestDeposit(depositAmount);

    const loSigner = await impersonateLo();
    await vault.connect(loSigner).fulfillDeposit(depositAmount);
    await vault.connect(loSigner).updateVaultState([await underlyingAsset.getAddress()], [0n], depositAmount);

    const redeemShares = await queueRedeem(vault);
    expect(await vault.pendingRedeemCount()).to.equal(1n);
    void redeemShares;

    await harness.exposed_processSingleVaultOperations(
      await vault.getAddress(),
      false,
      0n,
      1n,
      ethers.parseUnits("900", UNDERLYING_DECIMALS),
      0n,
      0n,
      [await underlyingAsset.getAddress()],
      [0n],
    );

    expect(await vault.pendingRedeemCount()).to.equal(1n);
  });

  it("advances minibatch cursor over zero-amount sell legs without executing", async function () {
    await harness.exposed_registerExecutionAdapter(mockAssetAddress, await executionAdapter.getAddress());
    await harness.connect(owner).updateExecutionMinibatchSize(2);
    await harness.exposed_setLegUpkeepState(2, 0, 0); // SellingLeg

    const sellLeg = {
      sellingTokens: [mockAssetAddress, mockAssetAddress, mockAssetAddress],
      sellingAmounts: [0n, 0n, 0n],
      sellingEstimatedUnderlyingAmounts: [0n, 0n, 0n],
    };

    await harness.exposed_processMinibatchSell(sellLeg);
    expect(await executionAdapter.sellCallCount(mockAssetAddress)).to.equal(0n);
    expect(await harness.completedInCurrentMinibatch()).to.equal(0n);
    expect(await harness.currentMinibatchIndex()).to.equal(1);
    expect(await harness.currentPhase()).to.equal(2n); // still SellingLeg
  });
});
