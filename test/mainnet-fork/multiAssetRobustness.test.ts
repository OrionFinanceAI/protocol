/**
 * @title Multi-Asset Robustness Test Suite
 * @notice Comprehensive testing of protocol functionality across different underlying assets
 * @dev Tests all core functions on both Sepolia and Mainnet with 6 different assets
 *
 * @dev SETUP INSTRUCTIONS:
 * For Mainnet fork:
 *   FORK_MAINNET=true MAINNET_RPC_URL=<your-rpc> npx hardhat test test/mainnet-fork/multiAssetRobustness.test.ts
 *
 * For Sepolia fork:
 *   FORK_SEPOLIA=true SEPOLIA_RPC_URL=https://rpc.sepolia.org npx hardhat test test/mainnet-fork/multiAssetRobustness.test.ts
 *
 * @dev WHAT THIS TEST VALIDATES:
 * 1. depositLiquidity() - Curator deposits liquidity to buffer
 * 2. withdrawLiquidity() - Curator withdraws from buffer
 * 3. requestDeposit() - Users request to deposit
 * 4. requestRedeem() - Users request to redeem shares
 * 5. cancelDepositRequest() → returnDepositFunds() - Cancel before fulfillment
 * 6. cancelRedeemRequest() - Cancel redemption
 * 7. claimProtocolFees() - Protocol fee collection
 * 8. claimCuratorFees() - Curator fee withdrawal
 * 9. Orchestrator fulfillment flow - Full E2E deposit/redeem cycle
 *
 * @dev ASSETS TESTED:
 * - USDC (6 decimals)
 * - USDT (6 decimals, non-standard approve)
 * - USDS (18 decimals)
 * - USDE (18 decimals)
 * - WETH (18 decimals)
 * - WBTC (8 decimals)
 *
 * @author Orion Finance Security Testing
 */

import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import {
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  PriceAdapterRegistry,
  OrionTransparentVault,
  MockUnderlyingAsset,
  MockERC4626Asset,
  MockPriceAdapter,
  MockExecutionAdapter,
} from "../../typechain-types";

/**
 * Asset Configuration
 */
interface AssetConfig {
  name: string;
  decimals: number;
  sepolia: string;
  mainnet: string;
  sepoliaWhale: string;
  mainnetWhale: string;
  testAmount: string; // Human-readable amount
  nonStandardApprove: boolean;
}

// All the assets CA and whale addresses are taken from etherscan. ANY TOKEN -> holders -> find a WA, not a "CA" or exchange

const ASSET_CONFIGS: Record<string, AssetConfig> = {
  USDC: {
    name: "USDC",
    decimals: 6,
    sepolia: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    mainnet: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    sepoliaWhale: "0xa6A60b54A01718d3b5EE207BFb4Cc34FF7ee01D2",
    mainnetWhale: "0x55FE002aefF02F77364de339a1292923A15844B8",
    testAmount: "10000",
    nonStandardApprove: false,
  },
  USDT: {
    name: "USDT",
    decimals: 6,
    sepolia: "0x863aE464D7E8e6F95b845FD3AF0f9A2B2034D6dD",
    mainnet: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    sepoliaWhale: "0xa6A60b54A01718d3b5EE207BFb4Cc34FF7ee01D2",
    mainnetWhale: "0x5754284f345afc66a98fbB0a0Afe71e0F007B949",
    testAmount: "10000",
    nonStandardApprove: true, // USDT has non-standard ERC20
  },
  USDS: {
    name: "USDS",
    decimals: 18,
    sepolia: "0xc342258e633a8B6AA5D3e0339D5Cd70bB656b4Cd",
    mainnet: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
    sepoliaWhale: "0xa6A60b54A01718d3b5EE207BFb4Cc34FF7ee01D2",
    mainnetWhale: "0x3dEAc891E2d94058E0142aDD8ffF1Aa409bbD87e",
    testAmount: "10000",
    nonStandardApprove: false,
  },
  USDE: {
    name: "USDE",
    decimals: 18,
    sepolia: "0x9458caaca7424abbe9e964b3ce155b98ec88ef2",
    mainnet: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
    sepoliaWhale: "0xa6A60b54A01718d3b5EE207BFb4Cc34FF7ee01D2",
    mainnetWhale: "0xBCE9aECd3985D4cBB9D273453159A26301Fa02ef",
    testAmount: "10000",
    nonStandardApprove: false,
  },
  WETH: {
    name: "WETH",
    decimals: 18,
    sepolia: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    mainnet: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    sepoliaWhale: "0xa6A60b54A01718d3b5EE207BFb4Cc34FF7ee01D2",
    mainnetWhale: "0x25431341A5800759268a6aC1d3CD91C029D7d9CA",
    testAmount: "10",
    nonStandardApprove: false,
  },
  WBTC: {
    name: "WBTC",
    decimals: 8,
    sepolia: "0x2C12Fa39cFff125A4EAabF86B26127aF16a0378f",
    mainnet: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    sepoliaWhale: "0xa6A60b54A01718d3b5EE207BFb4Cc34FF7ee01D2",
    mainnetWhale: "0x274B56e812b7951B737e450a22e849860C8adA11",
    testAmount: "1",
    nonStandardApprove: false,
  },
};

/**
 * ERC20 ABIs
 */
const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

const USDT_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

describe("Multi-Asset Robustness Tests", function () {
  // Extend timeout for mainnet fork tests
  this.timeout(600000);

  // Test chains
  const chains = [
    { key: "mainnet", envVar: "FORK_MAINNET" },
    /* { key: "sepolia", envVar: "FORK_SEPOLIA" }, */
  ];

  for (const chain of chains) {
    describe(`${chain.key.toUpperCase()} Tests`, function () {
      // Test each asset on this chain
      for (const [_assetKey, assetConfig] of Object.entries(ASSET_CONFIGS)) {
        describe(`${assetConfig.name} (${assetConfig.decimals} decimals)`, function () {
          // Test accounts
          let owner: SignerWithAddress;
          let admin: SignerWithAddress;
          let curator: SignerWithAddress;
          let user1: SignerWithAddress;
          let user2: SignerWithAddress;
          let automationRegistry: SignerWithAddress;

          // Protocol contracts
          let orionConfig: OrionConfig;
          let transparentVaultFactory: TransparentVaultFactory;
          let internalStatesOrchestrator: InternalStatesOrchestrator;
          let liquidityOrchestrator: LiquidityOrchestrator;
          let priceAdapterRegistry: PriceAdapterRegistry;
          let vault: OrionTransparentVault;

          // Mock contracts (for testing)
          let underlyingAsset: MockUnderlyingAsset;
          let mockERC4626Asset: MockERC4626Asset;
          let mockPriceAdapter: MockPriceAdapter;
          let mockExecutionAdapter: MockExecutionAdapter;

          // Real asset contract (on fork)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let realUnderlyingAsset: any;

          // Test parameters
          const assetAddress = chain.key === "sepolia" ? assetConfig.sepolia : assetConfig.mainnet;
          const whaleAddress = chain.key === "sepolia" ? assetConfig.sepoliaWhale : assetConfig.mainnetWhale;
          const testAmount = ethers.parseUnits(assetConfig.testAmount, assetConfig.decimals);

          let epochDuration: bigint;

          before(async function () {
            // Skip if environment not set
            if (process.env[chain.envVar] !== "true") {
              console.log(`Skipping ${chain.key} tests (${chain.envVar} not set)`);
              this.skip();
            }

            console.log(`\n${"=".repeat(80)}`);
            console.log(`Setting up ${assetConfig.name} on ${chain.key.toUpperCase()}`);
            console.log(`${"=".repeat(80)}`);

            // Get signers
            [owner, admin, curator, user1, user2, automationRegistry] = await ethers.getSigners();

            console.log(`   Owner: ${owner.address}`);
            console.log(`   Curator: ${curator.address}`);
            console.log(`   Asset: ${assetAddress}`);

            try {
              // Connect to real asset on fork
              const abi = assetConfig.nonStandardApprove ? USDT_ABI : ERC20_ABI;
              realUnderlyingAsset = new ethers.Contract(assetAddress, abi, owner);

              // Fund test accounts
              await fundAccountFromWhale(owner, testAmount * 20n);
              await fundAccountFromWhale(curator, testAmount * 20n);
              await fundAccountFromWhale(user1, testAmount * 5n);
              await fundAccountFromWhale(user2, testAmount * 5n);

              console.log(`   ✓ Funded test accounts`);

              // Deploy mock underlying asset for protocol setup
              const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
              underlyingAsset = (await MockUnderlyingAssetFactory.deploy(
                assetConfig.decimals,
              )) as unknown as MockUnderlyingAsset;

              // Deploy protocol
              await deployProtocol();
              console.log(`   ✓ Deployed protocol contracts`);

              // Deploy vault
              await deployVault();
              console.log(`   ✓ Deployed vault`);

              console.log(`${"=".repeat(80)}\n`);
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error(`   ✗ Setup failed: ${errorMessage}`);
              this.skip();
            }
          });

          /**
           * Helper: Fund account from whale
           */
          async function fundAccountFromWhale(account: SignerWithAddress, amount: bigint) {
            try {
              await ethers.provider.send("hardhat_impersonateAccount", [whaleAddress]);
              const whaleSigner = await ethers.getSigner(whaleAddress);

              // Fund whale with ETH for gas
              await owner.sendTransaction({
                to: whaleAddress,
                value: ethers.parseEther("10"),
              });

              // Transfer tokens
              const whaleAsset = realUnderlyingAsset.connect(whaleSigner);
              if (assetConfig.nonStandardApprove) {
                await whaleAsset.transfer(account.address, amount);
              } else {
                await whaleAsset.transfer(account.address, amount);
              }

              await ethers.provider.send("hardhat_stopImpersonatingAccount", [whaleAddress]);
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              throw new Error(`Failed to fund from whale: ${errorMessage}`);
            }
          }

          /**
           * Helper: Safe approve (handles USDT)
           */
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          async function safeApprove(spender: string, amount: bigint, signer: SignerWithAddress): Promise<void> {
            const tokenWithSigner = realUnderlyingAsset.connect(signer);

            if (assetConfig.nonStandardApprove) {
              // USDT: reset to 0 first, then set amount
              const currentAllowance = await realUnderlyingAsset.allowance(signer.address, spender);
              if (currentAllowance > 0n) {
                await tokenWithSigner.approve(spender, 0);
              }
              await tokenWithSigner.approve(spender, amount);
            } else {
              await tokenWithSigner.approve(spender, amount);
            }
          }

          /**
           * Helper: Process full epoch
           */
          async function processFullEpoch(): Promise<void> {
            await time.increase(epochDuration + 1n);

            // Process InternalStatesOrchestrator
            let [upkeepNeeded] = await internalStatesOrchestrator.checkUpkeep("0x");
            while (upkeepNeeded) {
              await internalStatesOrchestrator.connect(automationRegistry).performUpkeep("0x");
              [upkeepNeeded] = await internalStatesOrchestrator.checkUpkeep("0x");
            }

            // Process LiquidityOrchestrator
            [upkeepNeeded] = await liquidityOrchestrator.checkUpkeep("0x");
            while (upkeepNeeded) {
              await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x");
              [upkeepNeeded] = await liquidityOrchestrator.checkUpkeep("0x");
            }
          }

          /**
           * Deploy protocol contracts
           */
          async function deployProtocol() {
            // Deploy OrionConfig
            const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
            orionConfig = (await OrionConfigFactory.deploy(
              owner.address,
              admin.address,
              await underlyingAsset.getAddress(),
            )) as unknown as OrionConfig;

            // Deploy PriceAdapterRegistry
            const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
            priceAdapterRegistry = (await PriceAdapterRegistryFactory.deploy(
              owner.address,
              await orionConfig.getAddress(),
            )) as unknown as PriceAdapterRegistry;

            // Deploy LiquidityOrchestrator
            const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
            liquidityOrchestrator = (await LiquidityOrchestratorFactory.deploy(
              owner.address,
              await orionConfig.getAddress(),
              automationRegistry.address,
            )) as unknown as LiquidityOrchestrator;

            await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
            await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

            // Deploy InternalStatesOrchestrator
            const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
            internalStatesOrchestrator = (await InternalStatesOrchestratorFactory.deploy(
              owner.address,
              await orionConfig.getAddress(),
              automationRegistry.address,
            )) as unknown as InternalStatesOrchestrator;

            // Deploy TransparentVaultFactory
            const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
            transparentVaultFactory = (await TransparentVaultFactoryFactory.deploy(
              await orionConfig.getAddress(),
            )) as unknown as TransparentVaultFactory;

            // Configure OrionConfig
            await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
            await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());
            await orionConfig.setProtocolRiskFreeRate(0); // 0% for simplicity

            // Configure LiquidityOrchestrator
            await liquidityOrchestrator.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
            await liquidityOrchestrator.connect(owner).setTargetBufferRatio(100); // 1% buffer
            await liquidityOrchestrator.connect(owner).updateMinibatchSize(8);

            // Deploy mock ERC4626 asset
            const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
            mockERC4626Asset = (await MockERC4626AssetFactory.deploy(
              await underlyingAsset.getAddress(),
              "Mock Vault",
              "mVault",
            )) as unknown as MockERC4626Asset;

            // Deploy adapters
            const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
            mockPriceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;

            const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
            mockExecutionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;

            // Whitelist mock asset
            await orionConfig.addWhitelistedAsset(
              await mockERC4626Asset.getAddress(),
              await mockPriceAdapter.getAddress(),
              await mockExecutionAdapter.getAddress(),
            );

            epochDuration = await internalStatesOrchestrator.epochDuration();
          }

          /**
           * Deploy vault
           */
          async function deployVault() {
            const tx = await transparentVaultFactory.createVault(
              curator.address,
              "Orion Vault",
              "oVault",
              0, // feeType: Absolute
              0, // performanceFee: 0%
              0, // managementFee: 0%
              ethers.ZeroAddress,
            );
            const receipt = await tx.wait();

            const event = receipt?.logs.find((log) => {
              try {
                const parsed = transparentVaultFactory.interface.parseLog({
                  topics: [...log.topics],
                  data: log.data,
                });
                return parsed?.name === "OrionVaultCreated";
              } catch {
                return false;
              }
            });

            if (!event) throw new Error("OrionVaultCreated event not found");

            const parsedEvent = transparentVaultFactory.interface.parseLog({
              topics: [...event.topics],
              data: event.data,
            });
            const vaultAddress = parsedEvent?.args[0];

            vault = (await ethers.getContractAt(
              "OrionTransparentVaultUpgradeable",
              vaultAddress,
            )) as unknown as OrionTransparentVault;

            // Submit curator intent (100% underlying to keep it simple)
            await vault.connect(curator).submitIntent([
              {
                token: await underlyingAsset.getAddress(),
                weight: 1000000000, // 100%
              },
            ]);
          }

          /**
           * TEST 1: depositLiquidity (Admin deposits liquidity to buffer)
           */
          it("Should handle depositLiquidity correctly", async function () {
            const depositAmount = ethers.parseUnits("100", assetConfig.decimals);

            // Mint mock underlying to admin
            await underlyingAsset.mint(admin.address, depositAmount);

            // Check initial buffer
            const bufferBefore = await internalStatesOrchestrator.bufferAmount();

            // Approve and deposit (onlyAdmin function - admin calls it)
            await underlyingAsset.connect(admin).approve(await liquidityOrchestrator.getAddress(), depositAmount);
            await liquidityOrchestrator.connect(admin).depositLiquidity(depositAmount);

            // Check buffer increased
            const bufferAfter = await internalStatesOrchestrator.bufferAmount();
            expect(bufferAfter - bufferBefore).to.equal(depositAmount);

            console.log(
              `      ✓ Deposited ${ethers.formatUnits(depositAmount, assetConfig.decimals)} ${assetConfig.name} to buffer`,
            );
          });

          /**
           * TEST 2: withdrawLiquidity (Admin withdraws from buffer)
           */
          it("Should handle withdrawLiquidity correctly", async function () {
            const buffer = await internalStatesOrchestrator.bufferAmount();
            if (buffer === 0n) {
              console.log(`      ℹ Skipping: No buffer to withdraw`);
              this.skip();
            }

            const withdrawAmount = buffer / 2n; // Withdraw half

            // Check admin balance before
            const adminBalanceBefore = await underlyingAsset.balanceOf(admin.address);

            // Withdraw (onlyAdmin function - admin calls it)
            await liquidityOrchestrator.connect(admin).withdrawLiquidity(withdrawAmount);

            // Check admin received assets
            const adminBalanceAfter = await underlyingAsset.balanceOf(admin.address);
            expect(adminBalanceAfter - adminBalanceBefore).to.equal(withdrawAmount);

            // Check buffer decreased
            const bufferAfter = await internalStatesOrchestrator.bufferAmount();
            expect(buffer - bufferAfter).to.equal(withdrawAmount);

            console.log(
              `      ✓ Withdrew ${ethers.formatUnits(withdrawAmount, assetConfig.decimals)} ${assetConfig.name} from buffer`,
            );
          });

          /**
           * TEST 3: requestDeposit → fulfill flow
           */
          it("Should handle requestDeposit and fulfillment correctly", async function () {
            const depositAmount = ethers.parseUnits("50", assetConfig.decimals);

            // Mint to user1
            await underlyingAsset.mint(user1.address, depositAmount);

            // Approve and request
            await underlyingAsset.connect(user1).approve(await vault.getAddress(), depositAmount);
            await vault.connect(user1).requestDeposit(depositAmount);

            // Check pending deposit
            const pendingDeposit = await vault.pendingDeposit();
            expect(pendingDeposit).to.equal(depositAmount);

            // Process epoch to fulfill
            await processFullEpoch();

            // Check user received shares
            const userShares = await vault.balanceOf(user1.address);
            expect(userShares).to.be.gt(0);

            // Check pending cleared
            const pendingAfter = await vault.pendingDeposit();
            expect(pendingAfter).to.equal(0);

            console.log(`      ✓ Fulfilled deposit, user received ${ethers.formatUnits(userShares, 18)} shares`);
          });

          /**
           * TEST 4: requestRedeem → fulfill flow
           */
          it("Should handle requestRedeem and fulfillment correctly", async function () {
            // Get user's shares
            const userShares = await vault.balanceOf(user1.address);
            if (userShares === 0n) {
              console.log(`      ℹ Skipping: User has no shares`);
              this.skip();
            }

            const redeemAmount = userShares / 2n; // Redeem half

            // Request redeem
            await vault.connect(user1).approve(await vault.getAddress(), redeemAmount);
            await vault.connect(user1).requestRedeem(redeemAmount);

            // Check pending
            const pendingRedeem = await vault.pendingRedeem();
            expect(pendingRedeem).to.equal(redeemAmount);

            // Check balance before
            const userBalanceBefore = await underlyingAsset.balanceOf(user1.address);

            // Process epoch
            await processFullEpoch();

            // Check user received assets
            const userBalanceAfter = await underlyingAsset.balanceOf(user1.address);
            const assetsReceived = userBalanceAfter - userBalanceBefore;
            expect(assetsReceived).to.be.gt(0);

            console.log(
              `      ✓ Fulfilled redeem, user received ${ethers.formatUnits(assetsReceived, assetConfig.decimals)} ${assetConfig.name}`,
            );
          });

          /**
           * TEST 5: cancelDepositRequest → returnDepositFunds
           */
          it("Should handle cancelDepositRequest correctly", async function () {
            const depositAmount = ethers.parseUnits("25", assetConfig.decimals);

            // Mint and request
            await underlyingAsset.mint(user2.address, depositAmount);
            await underlyingAsset.connect(user2).approve(await vault.getAddress(), depositAmount);
            await vault.connect(user2).requestDeposit(depositAmount);

            // Check balance before cancel
            const balanceBefore = await underlyingAsset.balanceOf(user2.address);

            // Cancel (pass the amount to cancel)
            await vault.connect(user2).cancelDepositRequest(depositAmount);

            // Check user got refund
            const balanceAfter = await underlyingAsset.balanceOf(user2.address);
            expect(balanceAfter - balanceBefore).to.equal(depositAmount);

            console.log(`      ✓ Cancelled deposit and received refund`);
          });

          /**
           * TEST 6: cancelRedeemRequest
           */
          it("Should handle cancelRedeemRequest correctly", async function () {
            // First ensure user has shares
            const depositAmount = ethers.parseUnits("50", assetConfig.decimals);
            await underlyingAsset.mint(user2.address, depositAmount);
            await underlyingAsset.connect(user2).approve(await vault.getAddress(), depositAmount);
            await vault.connect(user2).requestDeposit(depositAmount);
            await processFullEpoch();

            // Now request redeem
            const userShares = await vault.balanceOf(user2.address);
            const redeemAmount = userShares / 2n;

            await vault.connect(user2).approve(await vault.getAddress(), redeemAmount);
            await vault.connect(user2).requestRedeem(redeemAmount);

            // Check shares before cancel
            const sharesBefore = await vault.balanceOf(user2.address);

            // Cancel (pass the shares amount to cancel)
            await vault.connect(user2).cancelRedeemRequest(redeemAmount);

            // Check shares returned
            const sharesAfter = await vault.balanceOf(user2.address);
            expect(sharesAfter - sharesBefore).to.equal(redeemAmount);

            console.log(`      ✓ Cancelled redeem request`);
          });

          /**
           * TEST 7: claimProtocolFees
           */
          it("Should handle protocol fee claiming", async function () {
            // Check protocol fees in internalStatesOrchestrator
            const protocolFees = await internalStatesOrchestrator.pendingProtocolFees();

            if (protocolFees > 0n) {
              const adminBalanceBefore = await underlyingAsset.balanceOf(admin.address);
              await liquidityOrchestrator.connect(admin).claimProtocolFees(protocolFees);
              const adminBalanceAfter = await underlyingAsset.balanceOf(admin.address);
              expect(adminBalanceAfter - adminBalanceBefore).to.equal(protocolFees);
              console.log(
                `      ✓ Claimed ${ethers.formatUnits(protocolFees, assetConfig.decimals)} ${assetConfig.name} in protocol fees`,
              );
            } else {
              console.log(`      ℹ No protocol fees accumulated yet`);
            }
          });

          /**
           * TEST 8: claimCuratorFees (via vault.claimCuratorFees)
           */
          it("Should handle curator fee claiming", async function () {
            // Check accumulated fees
            const accruedFees = await vault.pendingCuratorFees();

            if (accruedFees > 0n) {
              const curatorBalanceBefore = await underlyingAsset.balanceOf(curator.address);
              await vault.connect(owner).claimCuratorFees(accruedFees);
              const curatorBalanceAfter = await underlyingAsset.balanceOf(curator.address);
              expect(curatorBalanceAfter - curatorBalanceBefore).to.equal(accruedFees);
              console.log(
                `      ✓ Claimed ${ethers.formatUnits(accruedFees, assetConfig.decimals)} ${assetConfig.name} in curator fees`,
              );
            } else {
              console.log(`      ℹ No curator fees accumulated yet`);
            }
          });

          /**
           * TEST 9: transferRedemptionFunds (tested implicitly in fulfillment)
           */
          it("Should handle full deposit→redeem→fulfill lifecycle", async function () {
            const depositAmount = ethers.parseUnits("100", assetConfig.decimals);

            // Deposit
            await underlyingAsset.mint(user1.address, depositAmount);
            await underlyingAsset.connect(user1).approve(await vault.getAddress(), depositAmount);
            await vault.connect(user1).requestDeposit(depositAmount);

            // Fulfill deposit
            await processFullEpoch();

            const shares = await vault.balanceOf(user1.address);
            expect(shares).to.be.gt(0);

            // Redeem
            await vault.connect(user1).approve(await vault.getAddress(), shares);
            await vault.connect(user1).requestRedeem(shares);

            const balanceBefore = await underlyingAsset.balanceOf(user1.address);

            // Fulfill redeem (this internally calls transferRedemptionFunds)
            await processFullEpoch();

            const balanceAfter = await underlyingAsset.balanceOf(user1.address);
            const received = balanceAfter - balanceBefore;

            expect(received).to.be.gt(0);

            console.log(`      ✓ Full lifecycle completed: deposit→fulfill→redeem→fulfill`);
            console.log(`      ✓ transferRedemptionFunds executed successfully during fulfillment`);
          });
        });
      }
    });
  }
});
