// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../lib/fhevm-solidity/lib/FHE.sol";
import "./OrionConfig.sol";

/**
 * @title OrionVault
 * @notice A modular asset management vault powered by user intents.
 * @dev
 * OrionVault interprets user-submitted intents as portfolio allocation targets,
 * expressed as percentages of the total value locked (TVL) in the vault. These
 * intents define how assets should be allocated or rebalanced over time.
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
contract OrionVault is ERC4626 {
    address public curator;
    address public deployer;
    OrionConfig public config;

    enum ValueEncoding { PLAINTEXT, ENCRYPTED }

    struct OrderValue {
        bytes value; // uint32 (PLAINTEXT) or euint32 (ENCRYPTED)
    }

    struct OrderStruct {
        address token;
        OrderValue value;
    }

    struct Order {
        ValueEncoding encoding;
        OrderStruct[] items;
    }


    Order[] private orders;

    event OrderSubmitted(address indexed curator);

    modifier onlyCurator() {
        require(msg.sender == curator, "Not the curator");
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
    function submitOrder(ValueEncoding encoding, OrderStruct[] calldata items) external onlyCurator {
        require(items.length > 0, "Order cannot be empty");

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

    function _getUnderlyingAsset(address _config) internal view returns (IERC20) {
        address asset = OrionConfig(_config).underlyingAsset();
        require(asset != address(0), "Underlying asset not set");
        return IERC20(asset);
    }
    
}
