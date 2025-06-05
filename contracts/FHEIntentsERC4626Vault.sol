// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "../lib/fhevm-solidity/lib/FHE.sol";

interface IConfig {
    function isWhitelisted(address vault) external view returns (bool);
    function getFhePublicCID() external view returns (string memory);
}

contract FHEIntentsERC4626Vault is ERC4626 {
    address public curator;
    address public deployer;
    IConfig public immutable config;
    IERC20 public immutable underlyingAsset;
    address public immutable internalStateOrchestrator;
    address public immutable liquidityOrchestrator;

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
        IERC20 _underlyingAsset,
        address _curator,
        address _config,
        address _internalStateOrchestrator,
        address _liquidityOrchestrator
    )
        ERC20("FHE Intents Vault Token", "fUSDC")
        ERC4626(_underlyingAsset)
    {
        require(_curator != address(0), "Invalid curator address");
        require(_config != address(0), "Invalid config address");
        require(_internalStateOrchestrator != address(0), "Invalid internalStateOrchestrator address");
        require(_liquidityOrchestrator != address(0), "Invalid liquidityOrchestrator address");

        deployer = msg.sender;
        curator = _curator;
        config = IConfig(_config);
        underlyingAsset = _underlyingAsset;
        internalStateOrchestrator = _internalStateOrchestrator;
        liquidityOrchestrator = _liquidityOrchestrator;
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
