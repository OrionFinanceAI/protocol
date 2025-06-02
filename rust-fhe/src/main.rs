// src/main.rs
use rust_fhe::{generate_keypair, write_key_to_hex_file};
use std::fs::create_dir_all;
use bincode;

fn main() {
    let args: Vec<String> = std::env::args().collect();

    match args.get(1).map(String::as_str) {
        Some("keygen") => {
            let kp = generate_keypair();
            create_dir_all("../fhe-keys").unwrap();

            let client_key_bytes = bincode::serialize(&kp.client_key).unwrap();
            write_key_to_hex_file("../fhe-keys/fhePublicKeyHex.hex", client_key_bytes);
            
            let server_key_bytes = bincode::serialize(&kp.server_key).unwrap();
            write_key_to_hex_file("../fhe-keys/fhePrivateKeyHex.hex", server_key_bytes);
            
            println!("✅ Keys generated and saved in ./fhe-keys/");
        }

        Some("encrypt") => {
            println!("🔒 Encrypt stub (implement encryption interface)");
            // Accept input via stdin or args
        }

        _ => {
            eprintln!("Usage: cargo run --bin fhe keygen|encrypt");
        }
    }
}
