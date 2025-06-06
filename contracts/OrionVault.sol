// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "./OrionConfig.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

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
 * strategies including plaintext parsing, Fully Homomorphic Encryption (FHE),
 * zero-knowledge proofs (ZK), or other custom logic.
 *
 * This contract abstracts away the specific encryption method, allowing the protocol
 * to evolve while preserving a consistent interface for intent-driven vault behavior.
 */
contract OrionVault is ERC4626, ReentrancyGuardTransient {
    OrionConfig public config;
    address public curator;
    address public deployer;

    enum AmountEncoding { PLAINTEXT, ENCRYPTED }

    struct OrderStruct {
        address token;
        bytes amount; // uint32 (PLAINTEXT) or euint32 (ENCRYPTED)
    }

    struct Order {
        AmountEncoding encoding;
        OrderStruct[] items;
    }

    struct DepositRequest {
        address user;
        uint256 amount;
        bool processed; // TODO: consider removing this field and just keep the list of nonprocessed requests in the state.
    }

    struct WithdrawRequest {
        address user;
        uint256 shares;
        bool processed; // TODO: Same as above
    }

    // Queues of async requests from curator and LPs.
    Order[] private orders; // TODO: we don't need the lsit of orders, just the last one. No need to define this variable like this and process it as it is now.
    DepositRequest[] public depositRequests;
    WithdrawRequest[] public withdrawRequests;

    // Events
    event OrderSubmitted(address indexed curator);
    event DepositRequested(address indexed user, uint256 amount, uint256 requestId);
    event WithdrawRequested(address indexed user, uint256 shares, uint256 requestId);
    event DepositProcessed(address indexed user, uint256 amount, uint256 requestId);
    event WithdrawProcessed(address indexed user, uint256 shares, uint256 requestId);

    modifier onlyCurator() {
        require(msg.sender == curator, "Not the curator");
        _;
    }

    modifier onlyLiquidityOrchestrator() {
        require(msg.sender == config.liquidityOrchestrator(), "Not liquidity orchestrator");
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

    /// @notice Submit a portfolio intent, where all values use the same encoding scheme.
    /// @param encoding Encoding type (PLAINTEXT or ENCRYPTED) for all portfolio values.
    /// @param items List of token-amount pairs forming a target portfolio.
    function submitOrderIntent(AmountEncoding encoding, OrderStruct[] calldata items) external onlyCurator {
        require(items.length > 0, "Order intent cannot be empty");

        // Validate Universe
        for (uint256 i = 0; i < items.length; i++) {
            require(config.isWhitelisted(items[i].token), "Token not whitelisted");
        }

        Order storage newOrder = orders.push();
        newOrder.encoding = encoding;

        for (uint256 i = 0; i < items.length; i++) {
            newOrder.items.push(items[i]);
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

        depositRequests.push(DepositRequest({
            user: msg.sender,
            amount: amount,
            processed: false
        }));

        emit DepositRequested(msg.sender, amount, depositRequests.length - 1);
    }

    /// @notice LPs submits async withdrawal request; shares locked until processed
    function requestWithdraw(uint256 shares) external {
        require(shares > 0, "Shares must be > 0");
        require(balanceOf(msg.sender) >= shares, "Not enough shares");

        // Lock shares by transferring them to contract as escrow
        _transfer(msg.sender, address(this), shares);

        withdrawRequests.push(WithdrawRequest({
            user: msg.sender,
            shares: shares,
            processed: false
        }));

        emit WithdrawRequested(msg.sender, shares, withdrawRequests.length - 1);
    }

    function processDepositRequests() external onlyLiquidityOrchestrator nonReentrant {
        for (uint256 i = 0; i < depositRequests.length; i++) {
            DepositRequest storage request = depositRequests[i];
            if (!request.processed) {
                request.processed = true;
                uint256 shares = previewDeposit(request.amount);
                _mint(request.user, shares);

                emit DepositProcessed(request.user, request.amount, i);
            }
        }
    }

    function processWithdrawRequests() external onlyLiquidityOrchestrator nonReentrant {
        for (uint256 i = 0; i < withdrawRequests.length; i++) {
            WithdrawRequest storage request = withdrawRequests[i];
            if (!request.processed) {
                request.processed = true;
                _burn(address(this), request.shares);
                uint256 underlyingAmount = previewRedeem(request.shares);
                require(IERC20(asset()).transfer(request.user, underlyingAmount), "Transfer failed");

                emit WithdrawProcessed(request.user, request.shares, i);
            }
        }
    }

    function _getUnderlyingAsset(address _config) internal view returns (IERC20) {
        address asset = OrionConfig(_config).underlyingAsset();
        require(asset != address(0), "Underlying asset not set");
        return IERC20(asset);
    }

    /// @notice Disable direct deposits and withdrawals on ERC4626 to enforce async only
    function deposit(uint256, address) public pure override returns (uint256) {
        revert("Synchronous deposits disabled, use requestDeposit");
    }

    function mint(uint256, address) public pure override returns (uint256) {
        revert("Synchronous deposits disabled, use requestDeposit");
    }

    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert("Synchronous withdrawals disabled, use requestWithdraw");
    }

    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert("Synchronous withdrawals disabled, use requestWithdraw");
    }
    
}
