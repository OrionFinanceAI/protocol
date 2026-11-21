// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IOrionConfig } from "../../interfaces/IOrionConfig.sol";
import { IOrionVault } from "../../interfaces/IOrionVault.sol";
import { ILiquidityOrchestrator } from "../../interfaces/ILiquidityOrchestrator.sol";

/// @notice Receiver invoked by CallbackERC20 on transfer / transferFrom (caught so outer tx can continue).
interface ICallbackReceiver {
    function onTokenCallback(address from, address to, uint256 amount) external;
}

/**
 * @title CallbackERC20
 * @notice Mintable ERC20 that notifies coded `from`/`to` after each transfer (test-only hook token).
 */
contract CallbackERC20 is ERC20 {
    enum CallbackMode {
        Both,
        FromOnly,
        ToOnly
    }

    uint8 private immutable _decimals;
    bool public callbacksEnabled = true;
    CallbackMode public callbackMode = CallbackMode.Both;

    constructor(uint8 decimals_) ERC20("Callback USD", "cUSD") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setCallbacksEnabled(bool enabled) external {
        callbacksEnabled = enabled;
    }

    function setCallbackMode(CallbackMode mode) external {
        callbackMode = mode;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!callbacksEnabled || value == 0 || from == address(0) || to == address(0)) {
            return;
        }
        if (callbackMode != CallbackMode.ToOnly) {
            _tryCallback(from, from, to, value);
        }
        if (callbackMode != CallbackMode.FromOnly && to != from) {
            _tryCallback(to, from, to, value);
        }
    }

    function _tryCallback(address target, address from, address to, uint256 value) private {
        if (target.code.length == 0) return;
        // slither-disable-next-line unchecked-lowlevel
        try ICallbackReceiver(target).onTokenCallback(from, to, value) {} catch {}
    }
}

interface IDepositLiquidityTarget {
    function depositLiquidity(uint256 amount) external;
    function bufferAmount() external view returns (uint256);
}

/**
 * @title NestedDepositAttacker
 * @notice On token pull, reenters `depositLiquidity` and records whether the nested call succeeded.
 */
contract NestedDepositAttacker is ICallbackReceiver {
    IDepositLiquidityTarget public immutable orchestrator;
    uint256 public nestedAmount;
    bool public nestedSucceeded;
    uint256 public bufferSeenDuringCallback;
    bool private _inCallback;

    constructor(IDepositLiquidityTarget orchestrator_) {
        orchestrator = orchestrator_;
    }

    function setNestedAmount(uint256 amount) external {
        nestedAmount = amount;
    }

    function deposit(uint256 amount) external {
        orchestrator.depositLiquidity(amount);
    }

    function onTokenCallback(address, address, uint256) external override {
        if (_inCallback || nestedAmount == 0) return;
        _inCallback = true;
        bufferSeenDuringCallback = orchestrator.bufferAmount();
        try orchestrator.depositLiquidity(nestedAmount) {
            nestedSucceeded = true;
        } catch {
            nestedSucceeded = false;
        }
        _inCallback = false;
    }
}

/**
 * @title UnguardedDepositLiquidityOrchestrator
 * @notice Legacy twin: transfer-then-buffer `depositLiquidity` without `nonReentrant`.
 */
contract UnguardedDepositLiquidityOrchestrator {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlyingAsset;
    uint256 public bufferAmount;

    constructor(IERC20 underlyingAsset_) {
        underlyingAsset = underlyingAsset_;
    }

    function depositLiquidity(uint256 amount) external {
        require(amount > 0, "zero");
        underlyingAsset.safeTransferFrom(msg.sender, address(this), amount);
        bufferAmount += amount;
    }
}

/**
 * @title ReenteringFeeManager
 * @notice On fee payout, reenters a vault-sensitive op (legacy `sensitiveOp` or production `requestDeposit`).
 */
contract ReenteringFeeManager is ICallbackReceiver {
    using SafeERC20 for IERC20;

    address public vault;
    IERC20 public underlying;
    bool public useSensitiveOpProbe;
    bool public callbackReached;
    bool public reenteredSensitiveOp;
    bool public reenteredRequestDeposit;
    bool private _inCallback;

    function setVault(address vault_) external {
        vault = vault_;
    }

    function setUnderlying(IERC20 underlying_) external {
        underlying = underlying_;
    }

    function setUseSensitiveOpProbe(bool enabled) external {
        useSensitiveOpProbe = enabled;
    }

    function claimFees(uint256 amount) external {
        IOrionVault(vault).claimVaultFees(amount);
    }

    function claimUnguardedFees(uint256 amount) external {
        UnguardedClaimFeesVault(vault).claimFees(amount);
    }

    function onTokenCallback(address, address to, uint256) external override {
        callbackReached = true;
        if (_inCallback || vault == address(0) || to != address(this)) return;
        _inCallback = true;

        if (useSensitiveOpProbe) {
            UnguardedClaimFeesVault(vault).sensitiveOp();
            UnguardedClaimFeesVault(vault).guardedOp();
            reenteredSensitiveOp = true;
        } else if (address(underlying) != address(0)) {
            uint256 minDeposit = IOrionVault(vault).config().minDepositAmount();
            uint256 amount = minDeposit == 0 ? 1 : minDeposit;
            if (underlying.balanceOf(address(this)) >= amount) {
                underlying.forceApprove(vault, amount);
                try IOrionVault(vault).requestDeposit(amount) {
                    reenteredRequestDeposit = true;
                } catch {
                    reenteredRequestDeposit = false;
                }
            }
        }

        _inCallback = false;
    }
}

/**
 * @title UnguardedClaimFeesVault
 * @notice Legacy twin: fee claim without `nonReentrant`, plus a `nonReentrant` sibling stand-in.
 * @dev Shows that without a guard on claim, a token callback can still enter other vault entrypoints
 *      that share (or would share) a reentrancy lock — here `guardedOp` succeeds because claim never
 *      acquired the lock.
 */
contract UnguardedClaimFeesVault is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable manager;
    uint256 public pendingFees;
    bool public sensitiveOpCalled;
    bool public guardedOpCalled;

    constructor(IERC20 token_, address manager_) {
        token = token_;
        manager = manager_;
    }

    function accrue(uint256 amount) external {
        pendingFees += amount;
    }

    /// @dev Legacy pattern: effects then transfer, no reentrancy guard on the claim path.
    ///      Also notifies the manager after the external transfer so the PoC does not depend solely
    ///      on token hooks (same control flow as a callbackable underlying).
    function claimFees(uint256 amount) external {
        require(msg.sender == manager, "not manager");
        require(amount > 0 && amount <= pendingFees, "bad amount");
        pendingFees -= amount;
        token.safeTransfer(manager, amount);
        ICallbackReceiver(manager).onTokenCallback(address(this), manager, amount);
    }

    /// @dev Unguarded stand-in for a state-changing vault op reachable mid-claim.
    function sensitiveOp() external {
        sensitiveOpCalled = true;
    }

    /// @dev Guarded sibling: still callable mid-claim because `claimFees` never took the lock.
    function guardedOp() external nonReentrant {
        guardedOpCalled = true;
    }
}

/**
 * @title IdleWindowRedeemer
 * @notice On redeem payout, records `isSystemIdle` and attempts Idle-gated `depositLiquidity` on the LO.
 * @dev Does not reenter the same vault (fulfillRedeem already holds vault `nonReentrant`).
 */
contract IdleWindowRedeemer is ICallbackReceiver {
    using SafeERC20 for IERC20;

    IOrionConfig public immutable config;
    IOrionVault public vault;
    IDepositLiquidityTarget public liquidityOrchestrator;
    IERC20 public underlying;
    bool public seenIdleDuringPayout;
    bool public idleGatedDepositSucceeded;
    bool private _inCallback;

    constructor(IOrionConfig config_) {
        config = config_;
    }

    function configure(IOrionVault vault_, IDepositLiquidityTarget lo_, IERC20 underlying_) external {
        vault = vault_;
        liquidityOrchestrator = lo_;
        underlying = underlying_;
    }

    function onTokenCallback(address, address to, uint256) external override {
        if (_inCallback || to != address(this) || address(liquidityOrchestrator) == address(0)) return;
        _inCallback = true;

        seenIdleDuringPayout = config.isSystemIdle();

        uint256 amount = 1;
        if (underlying.balanceOf(address(this)) >= amount) {
            underlying.forceApprove(address(liquidityOrchestrator), amount);
            try liquidityOrchestrator.depositLiquidity(amount) {
                idleGatedDepositSucceeded = true;
            } catch {
                idleGatedDepositSucceeded = false;
            }
        }

        _inCallback = false;
    }
}

/**
 * @title LegacyIdleBeforeFulfillOrchestrator
 * @notice Legacy twin: sets Idle before `fulfillRedeem` (old PVO ordering).
 */
contract LegacyIdleBeforeFulfillOrchestrator {
    using SafeERC20 for IERC20;

    IOrionConfig public immutable config;
    IERC20 public immutable underlyingAsset;
    ILiquidityOrchestrator.LiquidityUpkeepPhase public currentPhase;
    uint256 public bufferAmount;

    constructor(IOrionConfig config_) {
        config = config_;
        underlyingAsset = IERC20(config_.underlyingAsset());
        currentPhase = ILiquidityOrchestrator.LiquidityUpkeepPhase.Idle;
    }

    function setPhase(ILiquidityOrchestrator.LiquidityUpkeepPhase phase) external {
        currentPhase = phase;
    }

    /// @dev Idle-gated liquidity add (no nonReentrant) — used by IdleWindowRedeemer mid-settlement probe.
    function depositLiquidity(uint256 amount) external {
        require(currentPhase == ILiquidityOrchestrator.LiquidityUpkeepPhase.Idle, "not idle");
        require(amount > 0, "zero");
        underlyingAsset.safeTransferFrom(msg.sender, address(this), amount);
        bufferAmount += amount;
    }

    function transferRedemptionFunds(address user, uint256 amount) external {
        require(config.isOrionVault(msg.sender) || config.isDecommissionedVault(msg.sender), "not vault");
        if (amount > 0) {
            underlyingAsset.safeTransfer(user, amount);
        }
    }

    function returnDepositFunds(address user, uint256 amount) external {
        require(config.isOrionVault(msg.sender) || config.isDecommissionedVault(msg.sender), "not vault");
        if (amount > 0) {
            underlyingAsset.safeTransfer(user, amount);
        }
    }

    function fulfillDeposit(IOrionVault vault, uint256 depositTotalAssets) external {
        currentPhase = ILiquidityOrchestrator.LiquidityUpkeepPhase.Idle;
        vault.fulfillDeposit(depositTotalAssets);
    }

    /// @dev Old ordering: Idle first, then vault fulfill (opens Idle mid-settlement).
    function processRedeemLegacy(IOrionVault vault, uint256 redeemTotalAssets) external {
        currentPhase = ILiquidityOrchestrator.LiquidityUpkeepPhase.Idle;
        vault.fulfillRedeem(redeemTotalAssets);
    }
}
