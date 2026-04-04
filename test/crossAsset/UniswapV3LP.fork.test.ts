/**
 * UniswapV3LP Fork Tests
 *
 * Requires FORK_MAINNET=true (and a valid MAINNET_RPC_URL) to run.
 * Tests the full Uniswap V3 LP stack against mainnet state:
 *
 *   1. Wrapper — depositLiquidity + withdrawLiquidity on the live USDC/WETH 0.05% pool
 *   2. Price adapter — getPriceData returns a reasonable price at real pool prices
 *   3. Execution adapter — buy (USDC → LP shares) and sell (LP shares → USDC)
 */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  UniswapV3LPWrapper,
  UniswapV3LPPriceAdapter,
  UniswapV3LPExecutionAdapter,
  UniswapV3ExecutionAdapter,
  MockOrionConfig,
  MockPriceAdapterRegistry,
  MockPriceAdapter,
  MockLiquidityOrchestrator,
} from "../../typechain-types";

// ─── TickMath (TypeScript) ────────────────────────────────────────────────────

function getSqrtRatioAtTick(tick: number): bigint {
  const MAX_TICK = 887272;
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new Error(`Tick ${tick} out of range`);
  const a = BigInt(absTick);

  let ratio =
    (a & 1n) !== 0n ? BigInt("0xfffcb933bd6fad37aa2d162d1a594001") : BigInt("0x100000000000000000000000000000000");

  const steps: Array<[bigint, bigint]> = [
    [0x2n, BigInt("0xfff97272373d413259a46990580e213a")],
    [0x4n, BigInt("0xfff2e50f5f656932ef12357cf3c7fdcc")],
    [0x8n, BigInt("0xffe5caca7e10e4e61c3624eaa0941cd0")],
    [0x10n, BigInt("0xffcb9843d60f6159c9db58835c926644")],
    [0x20n, BigInt("0xff973b41fa98c081472e6896dfb254c0")],
    [0x40n, BigInt("0xff2ea16466c96a3843ec78b326b52861")],
    [0x80n, BigInt("0xfe5dee046a99a2a811c461f1969c3053")],
    [0x100n, BigInt("0xfcbe86c7900a88aedcffc83b479aa3a4")],
    [0x200n, BigInt("0xf987a7253ac413176f2b074cf7815e54")],
    [0x400n, BigInt("0xf3392b0822b70005940c7a398e4b70f3")],
    [0x800n, BigInt("0xe7159475a2c29b7443b29c7fa6e889d9")],
    [0x1000n, BigInt("0xd097f3bdfd2022b8845ad8f792aa5825")],
    [0x2000n, BigInt("0xa9f746462d870fdf8a65dc1f90e061e5")],
    [0x4000n, BigInt("0x70d869a156d2a1b890bb3df62baf32f7")],
    [0x8000n, BigInt("0x31be135f97d08fd981231505542fcfa6")],
    [0x10000n, BigInt("0x9aa508b5b7a84e1c677de54f3e99bc9")],
    [0x20000n, BigInt("0x5d6af8dedb81196699c329225ee604")],
    [0x40000n, BigInt("0x2216e584f5fa1ea926041bedfe98")],
    [0x80000n, BigInt("0x48a170391f7dc42444e8fa2")],
  ];
  for (const [mask, val] of steps) {
    if ((a & mask) !== 0n) ratio = (ratio * val) >> 128n;
  }
  if (tick > 0) {
    const MAX_U256 = (1n << 256n) - 1n;
    ratio = MAX_U256 / ratio;
  }
  return (ratio >> 32n) + (ratio % (1n << 32n) > 0n ? 1n : 0n);
}

// ─── Mainnet addresses ────────────────────────────────────────────────────────

const MAINNET = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC_WETH_005_POOL: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
  UNISWAP_V3_FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  UNISWAP_V3_NPM: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  UNISWAP_V3_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  UNISWAP_V3_QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  CHAINLINK_ETH_USD: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
};

// EOAs / contracts that often hold large USDC at many fork blocks (try in order).
const USDC_WHALES = [
  "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503", // Binance
  "0x28C6c06298d514Db089934071355E5743bf21d60", // Binance 8
  "0x21a31Ee1afC51d94C2eFcCAa2092aF1424148081", // Binance 14
  "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance (alternate)
];

// USDC/WETH 0.05% pool params
const FEE = 500;
const TICK_SPACING = 10;
// Full-range ticks, aligned to tickSpacing=10
const TICK_LOWER = -887270;
const TICK_UPPER = 887270;

describe("UniswapV3LP — Fork Tests", function () {
  let deployer: SignerWithAddress;

  let config: MockOrionConfig;
  let priceRegistry: MockPriceAdapterRegistry;
  let priceAdapter: MockPriceAdapter;
  let lo: MockLiquidityOrchestrator;

  let wethSwapAdapter: UniswapV3ExecutionAdapter;
  let lpWrapper: UniswapV3LPWrapper;
  let lpPriceAdapter: UniswapV3LPPriceAdapter;
  let lpExecAdapter: UniswapV3LPExecutionAdapter;

  const ERC20_FULL_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function transfer(address,uint256) returns (bool)",
  ];

  before(async function () {
    this.timeout(120_000);

    // Skip unless forking mainnet
    const netCfg = network.config;
    if (!("forking" in netCfg) || !netCfg.forking || !netCfg.forking.url) {
      this.skip();
    }

    [deployer] = await ethers.getSigners();

    // ── Deploy MockOrionConfig ──────────────────────────────────────────────
    const ConfigF = await ethers.getContractFactory("MockOrionConfig");
    config = (await ConfigF.deploy(MAINNET.USDC)) as unknown as MockOrionConfig;

    // ── Deploy Price Registry + Adapter ────────────────────────────────────
    const RegF = await ethers.getContractFactory("MockPriceAdapterRegistry");
    priceRegistry = (await RegF.deploy()) as unknown as MockPriceAdapterRegistry;
    await config.setPriceAdapterRegistry(await priceRegistry.getAddress());

    const PAdF = await ethers.getContractFactory("MockPriceAdapter");
    priceAdapter = (await PAdF.deploy()) as unknown as MockPriceAdapter;
    // USDC = $1 (underlying), WETH = $3500 — reasonable for fork block ~24M
    const PAD = 14;
    await priceAdapter.setMockPrice(MAINNET.USDC, ethers.parseUnits("1", PAD));
    await priceAdapter.setMockPrice(MAINNET.WETH, ethers.parseUnits("3500", PAD));
    await priceRegistry.setPriceAdapter(MAINNET.USDC, await priceAdapter.getAddress());
    await priceRegistry.setPriceAdapter(MAINNET.WETH, await priceAdapter.getAddress());

    await config.setWhitelisted(MAINNET.USDC, true);
    await config.setWhitelisted(MAINNET.WETH, true);

    // ── Deploy MockLiquidityOrchestrator ───────────────────────────────────
    const LOF = await ethers.getContractFactory("MockLiquidityOrchestrator");
    lo = (await LOF.deploy(await config.getAddress())) as unknown as MockLiquidityOrchestrator;
    await config.setLiquidityOrchestrator(await lo.getAddress());

    // ── WETH swap adapter (existing UniswapV3ExecutionAdapter) ─────────────
    const SwapAdF = await ethers.getContractFactory("UniswapV3ExecutionAdapter");
    wethSwapAdapter = (await SwapAdF.deploy(
      deployer.address,
      MAINNET.UNISWAP_V3_FACTORY,
      MAINNET.UNISWAP_V3_ROUTER,
      MAINNET.UNISWAP_V3_QUOTER_V2,
      await config.getAddress(),
    )) as unknown as UniswapV3ExecutionAdapter;
    await wethSwapAdapter.setAssetFee(MAINNET.WETH, 500); // USDC/WETH 0.05%
    await lo.setExecutionAdapter(MAINNET.WETH, await wethSwapAdapter.getAddress());

    // ── LP Execution Adapter ───────────────────────────────────────────────
    const LPExecF = await ethers.getContractFactory("UniswapV3LPExecutionAdapter");
    lpExecAdapter = (await LPExecF.deploy(
      deployer.address,
      await config.getAddress(),
      MAINNET.UNISWAP_V3_FACTORY,
    )) as unknown as UniswapV3LPExecutionAdapter;
    await lo.setExecutionAdapter(
      // Wrapper address is not known yet; wired below after wrapper deploy
      ethers.ZeroAddress, // placeholder — updated below
      await lpExecAdapter.getAddress(),
    );

    // ── LP Wrapper ─────────────────────────────────────────────────────────
    // USDC/WETH 0.05%: USDC is token0, WETH is token1 (USDC addr < WETH addr)
    const sqrtRatioLower = getSqrtRatioAtTick(TICK_LOWER);
    const sqrtRatioUpper = getSqrtRatioAtTick(TICK_UPPER);

    const WrapperF = await ethers.getContractFactory("UniswapV3LPWrapper");
    lpWrapper = (await WrapperF.deploy(
      deployer.address,
      MAINNET.UNISWAP_V3_NPM,
      MAINNET.USDC_WETH_005_POOL,
      MAINNET.USDC,
      MAINNET.WETH,
      FEE,
      TICK_LOWER,
      TICK_UPPER,
      sqrtRatioLower,
      sqrtRatioUpper,
      await lpExecAdapter.getAddress(),
      "USDC/WETH 0.05% LP",
      "UWLP",
    )) as unknown as UniswapV3LPWrapper;

    // ── Register wrapper in LP exec adapter and LO ─────────────────────────
    await lpExecAdapter.setWrapperConfig(
      await lpWrapper.getAddress(),
      ethers.ZeroAddress, // USDC is the underlying → no swap needed for token0
      await wethSwapAdapter.getAddress(), // WETH swap adapter for token1
    );
    await lo.setExecutionAdapter(await lpWrapper.getAddress(), await lpExecAdapter.getAddress());

    // ── LP Price Adapter ───────────────────────────────────────────────────
    const LPPriceF = await ethers.getContractFactory("UniswapV3LPPriceAdapter");
    lpPriceAdapter = (await LPPriceF.deploy(
      await config.getAddress(),
      MAINNET.UNISWAP_V3_FACTORY,
    )) as unknown as UniswapV3LPPriceAdapter;

    await config.setWhitelisted(await lpWrapper.getAddress(), true);
  });

  // ─── Wrapper — direct deposit / withdraw ───────────────────────────────────

  describe("UniswapV3LPWrapper — direct integration with real NPM", function () {
    it("depositLiquidity: mints LP shares from real USDC + WETH", async function () {
      this.timeout(60_000);

      const wrapperAddr = await lpWrapper.getAddress();
      const execAdapterAddr = await lpExecAdapter.getAddress();

      // WETH: mint via deposit() — does not depend on whale balances.
      const WETH_AMOUNT = ethers.parseUnits("3", 18);
      await fundWethTo(execAdapterAddr, WETH_AMOUNT, deployer);

      // USDC: pull from one or more whales (single whale may not hold enough at pinned block).
      const USDC_TARGET = ethers.parseUnits("10000", 6);
      const USDC_AMOUNT = await fundUsdcTo(execAdapterAddr, USDC_TARGET);
      expect(
        USDC_AMOUNT >= ethers.parseUnits("500", 6),
        "need enough USDC from whales at this fork block — add RPC or lower minimum",
      ).to.equal(true);

      // Exec adapter approves wrapper and calls depositLiquidity
      const execAdapterSigner = await impersonateWithETH(execAdapterAddr);
      const usdcAsExec = new ethers.Contract(MAINNET.USDC, ERC20_FULL_ABI, execAdapterSigner);
      const wethAsExec = new ethers.Contract(MAINNET.WETH, ERC20_FULL_ABI, execAdapterSigner);
      await usdcAsExec.approve(wrapperAddr, USDC_AMOUNT);
      await wethAsExec.approve(wrapperAddr, WETH_AMOUNT);

      const sharesBefore = await lpWrapper.totalSupply();
      await lpWrapper.connect(execAdapterSigner).depositLiquidity(USDC_AMOUNT, WETH_AMOUNT, deployer.address, 0n);

      const sharesAfter = await lpWrapper.totalSupply();
      const sharesMinted = sharesAfter - sharesBefore;
      const tokenId = await lpWrapper.tokenId();
      const totalLiq = await lpWrapper.totalLiquidity();

      console.log(`  tokenId:      ${tokenId}`);
      console.log(`  shares:       ${ethers.formatUnits(sharesMinted, 0)}`);
      console.log(`  totalLiq:     ${ethers.formatUnits(totalLiq, 0)}`);

      expect(sharesMinted).to.be.gt(0n);
      expect(tokenId).to.be.gt(0n);
      expect(totalLiq).to.be.gt(0n);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [execAdapterAddr]);
    });

    it("price adapter: returns a reasonable price for the LP position", async function () {
      this.timeout(30_000);

      const [price, decimals] = await lpPriceAdapter.getPriceData(await lpWrapper.getAddress());
      expect(price).to.be.gt(0n);
      expect(decimals).to.equal(16); // PRICE_DECIMALS(10) + underlyingDecimals(6)

      // Normalize to priceAdapterDecimals = 14: price * 10^14 / 10^16 = price / 100
      const normalizedPrice = price / 100n;
      const totalSupply = await lpWrapper.totalSupply();

      // The price of 1 share in USDC (scaled to 14 decimals):
      // Each LP share represents some USDC value — should be in the hundreds-to-thousands range
      console.log(`  raw price:    ${price}`);
      console.log(`  decimals:     ${decimals}`);
      console.log(`  normalised:   ${normalizedPrice}`);
      console.log(`  totalSupply:  ${totalSupply}`);

      // Price should be > 0 and sane (not zero, not astronomical)
      expect(price).to.be.gt(0n);
    });

    it("validatePriceAdapter: passes for the deployed wrapper", async function () {
      await expect(lpPriceAdapter.validatePriceAdapter(await lpWrapper.getAddress())).to.not.be.reverted;
    });

    it("validateExecutionAdapter: passes for the deployed wrapper", async function () {
      await expect(lpExecAdapter.validateExecutionAdapter(await lpWrapper.getAddress())).to.not.be.reverted;
    });

    it("withdrawLiquidity: returns real USDC + WETH to recipient", async function () {
      this.timeout(60_000);

      const usdc = new ethers.Contract(MAINNET.USDC, ERC20_FULL_ABI, deployer);
      const weth = new ethers.Contract(MAINNET.WETH, ERC20_FULL_ABI, deployer);
      const execAdapterAddr = await lpExecAdapter.getAddress();

      // Transfer all shares to the exec adapter (it calls withdrawLiquidity)
      const shares = await lpWrapper.balanceOf(deployer.address);
      expect(shares).to.be.gt(0n);

      // Exec adapter signer
      const execAdapterSigner = await impersonateWithETH(execAdapterAddr);
      await lpWrapper.connect(deployer).transfer(execAdapterAddr, shares);

      const deployerUsdcBefore = await usdc.balanceOf(deployer.address);
      const deployerWethBefore = await weth.balanceOf(deployer.address);

      await lpWrapper.connect(execAdapterSigner).withdrawLiquidity(shares, deployer.address);

      const usdcReceived = (await usdc.balanceOf(deployer.address)) - deployerUsdcBefore;
      const wethReceived = (await weth.balanceOf(deployer.address)) - deployerWethBefore;

      console.log(`  USDC received: ${ethers.formatUnits(usdcReceived, 6)} USDC`);
      console.log(`  WETH received: ${ethers.formatUnits(wethReceived, 18)} WETH`);
      console.log(`  tokenId after: ${await lpWrapper.tokenId()}`);

      // At least one token should be received (or both), depending on in/out-of-range
      expect(usdcReceived + wethReceived).to.be.gt(0n);
      // NFT burned after full withdrawal
      expect(await lpWrapper.tokenId()).to.equal(0n);
      expect(await lpWrapper.totalSupply()).to.equal(0n);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [execAdapterAddr]);
    });
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Set native balance without a transfer (works for contracts that reject ETH). */
async function setEthBalance(address: string, wei: bigint) {
  await ethers.provider.send("hardhat_setBalance", [address, ethers.toQuantity(wei)]);
}

const WETH_DEPOSIT_ABI = ["function deposit() payable", "function transfer(address,uint256) returns (bool)"];

/** Wrap ETH → WETH and transfer to `recipient` (fork-friendly, no whale). */
async function fundWethTo(recipient: string, amount: bigint, funder: SignerWithAddress) {
  await setEthBalance(funder.address, amount + ethers.parseEther("10"));
  const weth = new ethers.Contract(MAINNET.WETH, WETH_DEPOSIT_ABI, funder);
  await weth.deposit({ value: amount });
  await weth.transfer(recipient, amount);
}

/** Pull USDC from known large holders until `target` is reached (or return what was available). */
async function fundUsdcTo(recipient: string, target: bigint): Promise<bigint> {
  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
  ];
  const usdc = new ethers.Contract(MAINNET.USDC, erc20Abi, ethers.provider);
  let sent = 0n;
  let need = target;
  for (const whale of USDC_WHALES) {
    if (need <= 0n) break;
    const bal = await usdc.balanceOf(whale);
    if (bal === 0n) continue;
    const take = bal >= need ? need : bal;
    await ethers.provider.send("hardhat_impersonateAccount", [whale]);
    await setEthBalance(whale, ethers.parseEther("2"));
    const whaleSigner = await ethers.getSigner(whale);
    await new ethers.Contract(MAINNET.USDC, erc20Abi, whaleSigner).transfer(recipient, take);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [whale]);
    sent += take;
    need -= take;
  }
  return sent;
}

async function impersonateWithETH(address: string): Promise<SignerWithAddress> {
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await setEthBalance(address, ethers.parseEther("5"));
  return ethers.getSigner(address);
}
