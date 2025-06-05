// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../lib/fhevm-solidity/lib/FHE.sol";
import "./OrionConfig.sol";

contract FHEIntentsERC4626Vault is ERC4626 {
    address public curator;
    address public deployer;
    OrionConfig public config;

    struct OrderStruct {
        address token;
        euint32 value;
    }

    struct Order {
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
        ERC20("FHE Intents Vault Token", "fUSDC")
        ERC4626(IERC20(OrionConfig(_config).underlyingAsset()))
    {
        require(_curator != address(0), "Invalid curator address");
        require(_config != address(0), "Invalid config address");

        deployer = msg.sender;
        curator = _curator;
        config = OrionConfig(_config);
    }

    function submitEncryptedOrder(OrderStruct[] calldata items) external onlyCurator {
        require(items.length > 0, "Order cannot be empty");

        // Reject entire order if any token is not whitelisted
        for (uint256 i = 0; i < items.length; i++) {
            require(config.isWhitelisted(items[i].token), "Token not whitelisted");
        }

        Order storage newOrder = orders.push();

        for (uint256 i = 0; i < items.length; i++) {
            newOrder.items.push(items[i]);
        }

        emit OrderSubmitted(msg.sender);
    }
    
}
