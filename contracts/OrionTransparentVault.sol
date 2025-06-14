// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionTransparentVault.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";

/**
 * @title OrionTransparentVault
 * @notice A modular asset management vault powered by curator intents.
 * @dev
 * OrionTransparentVault interprets curator-submitted intents as portfolio allocation targets,
 * expressed as percentages of the total value locked (TVL) in the vault. These
 * intents define how assets should be allocated or rebalanced over time.
 *
 * The vault implements an asynchronous pattern for deposits, withdrawals and order execution.
 * See https://eips.ethereum.org/EIPS/eip-7540
 */
contract OrionTransparentVault is IOrionTransparentVault, ERC4626, ReentrancyGuardTransient {
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    IOrionConfig public config;
    address public curator;
    address public deployer;

    uint256 public sharePrice;
    uint256 internal _totalAssets;

    struct OrderPlain {
        address token;
        uint32 amount;
    }

    struct DepositRequest {
        address user;
        uint256 amount;
    }

    struct WithdrawRequest {
        address user;
        uint256 shares;
    }

    // Queues of async requests from curator and LPs.
    EnumerableMap.AddressToUintMap private _orders;
    DepositRequest[] public depositRequests;
    WithdrawRequest[] public withdrawRequests;

    // Events
    event OrderSubmitted(address indexed curator);
    event DepositRequested(address indexed user, uint256 amount, uint256 requestId);
    event WithdrawRequested(address indexed user, uint256 shares, uint256 requestId);
    event DepositProcessed(address indexed user, uint256 amount, uint256 requestId);
    event WithdrawProcessed(address indexed user, uint256 shares, uint256 requestId);

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

    constructor(
        address _curator,
        address _config
    ) ERC20("Orion Vault Token", "oUSDC") ERC4626(_getUnderlyingAsset(_config)) {
        if (_curator == address(0)) revert ErrorsLib.InvalidCuratorAddress();
        if (_config == address(0)) revert ErrorsLib.InvalidConfigAddress();

        deployer = msg.sender;
        curator = _curator;
        config = IOrionConfig(_config);
        sharePrice = 10 ** decimals();
        _totalAssets = 0;
    }

    /// --------- PUBLIC FUNCTIONS ---------
    /// @notice Disable direct deposits and withdrawals on ERC4626 to enforce async only
    function deposit(uint256, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousDepositsDisabled();
    }

    function mint(uint256, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousDepositsDisabled();
    }

    function withdraw(uint256, address, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousWithdrawalsDisabled();
    }

    function redeem(uint256, address, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousRedemptionsDisabled();
    }

    function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
        return _totalAssets;
    }

    function convertToShares(uint256 assets) public view override(ERC4626, IERC4626) returns (uint256) {
        return (assets * 1e18) / sharePrice;
    }

    function convertToAssets(uint256 shares) public view override(ERC4626, IERC4626) returns (uint256) {
        return (shares * sharePrice) / 1e18;
    }

    /// --------- CURATOR FUNCTIONS ---------

    /// @notice Submit a plaintext portfolio intent.
    /// @param order OrderPlain struct containing the tokens and amounts.
    function submitOrderIntentPlain(OrderPlain[] calldata order) external onlyCurator {
        if (order.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();
        _orders.clear();

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < order.length; i++) {
            address token = order[i].token;
            uint32 amount = order[i].amount;
            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);
            if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(token);
            bool inserted = _orders.set(token, amount);
            if (!inserted) revert ErrorsLib.TokenAlreadyInOrder(token);
            totalAmount += amount;
        }

        uint8 curatorIntentDecimals = config.curatorIntentDecimals();
        if (totalAmount != 10 ** curatorIntentDecimals) revert ErrorsLib.InvalidTotalAmount();

        emit OrderSubmitted(msg.sender);
    }

    /// @notice LPs submits async deposit request; no tokens minted yet
    function requestDeposit(uint256 amount) external {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());
        // Transfer underlying tokens from LPs to vault contract as deposit escrow
        if (!IERC20(asset()).transferFrom(msg.sender, address(this), amount)) revert ErrorsLib.TransferFailed();
        depositRequests.push(DepositRequest({ user: msg.sender, amount: amount }));

        emit DepositRequested(msg.sender, amount, depositRequests.length - 1);
    }

    /// @notice LPs submits async withdrawal request; shares locked until processed
    function requestWithdraw(uint256 shares) external {
        if (shares == 0) revert ErrorsLib.SharesMustBeGreaterThanZero();
        if (balanceOf(msg.sender) < shares) revert ErrorsLib.NotEnoughShares();
        // Lock shares by transferring them to contract as escrow
        _transfer(msg.sender, address(this), shares);

        withdrawRequests.push(WithdrawRequest({ user: msg.sender, shares: shares }));

        emit WithdrawRequested(msg.sender, shares, withdrawRequests.length - 1);
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
        while (i < depositRequests.length) {
            DepositRequest storage request = depositRequests[i];
            uint256 shares = previewDeposit(request.amount);

            depositRequests[i] = depositRequests[depositRequests.length - 1];
            depositRequests.pop();

            _mint(request.user, shares);

            emit DepositProcessed(request.user, request.amount, i);
        }
    }

    /// @notice Process withdrawal requests from LPs
    function processWithdrawRequests() external onlyLiquidityOrchestrator nonReentrant {
        uint256 i = 0;
        while (i < withdrawRequests.length) {
            WithdrawRequest storage request = withdrawRequests[i];

            withdrawRequests[i] = withdrawRequests[withdrawRequests.length - 1];
            withdrawRequests.pop();

            _burn(address(this), request.shares);
            uint256 underlyingAmount = previewRedeem(request.shares);
            if (!IERC20(asset()).transfer(request.user, underlyingAmount)) revert ErrorsLib.TransferFailed();

            emit WithdrawProcessed(request.user, request.shares, i);
        }
    }

    /// --------- INTERNAL FUNCTIONS ---------

    /// @notice Get the underlying asset address from the config
    /// @param _config The address of the config contract
    /// @return The underlying asset address
    function _getUnderlyingAsset(address _config) internal view returns (IERC20) {
        address asset = IOrionConfig(_config).underlyingAsset();
        if (asset == address(0)) revert ErrorsLib.UnderlyingAssetNotSet();
        return IERC20(asset);
    }
}
