// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";

/**
 * @title OrionVault
 * @notice A modular asset management vault powered by curator intents, with asynchronous deposits and withdrawals
 * @dev
 * OrionVault is an abstract base contract that provides common functionality for transparent and encrypted vaults.
 * It implements the asynchronous pattern for deposits and withdrawals as defined in EIP-7540.
 * The vault interprets curator-submitted intents as portfolio allocation targets, expressed as percentages
 * of the total value locked (TVL). These intents define how assets should be allocated or rebalanced over time.
 *
 * Key features:
 * - Asynchronous deposits and withdrawals via request queues
 * - Share price and total assets tracking
 * - Access control for curator and orchestrator roles
 * - ERC4626 vault standard compliance
 * - Reentrancy protection
 *
 * Derived contracts implement the specific intent submission and interpretation logic, either in plaintext
 * (OrionTransparentVault) or encrypted form (OrionEncryptedVault) for privacy-preserving vaults.
 */
abstract contract OrionVault is
    Initializable,
    ERC4626Upgradeable,
    ReentrancyGuardUpgradeable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    IOrionVault
{
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    IOrionConfig public config;
    address public curator;
    address public deployer;

    uint256 public sharePrice;
    uint256 internal _totalAssets;

    // Queues of async requests from LPs
    EnumerableMap.AddressToUintMap private _depositRequests;
    EnumerableMap.AddressToUintMap private _withdrawRequests;

    modifier onlyCurator() {
        if (msg.sender != curator) revert ErrorsLib.NotCurator();
        _;
    }

    modifier onlyInternalStatesOrchestrator() {
        if (msg.sender != config.internalStatesOrchestrator()) revert ErrorsLib.NotInternalStatesOrchestrator();
        _;
    }

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != config.liquidityOrchestrator()) revert ErrorsLib.NotLiquidityOrchestrator();
        _;
    }

    function __OrionVault_init(
        address _curator,
        IOrionConfig _config,
        string memory _name,
        string memory _symbol
    ) internal onlyInitializing {
        if (_curator == address(0)) revert ErrorsLib.InvalidCuratorAddress();
        if (address(_config) == address(0)) revert ErrorsLib.InvalidConfigAddress();

        __ERC20_init(_name, _symbol);
        __ERC4626_init(_config.underlyingAsset());
        __ReentrancyGuard_init();

        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        _transferOwnership(_curator);

        deployer = msg.sender;
        curator = _curator;
        config = _config;
        sharePrice = 10 ** decimals();
        _totalAssets = 0;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyCurator {}

    /// --------- PUBLIC FUNCTIONS ---------
    /// @notice Disable direct deposits and withdrawals on ERC4626 to enforce async only
    function deposit(uint256, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousDepositsDisabled();
    }

    function mint(uint256, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousDepositsDisabled();
    }

    function withdraw(uint256, address, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousWithdrawalsDisabled();
    }

    function redeem(uint256, address, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousRedemptionsDisabled();
    }

    function totalAssets() public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        // TODO: mimicking the ERC4626 implementation when it comes to events emission, for etherscan consistency.
        return _totalAssets;
    }

    function convertToShares(uint256 assets) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return (assets * decimals()) / sharePrice;
    }

    function convertToAssets(uint256 shares) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return (shares * sharePrice) / decimals();
    }

    /// --------- LP FUNCTIONS ---------

    /// @notice LPs submits async deposit request; no share tokens minted yet,
    /// while underlying tokens are transferred to the vault contract as escrow.
    function requestDeposit(uint256 amount) external {
        // Checks first
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());

        // Effects - update internal state before external interactions
        (bool exists, uint256 existingAmount) = _depositRequests.tryGet(msg.sender);
        if (exists) _depositRequests.set(msg.sender, existingAmount + amount);
        else _depositRequests.set(msg.sender, amount);

        // Interactions - external calls last
        bool success = IERC20(asset()).transferFrom(msg.sender, address(this), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        emit DepositRequested(msg.sender, amount, _depositRequests.length());
    }
    // TODO: To make the system more trustless,
    // add a function to withdrawl (syncronously) before minting and
    // get back the underlying tokens in the escrow.

    /// @notice LPs submits async withdrawal request; shares locked until processed
    function requestWithdraw(uint256 shares) external {
        // Checks first
        if (shares == 0) revert ErrorsLib.SharesMustBeGreaterThanZero();
        if (balanceOf(msg.sender) < shares) revert ErrorsLib.NotEnoughShares();

        // Effects - update internal state before transfers
        (bool exists, uint256 existingShares) = _withdrawRequests.tryGet(msg.sender);
        if (exists) _withdrawRequests.set(msg.sender, existingShares + shares);
        else _withdrawRequests.set(msg.sender, shares);

        // Interactions - lock shares by transferring them to contract as escrow
        _transfer(msg.sender, address(this), shares);

        emit WithdrawRequested(msg.sender, shares, _withdrawRequests.length());
    }

    /// --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    function setSharePrice(uint256 newPrice) external onlyInternalStatesOrchestrator {
        if (newPrice == 0) revert ErrorsLib.ZeroPrice();
        sharePrice = newPrice;
    }

    function setTotalAssets(uint256 newTotalAssets) external onlyInternalStatesOrchestrator {
        _totalAssets = newTotalAssets;
    }

    /// --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @notice Process deposit requests from LPs
    function processDepositRequests() external onlyLiquidityOrchestrator nonReentrant {
        uint256 i = 0;
        for (i = 0; i < _depositRequests.length(); i++) {
            (address user, uint256 amount) = _depositRequests.at(i);
            uint256 shares = previewDeposit(amount);

            _depositRequests.remove(user);

            _mint(user, shares);

            emit DepositProcessed(user, amount, i);
        }
    }

    /// @notice Process withdrawal requests from LPs
    function processWithdrawRequests() external onlyLiquidityOrchestrator nonReentrant {
        uint256 i = 0;
        for (i = 0; i < _withdrawRequests.length(); i++) {
            (address user, uint256 shares) = _withdrawRequests.at(i);

            _withdrawRequests.remove(user);

            _burn(address(this), shares);
            uint256 underlyingAmount = previewRedeem(shares);
            if (!IERC20(asset()).transfer(user, underlyingAmount)) revert ErrorsLib.TransferFailed();

            emit WithdrawProcessed(user, shares, i);
        }
    }

    /// --------- INTERNAL FUNCTIONS ---------

    /// @notice Get the underlying asset address from the config
    /// @param _config The address of the config contract
    /// @return The underlying asset address
    function _getUnderlyingAsset(address _config) internal view returns (IERC20) {
        IERC20 asset = IOrionConfig(_config).underlyingAsset();
        if (address(asset) == address(0)) revert ErrorsLib.UnderlyingAssetNotSet();
        return asset;
    }

    /// --------- ABSTRACT FUNCTIONS ---------
    /// @notice Derived contracts implement their specific submitOrderIntent functions
}
