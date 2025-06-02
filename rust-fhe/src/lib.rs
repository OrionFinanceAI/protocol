// src/lib.rs
use tfhe::{generate_keys, ConfigBuilder, ClientKey, ServerKey};
use std::fs::File;
use std::io::Write;

pub struct KeyPair {
    pub client_key: ClientKey,
    pub server_key: ServerKey,
}

pub fn generate_keypair() -> KeyPair {
    let config = ConfigBuilder::default().build();
    let (client_key, server_key) = generate_keys(config);
    KeyPair { client_key, server_key }
}

pub fn write_key_to_hex_file(file_path: &str, key_data: Vec<u8>) {
    let hex = hex::encode(key_data);
    let mut file = File::create(file_path).unwrap();
    file.write_all(hex.as_bytes()).unwrap();
}
