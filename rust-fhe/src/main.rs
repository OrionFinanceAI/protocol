use std::env;
use std::fs::create_dir_all;
use dotenvy::from_path;
use anyhow::Result;
use ethers::types::Address;
use rust_fhe::{generate_keypair, write_key_to_hex_file};

#[tokio::main]
async fn main() -> Result<()> {
    // Load environment variables from parent directory
    from_path("../.env")?;

    let args: Vec<String> = env::args().collect();

    match args.get(1).map(String::as_str) {
        Some("keygen") => {
            let kp = generate_keypair();
            create_dir_all("../fhe-keys")?;

            let client_key_bytes = bincode::serialize(&kp.client_key)?;
            write_key_to_hex_file("../fhe-keys/fhePublicKeyHex.hex", client_key_bytes);

            let server_key_bytes = bincode::serialize(&kp.server_key)?;
            write_key_to_hex_file("../fhe-keys/fhePrivateKeyHex.hex", server_key_bytes);

            println!("✅ Keys generated and saved in ./fhe-keys/");
        }

        Some("add-to-whitelist") => {
            if let Some(vault_str) = args.get(2) {
                match vault_str.parse::<Address>() {
                    Ok(vault_address) => {
                        match rust_fhe::ethereum::add_to_whitelist(vault_address).await {
                            Ok(tx_hash) => println!("✅ Vault added to whitelist. TxHash: {tx_hash:?}"),
                            Err(e) => eprintln!("❌ Failed to add vault: {e}"),
                        }
                    }
                    Err(_) => eprintln!("❌ Invalid vault address."),
                }
            } else {
                eprintln!("Usage: cargo run --bin fhe add-to-whitelist <vault_address>");
            }
        }

        _ => {
            eprintln!("Usage: cargo run --bin fhe keygen|add-to-whitelist <vault_address>");
        }
    }

    Ok(())
}
