use std::env;
use std::fs::create_dir_all;
use dotenvy::from_path;
use anyhow::Result;
use ethers::types::Address;
use rust_fhe::{generate_keypair, write_key_to_file};

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
            write_key_to_file("../fhe-keys/fheClientKey.bin", &client_key_bytes)?;

            let server_key_bytes = bincode::serialize(&kp.server_key)?;
            write_key_to_file("../fhe-keys/fheServerKey.bin", &server_key_bytes)?;

            println!("✅ Keys generated and saved in ./fhe-keys/");
        }

        Some("add-to-whitelist") => {
            if let Ok(universe_list) = env::var("UNIVERSE_LIST") {
                let vaults: Vec<&str> = universe_list.split(',').collect();
                for vault_str in vaults {
                    println!("Adding vault: {vault_str}");
                    match vault_str.parse::<Address>() {
                        Ok(vault_address) => {
                            match rust_fhe::ethereum::add_to_whitelist(vault_address).await {
                                Ok(tx_hash) => println!("✅ Vault added to whitelist. TxHash: {tx_hash:?}"),
                                Err(e) => eprintln!("❌ Failed to add vault: {e}"),
                            }
                        }
                        Err(_) => eprintln!("❌ Invalid vault address: {vault_str}"),
                    }
                }
            } else {
                eprintln!("❌ UNIVERSE_LIST not set in .env");
            }
        }
        
        // Some("encrypt-and-submit") => {
        //     let mock_plaintext_intent = vec![1, 2, 3, 4, 5];
        //     let mock_encrypted_intent = encrypt_u8_value(&kp.client_key, mock_plaintext_intent);
        //     println!("🔒 Encrypt stub (implement encryption interface)");
        //     // TODO: submit encrypted intent to vault, then deprecate submit-encrypted-order.ts
        // }

        _ => {
            eprintln!("Usage: cargo run --bin fhe keygen|add-to-whitelist|encrypt-and-submit <vault_address>");
        }
    }

    Ok(())
}
