// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "./OrionConfig.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {euint32} from "../lib/fhevm-solidity/lib/FHE.sol";

/**
 * @title OrionVault
 * @notice A modular asset management vault powered by curator intents.
 * @dev
 * OrionVault interprets curator-submitted intents as portfolio allocation targets,
 * expressed as percentages of the total value locked (TVL) in the vault. These
 * intents define how assets should be allocated or rebalanced over time.
 *
 * The vault implements an asynchronous pattern for deposits, withdrawals and order execution.
 * See https://eips.ethereum.org/EIPS/eip-7540
 *
 * Intents may be submitted in plaintext or in encrypted form, depending on the
 * privacy requirements of the curator. The vault supports pluggable
 * intent interpreters, enabling support for various interpretation and decryption
 * strategies including plaintext parsing and Fully Homomorphic Encryption (FHE).
 *
 * This contract abstracts away the specific encryption method, allowing the protocol
 * to evolve while preserving a consistent interface for intent-driven vault behavior.
 */
contract OrionVault is ERC4626, ReentrancyGuardTransient {
    OrionConfig public config;
    address public curator;
    address public deployer;

    uint256 public sharePrice = 1e18; // 1:1 initially, 18 decimals
    uint256 internal _totalAssets; // manual totalAssets state

    struct OrderPlain {
        address token;
        uint32 amount;
    }
    struct OrderEncrypted {
        address token;
        euint32 amount;
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
    OrderPlain[] private _plainOrder;
    OrderEncrypted[] private _encryptedOrder;
    DepositRequest[] public depositRequests;
    WithdrawRequest[] public withdrawRequests;

    // Events
    event OrderSubmitted(address indexed curator);
    event DepositRequested(
        address indexed user,
        uint256 amount,
        uint256 requestId
    );
    event WithdrawRequested(
        address indexed user,
        uint256 shares,
        uint256 requestId
    );
    event DepositProcessed(
        address indexed user,
        uint256 amount,
        uint256 requestId
    );
    event WithdrawProcessed(
        address indexed user,
        uint256 shares,
        uint256 requestId
    );

    modifier onlyCurator() {
        require(msg.sender == curator, "Not the curator");
        _;
    }

    modifier onlyInternalStatesOrchestrator() {
        require(
            msg.sender == config.internalStatesOrchestrator(),
            "Not internal states orchestrator"
        );
        _;
    }

    modifier onlyLiquidityOrchestrator() {
        require(
            msg.sender == config.liquidityOrchestrator(),
            "Not liquidity orchestrator"
        );
        _;
    }

    constructor(
        address _curator,
        address _config
    )
        ERC20("Orion Vault Token", "oUSDC")
        ERC4626(_getUnderlyingAsset(_config))
    {
        require(_curator != address(0), "Invalid curator address");
        require(_config != address(0), "Invalid config address");

        deployer = msg.sender;
        curator = _curator;
        config = OrionConfig(_config);
    }

    /// --------- PUBLIC FUNCTIONS ---------

    /// @notice Disable direct deposits and withdrawals on ERC4626 to enforce async only
    function deposit(uint256, address) public pure override returns (uint256) {
        revert("Synchronous deposits disabled, use requestDeposit");
    }

    function mint(uint256, address) public pure override returns (uint256) {
        revert("Synchronous deposits disabled, use requestDeposit");
    }

    function withdraw(
        uint256,
        address,
        address
    ) public pure override returns (uint256) {
        revert("Synchronous withdrawals disabled, use requestWithdraw");
    }

    function redeem(
        uint256,
        address,
        address
    ) public pure override returns (uint256) {
        revert("Synchronous withdrawals disabled, use requestWithdraw");
    }

    function totalAssets() public view override returns (uint256) {
        return _totalAssets;
    }

    function convertToShares(uint256 assets) public view override returns (uint256) {
        return (assets * 1e18) / sharePrice;
    }
    
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return (shares * sharePrice) / 1e18;
    }

    /// --------- CURATOR FUNCTIONS ---------

    /// @notice Submit a plaintext portfolio intent.
    /// @param order OrderPlain struct containing the tokens and amounts.
    /// TODO: in the plaintext case, the vault can perform the validation of the order intent (e.g. TVL percentage, long only, etc.).
    function submitOrderIntentPlain(
        OrderPlain[] calldata order
    ) external onlyCurator {
        require(order.length > 0, "Order intent cannot be empty");

        uint32[] memory finalAmounts = new uint32[](
            config.whitelistVaultCount()
        );

        for (uint256 i = 0; i < order.length; i++) {
            address token = order[i].token;
            uint32 amount = order[i].amount;
            require(config.isWhitelisted(token), "Token not whitelisted");

            uint256 index = config.whitelistedVaultIndex(token);
            finalAmounts[index] = amount;
        }

        delete _plainOrder;
        for (uint256 i = 0; i < order.length; i++) {
            _plainOrder.push(
                OrderPlain({token: order[i].token, amount: finalAmounts[i]})
            );
        }
        emit OrderSubmitted(msg.sender);
    }

    /// @notice Submit an encrypted portfolio intent.
    /// @param order OrderEncrypted struct containing the tokens and amounts.
    function submitOrderIntentEncrypted(
        OrderEncrypted[] calldata order
    ) external onlyCurator {
        require(order.length > 0, "Order intent cannot be empty");

        euint32[] memory finalAmounts = new euint32[](
            config.whitelistVaultCount()
        );

        for (uint256 i = 0; i < order.length; i++) {
            address token = order[i].token;
            euint32 amount = order[i].amount;
            require(config.isWhitelisted(token), "Token not whitelisted");

            uint256 index = config.whitelistedVaultIndex(token);
            finalAmounts[index] = amount;
        }

        delete _encryptedOrder;
        for (uint256 i = 0; i < order.length; i++) {
            _encryptedOrder.push(
                OrderEncrypted({token: order[i].token, amount: finalAmounts[i]})
            );
        }
        emit OrderSubmitted(msg.sender);
    }

    /// @notice LPs submits async deposit request; no tokens minted yet
    function requestDeposit(uint256 amount) external {
        require(amount > 0, "Amount must be > 0");

        // Transfer underlying tokens from LPs to vault contract as deposit escrow
        require(
            IERC20(asset()).transferFrom(msg.sender, address(this), amount),
            "Transfer failed"
        );

        depositRequests.push(
            DepositRequest({user: msg.sender, amount: amount})
        );

        emit DepositRequested(msg.sender, amount, depositRequests.length - 1);
    }

    /// @notice LPs submits async withdrawal request; shares locked until processed
    function requestWithdraw(uint256 shares) external {
        require(shares > 0, "Shares must be > 0");
        require(balanceOf(msg.sender) >= shares, "Not enough shares");

        // Lock shares by transferring them to contract as escrow
        _transfer(msg.sender, address(this), shares);

        withdrawRequests.push(
            WithdrawRequest({user: msg.sender, shares: shares})
        );

        emit WithdrawRequested(msg.sender, shares, withdrawRequests.length - 1);
    }

    /// --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    function setSharePrice(uint256 newPrice) external onlyInternalStatesOrchestrator {
        require(newPrice > 0, "ZERO_PRICE");
        sharePrice = newPrice;
    }

    function setTotalAssets(uint256 newTotalAssets) external onlyInternalStatesOrchestrator {
        _totalAssets = newTotalAssets;
    }

    /// --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @notice Process deposit requests from LPs
    function processDepositRequests()
        external
        onlyLiquidityOrchestrator
        nonReentrant
    {
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
    function processWithdrawRequests()
        external
        onlyLiquidityOrchestrator
        nonReentrant
    {
        uint256 i = 0;
        while (i < withdrawRequests.length) {
            WithdrawRequest storage request = withdrawRequests[i];

            withdrawRequests[i] = withdrawRequests[withdrawRequests.length - 1];
            withdrawRequests.pop();

            _burn(address(this), request.shares);
            uint256 underlyingAmount = previewRedeem(request.shares);
            require(
                IERC20(asset()).transfer(request.user, underlyingAmount),
                "Transfer failed"
            );

            emit WithdrawProcessed(request.user, request.shares, i);
        }
    }

    /// --------- INTERNAL FUNCTIONS ---------

    /// @notice Get the underlying asset address from the config
    /// @param _config The address of the config contract
    /// @return The underlying asset address
    function _getUnderlyingAsset(
        address _config
    ) internal view returns (IERC20) {
        address asset = OrionConfig(_config).underlyingAsset();
        require(asset != address(0), "Underlying asset not set");
        return IERC20(asset);
    }
}
