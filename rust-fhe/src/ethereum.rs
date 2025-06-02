use ethers::prelude::*;
use std::env;
use std::sync::Arc;

abigen!(
    ERC4626Whitelist,
    r#"[
        function addVault(address vault) external
        function removeVault(address vault) external
        function isWhitelisted(address vault) view returns (bool)
        event VaultAdded(address indexed vault)
        event VaultRemoved(address indexed vault)
    ]"#
);

pub async fn add_to_whitelist(vault: Address) -> anyhow::Result<TxHash> {
    dotenv::dotenv().ok();
    let provider = Provider::<Http>::try_from(env::var("RPC_URL")?)?;
    let wallet: LocalWallet = env::var("DEPLOYER_PRIVATE_KEY")?.parse()?;
    let client = Arc::new(SignerMiddleware::new(provider, wallet.with_chain_id(11155111u64)));

    let whitelist_address: Address = env::var("WHITELIST_ADDRESS")?.parse()?;
    let whitelist = ERC4626Whitelist::new(whitelist_address, client);

    let call = whitelist.add_vault(vault);
    let tx = call.send().await?;
    Ok(tx.tx_hash())
}

pub async fn check_whitelisted(vault: Address) -> anyhow::Result<bool> {
    dotenv::dotenv().ok();
    let provider = Provider::<Http>::try_from(env::var("RPC_URL")?)?;
    let wallet: LocalWallet = env::var("PRIVATE_KEY")?.parse()?;
    let client = Arc::new(SignerMiddleware::new(provider, wallet.with_chain_id(11155111u64)));

    let whitelist_address: Address = env::var("WHITELIST_CONTRACT_ADDRESS")?.parse()?;
    let whitelist = ERC4626Whitelist::new(whitelist_address, client);

    Ok(whitelist.is_whitelisted(vault).call().await?)
}

