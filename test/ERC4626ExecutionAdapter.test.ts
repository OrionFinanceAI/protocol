import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("ERC4626ExecutionAdapter", function () {
  // Test fixture setup
  async function deployERC4626ExecutionAdapterFixture() {
    const [owner, liquidityOrchestrator, user1, user2, unauthorized] = await ethers.getSigners();

    // Deploy underlying asset (USDC-like, 6 decimals)
    const UnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset: any = await UnderlyingAssetFactory.deploy(6);
    await underlyingAsset.waitForDeployment();

    // Deploy ERC4626 vault
    const ERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    const erc4626Vault: any = await ERC4626AssetFactory.deploy(underlyingAsset, "Vault Token", "VT", 6);
    await erc4626Vault.waitForDeployment();

    // Deploy ERC4626ExecutionAdapter
    const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
    const adapter: any = await ERC4626ExecutionAdapterFactory.deploy();
    await adapter.waitForDeployment();

    // Initialize adapter
    await adapter.initialize(owner.address);

    // Mint underlying assets to users
    await underlyingAsset.mint(user1.address, ethers.parseUnits("200000", 6));
    await underlyingAsset.mint(user2.address, ethers.parseUnits("200000", 6));
    await underlyingAsset.mint(liquidityOrchestrator.address, ethers.parseUnits("200000", 6));

    // Give user1 some vault shares for testing sell operations
    await underlyingAsset.connect(user1).approve(erc4626Vault, ethers.parseUnits("100000", 6));
    await erc4626Vault.connect(user1).deposit(ethers.parseUnits("100000", 6), user1.address);

    return {
      adapter,
      underlyingAsset,
      erc4626Vault,
      owner,
      liquidityOrchestrator,
      user1,
      user2,
      unauthorized,
    };
  }

  describe("Initialization", function () {
    it("Should initialize with correct owner", async function () {
      const { adapter, owner } = await loadFixture(deployERC4626ExecutionAdapterFixture);

      expect(await adapter.owner()).to.equal(owner.address);
    });

    it("Should revert if initialized with zero address owner", async function () {
      const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      const adapter: any = await ERC4626ExecutionAdapterFactory.deploy();
      await adapter.waitForDeployment();

      await expect(adapter.initialize(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        adapter,
        "OwnableInvalidOwner",
      );
    });

    it("Should not allow double initialization", async function () {
      const { adapter, owner } = await loadFixture(deployERC4626ExecutionAdapterFixture);

      await expect(adapter.initialize(owner.address)).to.be.revertedWithCustomError(adapter, "InvalidInitialization");
    });
  });

  describe("Access Control", function () {
    it("Should only allow owner to authorize upgrades", async function () {
      const { adapter, unauthorized } = await loadFixture(deployERC4626ExecutionAdapterFixture);

      await expect(
        adapter.connect(unauthorized).upgradeToAndCall(ethers.ZeroAddress, "0x"),
      ).to.be.revertedWithCustomError(adapter, "UUPSUnauthorizedCallContext");
    });
  });

  describe("Buy Function", function () {
    it("Should successfully buy vault shares with underlying assets", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const depositAmount = ethers.parseUnits("1000", 6);

      // Approve adapter to spend underlying assets from liquidity orchestrator
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), depositAmount);

      // Get initial balances
      const initialOrchestratorShares = await erc4626Vault.balanceOf(liquidityOrchestrator.address);
      const initialOrchestratorUnderlying = await underlyingAsset.balanceOf(liquidityOrchestrator.address);

      // Execute buy
      await adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), depositAmount);

      // Check balances after buy
      const finalOrchestratorShares = await erc4626Vault.balanceOf(liquidityOrchestrator.address);
      const finalOrchestratorUnderlying = await underlyingAsset.balanceOf(liquidityOrchestrator.address);
      const finalAdapterShares = await erc4626Vault.balanceOf(await adapter.getAddress());
      const finalAdapterUnderlying = await underlyingAsset.balanceOf(await adapter.getAddress());

      // Verify shares were transferred to orchestrator
      expect(finalOrchestratorShares).to.be.greaterThan(initialOrchestratorShares);

      // Verify underlying assets were consumed from orchestrator
      expect(finalOrchestratorUnderlying).to.equal(initialOrchestratorUnderlying - depositAmount);

      // Verify adapter doesn't hold shares or underlying assets
      expect(finalAdapterShares).to.equal(0);
      expect(finalAdapterUnderlying).to.equal(0);
    });

    it("Should revert if buy amount is zero", async function () {
      const { adapter, erc4626Vault, liquidityOrchestrator } = await loadFixture(deployERC4626ExecutionAdapterFixture);

      await expect(
        adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), 0),
      ).to.be.revertedWithCustomError(adapter, "AmountMustBeGreaterThanZero");
    });

    it("Should revert if orchestrator doesn't have enough underlying assets or allowance", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const depositAmount = ethers.parseUnits("1000", 6);

      // Don't approve adapter to spend assets, so it doesn't have enough allowance
      await expect(
        adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), depositAmount),
      ).to.be.revertedWithCustomError(underlyingAsset, "ERC20InsufficientAllowance");
    });

    it("Should handle partial asset amounts correctly", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const depositAmount = ethers.parseUnits("500", 6);
      const approvalAmount = ethers.parseUnits("1000", 6);

      // Approve more than needed to adapter
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), approvalAmount);

      const initialOrchestratorBalance = await underlyingAsset.balanceOf(liquidityOrchestrator.address);

      // Execute buy with partial amount
      await adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), depositAmount);

      const finalOrchestratorBalance = await underlyingAsset.balanceOf(liquidityOrchestrator.address);
      const finalAdapterBalance = await underlyingAsset.balanceOf(await adapter.getAddress());

      // Verify only the specified amount was used from orchestrator
      expect(finalOrchestratorBalance).to.equal(initialOrchestratorBalance - depositAmount);

      // Verify adapter doesn't hold any assets
      expect(finalAdapterBalance).to.equal(0);
    });

    it("Should clean up approvals after buy", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const depositAmount = ethers.parseUnits("1000", 6);

      // Approve adapter to spend underlying assets
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), depositAmount);

      // Execute buy
      await adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), depositAmount);

      // Check that approval was cleaned up (adapter to vault)
      const allowance = await underlyingAsset.allowance(await adapter.getAddress(), await erc4626Vault.getAddress());
      expect(allowance).to.equal(0);
    });

    it("Should emit transfer events during buy", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const depositAmount = ethers.parseUnits("1000", 6);

      // Approve adapter to spend underlying assets
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), depositAmount);

      // Execute buy and check for transfer events
      await expect(adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), depositAmount)).to.emit(
        erc4626Vault,
        "Transfer",
      );
    });
  });

  describe("Sell Function", function () {
    it("Should successfully sell vault shares for underlying assets", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator, user1 } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const shareAmount = ethers.parseUnits("500", 6);

      // Transfer vault shares to orchestrator and approve adapter
      await erc4626Vault.connect(user1).transfer(liquidityOrchestrator.address, shareAmount);
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), shareAmount);

      // Get initial balances
      const initialOrchestratorUnderlying = await underlyingAsset.balanceOf(liquidityOrchestrator.address);
      const initialOrchestratorShares = await erc4626Vault.balanceOf(liquidityOrchestrator.address);

      // Execute sell
      await adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), shareAmount);

      // Check balances after sell
      const finalOrchestratorUnderlying = await underlyingAsset.balanceOf(liquidityOrchestrator.address);
      const finalOrchestratorShares = await erc4626Vault.balanceOf(liquidityOrchestrator.address);
      const finalAdapterShares = await erc4626Vault.balanceOf(await adapter.getAddress());
      const finalAdapterUnderlying = await underlyingAsset.balanceOf(await adapter.getAddress());

      // Verify underlying assets were transferred to orchestrator
      expect(finalOrchestratorUnderlying).to.be.greaterThan(initialOrchestratorUnderlying);

      // Verify shares were consumed from orchestrator
      expect(finalOrchestratorShares).to.equal(initialOrchestratorShares - shareAmount);

      // Verify adapter doesn't hold shares or underlying assets
      expect(finalAdapterShares).to.equal(0);
      expect(finalAdapterUnderlying).to.equal(0);
    });

    it("Should revert if sell amount is zero", async function () {
      const { adapter, erc4626Vault, liquidityOrchestrator } = await loadFixture(deployERC4626ExecutionAdapterFixture);

      await expect(
        adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), 0),
      ).to.be.revertedWithCustomError(adapter, "SharesMustBeGreaterThanZero");
    });

    it("Should revert if orchestrator doesn't have enough shares or allowance", async function () {
      const { adapter, erc4626Vault, liquidityOrchestrator } = await loadFixture(deployERC4626ExecutionAdapterFixture);

      const shareAmount = ethers.parseUnits("1000", 6);

      // Don't approve adapter to spend shares, so it doesn't have enough allowance
      await expect(
        adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), shareAmount),
      ).to.be.revertedWithCustomError(erc4626Vault, "ERC20InsufficientAllowance");
    });

    it("Should handle partial share amounts correctly", async function () {
      const { adapter, erc4626Vault, liquidityOrchestrator, user1 } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const sellAmount = ethers.parseUnits("200", 6);
      const transferAmount = ethers.parseUnits("500", 6);
      const approvalAmount = ethers.parseUnits("300", 6);

      // Transfer shares to orchestrator and approve adapter for more than needed
      await erc4626Vault.connect(user1).transfer(liquidityOrchestrator.address, transferAmount);
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), approvalAmount);

      const initialOrchestratorShares = await erc4626Vault.balanceOf(liquidityOrchestrator.address);

      // Execute sell with partial amount
      await adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), sellAmount);

      const finalOrchestratorShares = await erc4626Vault.balanceOf(liquidityOrchestrator.address);
      const finalAdapterShares = await erc4626Vault.balanceOf(await adapter.getAddress());

      // Verify only the specified amount was used from orchestrator
      expect(finalOrchestratorShares).to.equal(initialOrchestratorShares - sellAmount);

      // Verify adapter doesn't hold any shares
      expect(finalAdapterShares).to.equal(0);
    });

    it("Should clean up approvals after sell", async function () {
      const { adapter, erc4626Vault, liquidityOrchestrator, user1 } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const shareAmount = ethers.parseUnits("1000", 6);

      // First give liquidityOrchestrator some shares to sell
      await erc4626Vault.connect(user1).transfer(liquidityOrchestrator.address, shareAmount);

      // Approve adapter to spend shares
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), shareAmount);

      // Execute sell
      await adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), shareAmount);

      // Check that approval was cleaned up (adapter to vault for shares)
      const allowance = await erc4626Vault.allowance(await adapter.getAddress(), await erc4626Vault.getAddress());
      expect(allowance).to.equal(0);
    });

    it("Should emit transfer events during sell", async function () {
      const { adapter, erc4626Vault, liquidityOrchestrator, user1 } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const shareAmount = ethers.parseUnits("500", 6);

      // Transfer vault shares to orchestrator and approve adapter
      await erc4626Vault.connect(user1).transfer(liquidityOrchestrator.address, shareAmount);
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), shareAmount);

      // Execute sell and check for transfer events
      await expect(adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), shareAmount)).to.emit(
        erc4626Vault,
        "Transfer",
      );
    });
  });

  describe("Integration with LiquidityOrchestrator Pattern", function () {
    it("Should handle the complete buy workflow as called by LiquidityOrchestrator", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const buyAmount = ethers.parseUnits("2000", 6);

      // Simulate LiquidityOrchestrator._executeBuy workflow
      // 1. Approve adapter to spend underlying assets
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), buyAmount);

      // 2. Call buy on adapter
      await adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), buyAmount);

      // 3. Verify orchestrator received the shares
      const orchestratorShares = await erc4626Vault.balanceOf(liquidityOrchestrator.address);
      expect(orchestratorShares).to.be.greaterThan(0);

      // 4. Verify adapter balances are clean
      const adapterUnderlying = await underlyingAsset.balanceOf(await adapter.getAddress());
      const adapterShares = await erc4626Vault.balanceOf(await adapter.getAddress());
      expect(adapterUnderlying).to.equal(0);
      expect(adapterShares).to.equal(0);
    });

    it("Should handle the complete sell workflow as called by LiquidityOrchestrator", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator, user1 } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const sellAmount = ethers.parseUnits("1000", 6);

      // First give orchestrator some shares
      await erc4626Vault.connect(user1).transfer(liquidityOrchestrator.address, sellAmount);

      // Simulate LiquidityOrchestrator._executeSell workflow
      // 1. Approve adapter to spend shares
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), sellAmount);

      // 2. Call sell on adapter
      await adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), sellAmount);

      // 3. Verify orchestrator received the underlying assets
      const orchestratorUnderlying = await underlyingAsset.balanceOf(liquidityOrchestrator.address);
      expect(orchestratorUnderlying).to.be.greaterThan(0);

      // 4. Verify adapter balances are clean
      const adapterUnderlying = await underlyingAsset.balanceOf(await adapter.getAddress());
      const adapterShares = await erc4626Vault.balanceOf(await adapter.getAddress());
      expect(adapterUnderlying).to.equal(0);
      expect(adapterShares).to.equal(0);
    });

    it("Should handle multiple buy operations in sequence", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const buyAmount1 = ethers.parseUnits("1000", 6);
      const buyAmount2 = ethers.parseUnits("500", 6);

      // First buy
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), buyAmount1);
      await adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), buyAmount1);

      const sharesAfterFirstBuy = await erc4626Vault.balanceOf(liquidityOrchestrator.address);

      // Second buy
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), buyAmount2);
      await adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), buyAmount2);

      const sharesAfterSecondBuy = await erc4626Vault.balanceOf(liquidityOrchestrator.address);

      // Verify shares increased
      expect(sharesAfterSecondBuy).to.be.greaterThan(sharesAfterFirstBuy);
    });

    it("Should handle multiple sell operations in sequence", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator, user1 } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const sellAmount1 = ethers.parseUnits("500", 6);
      const sellAmount2 = ethers.parseUnits("300", 6);

      // Give orchestrator shares
      await erc4626Vault.connect(user1).transfer(liquidityOrchestrator.address, sellAmount1 + sellAmount2);

      // First sell
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), sellAmount1);
      await adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), sellAmount1);

      const underlyingAfterFirstSell = await underlyingAsset.balanceOf(liquidityOrchestrator.address);

      // Second sell
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), sellAmount2);
      await adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), sellAmount2);

      const underlyingAfterSecondSell = await underlyingAsset.balanceOf(liquidityOrchestrator.address);

      // Verify underlying assets increased
      expect(underlyingAfterSecondSell).to.be.greaterThan(underlyingAfterFirstSell);
    });
  });

  describe("Error Handling", function () {
    it("Should revert if transfer fails during buy", async function () {
      const { adapter, underlyingAsset, liquidityOrchestrator } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const depositAmount = ethers.parseUnits("1000", 6);

      // Approve adapter to spend underlying assets
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), depositAmount);

      // Create a situation where transfer would fail by using a non-existent vault
      const fakeVault = ethers.ZeroAddress;

      await expect(adapter.connect(liquidityOrchestrator).buy(fakeVault, depositAmount)).to.be.reverted;
    });

    it("Should revert if transfer fails during sell", async function () {
      const { adapter, erc4626Vault, liquidityOrchestrator, user1 } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const shareAmount = ethers.parseUnits("500", 6);

      // Transfer vault shares to orchestrator and approve adapter
      await erc4626Vault.connect(user1).transfer(liquidityOrchestrator.address, shareAmount);
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), shareAmount);

      // Create a situation where transfer would fail by using a non-existent vault
      const fakeVault = ethers.ZeroAddress;

      await expect(adapter.connect(liquidityOrchestrator).sell(fakeVault, shareAmount)).to.be.reverted;
    });
  });

  describe("Edge Cases", function () {
    it("Should handle very small buy amounts", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const smallAmount = 1n; // 1 wei

      // Approve adapter to spend small amount
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), smallAmount);

      // Should not revert for small amounts
      await adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), smallAmount);
    });

    it("Should handle very small sell amounts", async function () {
      const { adapter, erc4626Vault, liquidityOrchestrator, user1 } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const smallAmount = 1n; // 1 wei

      // Transfer small amount to orchestrator and approve adapter
      await erc4626Vault.connect(user1).transfer(liquidityOrchestrator.address, smallAmount);
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), smallAmount);

      // Should not revert for small amounts
      await adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), smallAmount);
    });
  });

  describe("State Verification", function () {
    it("Should maintain zero balances in adapter after successful operations", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator, user1 } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      // Test buy operation
      const buyAmount = ethers.parseUnits("1000", 6);
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), buyAmount);
      await adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), buyAmount);

      // Verify adapter has zero balances
      expect(await underlyingAsset.balanceOf(await adapter.getAddress())).to.equal(0);
      expect(await erc4626Vault.balanceOf(await adapter.getAddress())).to.equal(0);

      // Test sell operation
      const sellAmount = ethers.parseUnits("500", 6);
      await erc4626Vault.connect(user1).transfer(liquidityOrchestrator.address, sellAmount);
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), sellAmount);
      await adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), sellAmount);

      // Verify adapter has zero balances
      expect(await underlyingAsset.balanceOf(await adapter.getAddress())).to.equal(0);
      expect(await erc4626Vault.balanceOf(await adapter.getAddress())).to.equal(0);
    });

    it("Should ensure orchestrator accumulates tokens correctly", async function () {
      const { adapter, underlyingAsset, erc4626Vault, liquidityOrchestrator, user1 } = await loadFixture(
        deployERC4626ExecutionAdapterFixture,
      );

      const initialOrchestratorUnderlying = await underlyingAsset.balanceOf(liquidityOrchestrator.address);
      const initialOrchestratorShares = await erc4626Vault.balanceOf(liquidityOrchestrator.address);

      // Execute buy
      const buyAmount = ethers.parseUnits("1000", 6);
      await underlyingAsset.connect(liquidityOrchestrator).approve(await adapter.getAddress(), buyAmount);
      await adapter.connect(liquidityOrchestrator).buy(await erc4626Vault.getAddress(), buyAmount);

      const afterBuyOrchestratorUnderlying = await underlyingAsset.balanceOf(liquidityOrchestrator.address);
      const afterBuyOrchestratorShares = await erc4626Vault.balanceOf(liquidityOrchestrator.address);

      // Verify orchestrator lost underlying but gained shares
      expect(afterBuyOrchestratorUnderlying).to.equal(initialOrchestratorUnderlying - buyAmount);
      expect(afterBuyOrchestratorShares).to.be.greaterThan(initialOrchestratorShares);

      // Execute sell
      const sellAmount = ethers.parseUnits("500", 6);
      await erc4626Vault.connect(user1).transfer(liquidityOrchestrator.address, sellAmount);
      await erc4626Vault.connect(liquidityOrchestrator).approve(await adapter.getAddress(), sellAmount);
      await adapter.connect(liquidityOrchestrator).sell(await erc4626Vault.getAddress(), sellAmount);

      const afterSellOrchestratorUnderlying = await underlyingAsset.balanceOf(liquidityOrchestrator.address);

      // Verify orchestrator gained underlying from sell
      expect(afterSellOrchestratorUnderlying).to.be.greaterThan(afterBuyOrchestratorUnderlying);
    });
  });
});
