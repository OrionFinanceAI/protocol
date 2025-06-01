// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "../lib/fhevm-solidity/lib/FHE.sol";

contract FHEIntentsERC4626Vault is ERC4626 {
    address public curator;
    address public deployer;

    enum Ticker { ETH, BTC }

    struct Order {
        Ticker ticker;
        euint32 value;
    }

    Order[] public orders;

    bytes public fhePublicKey;

    event OrderSubmitted(address indexed curator, Ticker ticker, euint32 value);

    modifier onlyCurator() {
        require(msg.sender == curator, "Not the curator");
        _;
    }

    constructor(
        IERC20 underlyingAsset,
        address _curator,
        bytes memory _fhePublicKey
    )
        ERC20("FHE Intents Vault Token", "fUSDC")
        ERC4626(underlyingAsset)
    {
        require(_curator != address(0), "Invalid curator address");
        deployer = msg.sender;
        curator = _curator;
        fhePublicKey = _fhePublicKey;
    }

    function submitEncryptedOrder(Ticker ticker, euint32 encryptedValue) external onlyCurator {
        orders.push(Order(ticker, encryptedValue));
        emit OrderSubmitted(msg.sender, ticker, encryptedValue);
    }

    function getOrderCount() external view returns (uint256) {
        return orders.length;
    }

    function getOrder(uint256 index) external view returns (Ticker, euint32) {
        require(index < orders.length, "Index out of bounds");
        Order storage ord = orders[index];
        return (ord.ticker, ord.value);
    }
}
