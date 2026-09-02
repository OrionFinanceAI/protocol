/**
 * OrionConfig gas feasibility-domain gate (EIP-7825 80% domain).
 *
 * Coefficients must stay in sync with locals in OrionConfig._requireFeasibilityDomain.
 */
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hh";

import type {
  MockERC4626Asset,
  MockExecutionAdapter,
  MockPriceAdapter,
  MockUnderlyingAsset,
  OrionConfig,
  TransparentVaultFactory,
} from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

/** Keep in sync with OrionConfig._requireFeasibilityDomain locals. */
const FEASIBILITY_GAS_A = 166067n;
const FEASIBILITY_GAS_B = 63265n;
const FEASIBILITY_GAS_C = 42182n;
const EIP7825_TX_GAS_LIMIT = 16_777_216n;
const FEASIBILITY_UTILIZATION_BPS = 8000n;

function feasibilityGasHat(vaults: bigint, assets: bigint): bigint {
  return FEASIBILITY_GAS_A + FEASIBILITY_GAS_B * vaults + FEASIBILITY_GAS_C * assets;
}

function feasibilityGasLimit(utilizationBps = FEASIBILITY_UTILIZATION_BPS): bigint {
  return (EIP7825_TX_GAS_LIMIT * utilizationBps) / 10_000n;
}

function isWithinFeasibilityDomain(
  vaults: bigint,
  assets: bigint,
  utilizationBps = FEASIBILITY_UTILIZATION_BPS,
): boolean {
  return feasibilityGasHat(vaults, assets) <= feasibilityGasLimit(utilizationBps);
}

function maxVaultsForAssets(assets: bigint): bigint {
  const rem = feasibilityGasLimit() - FEASIBILITY_GAS_A - FEASIBILITY_GAS_C * assets;
  if (rem < 0n) return 0n;
  return rem / FEASIBILITY_GAS_B;
}

function vaultAddress(i: number): string {
  return ethers.getAddress(ethers.toBeHex(i + 1, 20));
}

describe("Feasibility domain guard", function () {
  let orionConfig: OrionConfig;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockUnderlyingAsset;
  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let factorySigner: SignerWithAddress;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, strategist] = await ethers.getSigners();
    const deployed = await deployUpgradeableProtocol(owner);
    orionConfig = deployed.orionConfig;
    transparentVaultFactory = deployed.transparentVaultFactory;
    underlyingAsset = deployed.underlyingAsset;

    const factoryAddress = await transparentVaultFactory.getAddress();
    await networkHelpers.impersonateAccount(factoryAddress);
    await networkHelpers.setBalance(factoryAddress, ethers.parseEther("1"));
    factorySigner = await ethers.getSigner(factoryAddress);
  });

  async function totalVaults(): Promise<bigint> {
    return await orionConfig.orionVaultsLength();
  }

  async function addSyntheticVaults(count: number, startIndex = 0): Promise<void> {
    for (let i = 0; i < count; ++i) {
      await orionConfig.connect(factorySigner).addOrionVault(vaultAddress(startIndex + i), 0);
    }
  }

  async function deployAndWhitelistAsset(label: string): Promise<MockERC4626Asset> {
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    const asset = (await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      `Asset ${label}`,
      label.slice(0, 4),
    )) as unknown as MockERC4626Asset;
    await asset.waitForDeployment();

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    const priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await priceAdapter.waitForDeployment();

    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    const executionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await executionAdapter.waitForDeployment();

    await orionConfig.addWhitelistedAsset(
      await asset.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
    return asset;
  }

  it("(V=1, A=2) is feasible at 80% and at full EIP-7825 cap", async function () {
    expect(isWithinFeasibilityDomain(1n, 2n, 8000n)).to.equal(true);
    expect(isWithinFeasibilityDomain(1n, 2n, 10_000n)).to.equal(true);

    await deployAndWhitelistAsset("A2");
    await addSyntheticVaults(1);

    expect(await totalVaults()).to.equal(1n);
    expect(await orionConfig.whitelistedAssetsLength()).to.equal(2n);
  });

  it("rejects adding a vault that crosses the 80% feasibility frontier; state unchanged", async function () {
    const assets = BigInt(await orionConfig.whitelistedAssetsLength());
    expect(assets).to.equal(1n);
    const maxV = maxVaultsForAssets(assets);
    expect(maxV).to.equal(208n);

    await addSyntheticVaults(Number(maxV));
    expect(await totalVaults()).to.equal(maxV);

    const nextV = maxV + 1n;
    expect(feasibilityGasHat(nextV, assets)).to.be.gt(feasibilityGasLimit());

    await expect(orionConfig.connect(factorySigner).addOrionVault(vaultAddress(Number(maxV)), 0))
      .to.be.revertedWithCustomError(orionConfig, "FeasibilityDomainExceeded")
      .withArgs(nextV, assets);

    expect(await totalVaults()).to.equal(maxV);
  });

  it("allows one vault inside the frontier then rejects the next", async function () {
    const assets = 1n;
    const maxV = maxVaultsForAssets(assets);
    await addSyntheticVaults(Number(maxV) - 1);
    expect(await totalVaults()).to.equal(maxV - 1n);

    await orionConfig.connect(factorySigner).addOrionVault(vaultAddress(Number(maxV) - 1), 0);
    expect(await totalVaults()).to.equal(maxV);

    await expect(
      orionConfig.connect(factorySigner).addOrionVault(vaultAddress(Number(maxV)), 0),
    ).to.be.revertedWithCustomError(orionConfig, "FeasibilityDomainExceeded");
  });

  it("rejects adding an asset that crosses the frontier; re-whitelist does not consume capacity", async function () {
    const maxV = maxVaultsForAssets(1n);
    await addSyntheticVaults(Number(maxV));
    // (208, 2) still feasible; (208, 3) is not
    expect(isWithinFeasibilityDomain(maxV, 2n)).to.equal(true);
    expect(isWithinFeasibilityDomain(maxV, 3n)).to.equal(false);

    const asset2 = await deployAndWhitelistAsset("A2");
    expect(await orionConfig.whitelistedAssetsLength()).to.equal(2n);

    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    const asset3 = (await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Asset A3",
      "A3xx",
    )) as unknown as MockERC4626Asset;
    await asset3.waitForDeployment();

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    const priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await priceAdapter.waitForDeployment();

    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    const executionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await executionAdapter.waitForDeployment();

    await expect(
      orionConfig.addWhitelistedAsset(
        await asset3.getAddress(),
        await priceAdapter.getAddress(),
        await executionAdapter.getAddress(),
      ),
    )
      .to.be.revertedWithCustomError(orionConfig, "FeasibilityDomainExceeded")
      .withArgs(maxV, 3n);

    expect(await orionConfig.whitelistedAssetsLength()).to.equal(2n);

    // Adapter-only update for an already-whitelisted asset must not revert on capacity
    await orionConfig.addWhitelistedAsset(
      await asset2.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
    expect(await orionConfig.whitelistedAssetsLength()).to.equal(2n);
  });

  it("createVault path hits the same capacity gate", async function () {
    const assets = BigInt(await orionConfig.whitelistedAssetsLength());
    const maxV = maxVaultsForAssets(assets);
    await addSyntheticVaults(Number(maxV));

    await expect(
      transparentVaultFactory
        .connect(owner)
        .createVault(
          strategist.address,
          "Over Cap",
          "OC",
          0,
          0,
          0,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
        ),
    ).to.be.revertedWithCustomError(orionConfig, "FeasibilityDomainExceeded");

    expect(await totalVaults()).to.equal(maxV);
  });

  it("bounded property: isWithinFeasibilityDomain matches gasHat <= 80% limit", async function () {
    const samples: Array<[bigint, bigint]> = [
      [0n, 1n],
      [1n, 2n],
      [10n, 10n],
      [100n, 50n],
      [200n, 14n],
      [208n, 1n],
      [208n, 2n],
      [208n, 3n],
      [209n, 1n],
      [50n, 239n],
      [50n, 240n],
    ];

    for (let v = 0n; v <= 220n; v += 17n) {
      for (let a = 1n; a <= 320n; a += 23n) {
        samples.push([v, a]);
      }
    }

    for (const [v, a] of samples) {
      const hat = feasibilityGasHat(v, a);
      const limit80 = feasibilityGasLimit(8000n);
      const limit100 = feasibilityGasLimit(10_000n);
      expect(isWithinFeasibilityDomain(v, a, 8000n)).to.equal(hat <= limit80);
      expect(isWithinFeasibilityDomain(v, a, 10_000n)).to.equal(hat <= limit100);
    }
  });
});
