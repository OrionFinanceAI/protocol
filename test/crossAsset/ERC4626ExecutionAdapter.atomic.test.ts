/**
 * ERC4626ExecutionAdapter - Atomic Guarantee Unit Tests
 *
 * Verifies that within a single buy() transaction:
 * - previewBuy determines the exact amount pulled from the caller
 * - The swap executor receives exactly the previewBuy amount
 * - No tokens are stuck in the adapter
 *
 * Uses mocks (no mainnet fork required) to isolate and verify
 * the atomic previewBuy→pull→swap→mint flow.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ERC4626ExecutionAdapter,
  MockUnderlyingAsset,
  MockERC4626Asset,
  MockOrionConfig,
  MockLiquidityOrchestrator,
  SpyExecutionAdapter,
} from "../../typechain-types";

describe("ERC4626ExecutionAdapter - Atomic Guarantees (Unit)", function () {
  let owner: SignerWithAddress;
  let loSigner: SignerWithAddress;

  // Mocks
  let usdc: MockUnderlyingAsset;
  let weth: MockUnderlyingAsset;
  let vault: MockERC4626Asset;
  let config: MockOrionConfig;
  let liquidityOrchestrator: MockLiquidityOrchestrator;
  let spySwapExecutor: SpyExecutionAdapter;

  // Contract under test
  let vaultAdapter: ERC4626ExecutionAdapter;

  const USDC_DECIMALS = 6;
  const WETH_DECIMALS = 18;

  before(async function () {
    [owner] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockUnderlyingAsset");
    usdc = (await MockERC20.deploy(USDC_DECIMALS)) as unknown as MockUnderlyingAsset;
    weth = (await MockERC20.deploy(WETH_DECIMALS)) as unknown as MockUnderlyingAsset;

    // Deploy mock ERC4626 vault (WETH underlying)
    const MockVaultFactory = await ethers.getContractFactory("MockERC4626Asset");
    vault = (await MockVaultFactory.deploy(
      await weth.getAddress(),
      "Mock WETH Vault",
      "mVWETH",
    )) as unknown as MockERC4626Asset;

    // Deploy config
    const MockConfigFactory = await ethers.getContractFactory("MockOrionConfig");
    config = (await MockConfigFactory.deploy(await usdc.getAddress())) as unknown as MockOrionConfig;

    // Deploy LO
    const MockLOFactory = await ethers.getContractFactory("MockLiquidityOrchestrator");
    liquidityOrchestrator = (await MockLOFactory.deploy(
      await config.getAddress(),
    )) as unknown as MockLiquidityOrchestrator;

    // Wire config → LO
    await config.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

    // Register token decimals
    await config.setTokenDecimals(await weth.getAddress(), WETH_DECIMALS);
    await config.setTokenDecimals(await vault.getAddress(), WETH_DECIMALS); // vault shares = 18 decimals

    // Deploy spy swap executor
    const SpyFactory = await ethers.getContractFactory("SpyExecutionAdapter");
    spySwapExecutor = (await SpyFactory.deploy(await usdc.getAddress())) as unknown as SpyExecutionAdapter;

    // Register WETH → spy swap executor in LO
    await liquidityOrchestrator.setExecutionAdapter(await weth.getAddress(), await spySwapExecutor.getAddress());

    // Deploy the real vault adapter (contract under test)
    const VaultAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
    vaultAdapter = (await VaultAdapterFactory.deploy(await config.getAddress())) as unknown as ERC4626ExecutionAdapter;

    // Register vault → vault adapter in LO
    await liquidityOrchestrator.setExecutionAdapter(await vault.getAddress(), await vaultAdapter.getAddress());

    // Setup impersonated LO signer
    const loAddress = await liquidityOrchestrator.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [loAddress]);
    loSigner = await ethers.getSigner(loAddress);
    await owner.sendTransaction({ to: loAddress, value: ethers.parseEther("10") });
  });

  describe("Cross-Asset Buy - Atomic previewBuy→pull consistency", function () {
    const PREVIEW_BUY_AMOUNT = ethers.parseUnits("2500", 6); // 2500 USDC
    const SHARES_TO_BUY = ethers.parseUnits("1", 18); // 1 vault share

    beforeEach(async function () {
      // Configure spy: previewBuy returns exactly 2500 USDC
      await spySwapExecutor.setPreviewBuyReturn(PREVIEW_BUY_AMOUNT);

      // Fund LO with generous USDC (more than needed)
      await usdc.mint(loSigner.address, ethers.parseUnits("100000", USDC_DECIMALS));

      // Fund spy executor with WETH so it can "output" WETH to the vault adapter
      const wethNeeded = await vault.previewMint(SHARES_TO_BUY);
      await weth.mint(await spySwapExecutor.getAddress(), wethNeeded * 2n);
    });

    it("Should transfer exactly previewBuy amount to swap executor", async function () {
      // Approve generous amount — 10x what previewBuy says
      const generousApproval = PREVIEW_BUY_AMOUNT * 10n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), generousApproval);

      // Execute buy
      await vaultAdapter.connect(loSigner).buy(await vault.getAddress(), SHARES_TO_BUY);

      // The spy recorded how much allowance it received from the vault adapter
      const allowanceReceived = await spySwapExecutor.lastBuyAllowanceReceived();
      const previewResult = await spySwapExecutor.lastPreviewBuyResult();

      // THE ATOMIC GUARANTEE: swap executor received exactly what previewBuy returned
      expect(allowanceReceived).to.equal(previewResult);
      expect(allowanceReceived).to.equal(PREVIEW_BUY_AMOUNT);

      console.log(`  previewBuy returned: ${ethers.formatUnits(previewResult, USDC_DECIMALS)} USDC`);
      console.log(`  swap executor received: ${ethers.formatUnits(allowanceReceived, USDC_DECIMALS)} USDC`);
    });

    it("Should pull exactly previewBuy amount from caller (not full allowance)", async function () {
      const generousApproval = PREVIEW_BUY_AMOUNT * 10n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), generousApproval);

      const balanceBefore = await usdc.balanceOf(loSigner.address);
      await vaultAdapter.connect(loSigner).buy(await vault.getAddress(), SHARES_TO_BUY);
      const balanceAfter = await usdc.balanceOf(loSigner.address);

      const actualPulled = balanceBefore - balanceAfter;

      // Pulled exactly what previewBuy said, NOT the full generous approval
      expect(actualPulled).to.equal(PREVIEW_BUY_AMOUNT);
      expect(actualPulled).to.be.lt(generousApproval);

      console.log(`  Approved: ${ethers.formatUnits(generousApproval, USDC_DECIMALS)} USDC`);
      console.log(`  Pulled:   ${ethers.formatUnits(actualPulled, USDC_DECIMALS)} USDC`);
    });

    it("Should emit matching previewBuy and buy events in same tx", async function () {
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), PREVIEW_BUY_AMOUNT * 10n);

      const tx = await vaultAdapter.connect(loSigner).buy(await vault.getAddress(), SHARES_TO_BUY);
      const receipt = await tx.wait();

      // Find PreviewBuyCalled and BuyCalled events from the spy
      const spyInterface = spySwapExecutor.interface;
      const previewEvent = receipt!.logs
        .map((log) => {
          try {
            return spyInterface.parseLog({ topics: [...log.topics], data: log.data });
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "PreviewBuyCalled");

      const buyEvent = receipt!.logs
        .map((log) => {
          try {
            return spyInterface.parseLog({ topics: [...log.topics], data: log.data });
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "BuyCalled");

      void expect(previewEvent).to.not.be.null;
      void expect(buyEvent).to.not.be.null;

      const previewAmount = previewEvent!.args[0];
      const buyReceivedAmount = buyEvent!.args[0];

      // Both events in the same transaction — values must match exactly
      expect(buyReceivedAmount).to.equal(previewAmount);

      console.log(`  PreviewBuyCalled: ${ethers.formatUnits(previewAmount, USDC_DECIMALS)} USDC`);
      console.log(`  BuyCalled received: ${ethers.formatUnits(buyReceivedAmount, USDC_DECIMALS)} USDC`);
    });

    it("Should leave zero adapter balances after buy", async function () {
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), PREVIEW_BUY_AMOUNT * 10n);

      await vaultAdapter.connect(loSigner).buy(await vault.getAddress(), SHARES_TO_BUY);

      const adapterAddr = await vaultAdapter.getAddress();
      expect(await usdc.balanceOf(adapterAddr)).to.equal(0);
      expect(await weth.balanceOf(adapterAddr)).to.equal(0);
      expect(await vault.balanceOf(adapterAddr)).to.equal(0);
    });

    it("Should deliver exact shares to caller", async function () {
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), PREVIEW_BUY_AMOUNT * 10n);

      const sharesBefore = await vault.balanceOf(loSigner.address);
      await vaultAdapter.connect(loSigner).buy(await vault.getAddress(), SHARES_TO_BUY);
      const sharesAfter = await vault.balanceOf(loSigner.address);

      expect(sharesAfter - sharesBefore).to.equal(SHARES_TO_BUY);
    });

    it("Should work with different previewBuy amounts", async function () {
      // Test with a different previewBuy value
      const differentAmount = ethers.parseUnits("5000", USDC_DECIMALS);
      await spySwapExecutor.setPreviewBuyReturn(differentAmount);

      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), differentAmount * 10n);

      const balanceBefore = await usdc.balanceOf(loSigner.address);
      await vaultAdapter.connect(loSigner).buy(await vault.getAddress(), SHARES_TO_BUY);
      const balanceAfter = await usdc.balanceOf(loSigner.address);

      const actualPulled = balanceBefore - balanceAfter;
      expect(actualPulled).to.equal(differentAmount);

      const recorded = await spySwapExecutor.lastBuyAllowanceReceived();
      expect(recorded).to.equal(differentAmount);

      console.log(`  previewBuy set to: ${ethers.formatUnits(differentAmount, USDC_DECIMALS)} USDC`);
      console.log(`  Actually pulled: ${ethers.formatUnits(actualPulled, USDC_DECIMALS)} USDC`);
    });
  });

  describe("Same-Asset Buy - Atomic previewMint→pull consistency", function () {
    let usdcVault: MockERC4626Asset;
    let usdcVaultAdapter: ERC4626ExecutionAdapter;

    before(async function () {
      // Deploy same-asset vault (USDC → USDC vault)
      const MockVaultFactory = await ethers.getContractFactory("MockERC4626Asset");
      usdcVault = (await MockVaultFactory.deploy(
        await usdc.getAddress(),
        "USDC Vault",
        "vUSDC",
      )) as unknown as MockERC4626Asset;

      // Register decimals
      await config.setTokenDecimals(await usdc.getAddress(), USDC_DECIMALS);
      await config.setTokenDecimals(await usdcVault.getAddress(), USDC_DECIMALS);

      // Deploy separate adapter
      const VaultAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      usdcVaultAdapter = (await VaultAdapterFactory.deploy(
        await config.getAddress(),
      )) as unknown as ERC4626ExecutionAdapter;

      // Register in LO
      await liquidityOrchestrator.setExecutionAdapter(
        await usdcVault.getAddress(),
        await usdcVaultAdapter.getAddress(),
      );

      // Seed vault with initial deposit to establish exchange rate
      await usdc.mint(owner.address, ethers.parseUnits("10000", USDC_DECIMALS));
      await usdc.approve(await usdcVault.getAddress(), ethers.parseUnits("10000", USDC_DECIMALS));
      await usdcVault.deposit(ethers.parseUnits("10000", USDC_DECIMALS), owner.address);
    });

    it("Should pull exactly previewMint amount (same-asset, no swap)", async function () {
      const sharesAmount = ethers.parseUnits("100", USDC_DECIMALS);

      // What the vault says it needs
      const previewMintAmount = await usdcVault.previewMint(sharesAmount);

      // Fund LO and approve generously
      await usdc.mint(loSigner.address, previewMintAmount * 10n);
      const generousApproval = previewMintAmount * 10n;
      await usdc.connect(loSigner).approve(await usdcVaultAdapter.getAddress(), generousApproval);

      const balanceBefore = await usdc.balanceOf(loSigner.address);
      await usdcVaultAdapter.connect(loSigner).buy(await usdcVault.getAddress(), sharesAmount);
      const balanceAfter = await usdc.balanceOf(loSigner.address);

      const actualPulled = balanceBefore - balanceAfter;

      // Same-asset: pulled exactly previewMint, not the full approval
      expect(actualPulled).to.equal(previewMintAmount);
      expect(actualPulled).to.be.lt(generousApproval);

      // Exact shares delivered
      const shares = await usdcVault.balanceOf(loSigner.address);
      expect(shares).to.equal(sharesAmount);

      console.log(`  previewMint: ${ethers.formatUnits(previewMintAmount, USDC_DECIMALS)} USDC`);
      console.log(`  Pulled:      ${ethers.formatUnits(actualPulled, USDC_DECIMALS)} USDC`);
      console.log(`  Approved:    ${ethers.formatUnits(generousApproval, USDC_DECIMALS)} USDC`);
    });
  });
});
