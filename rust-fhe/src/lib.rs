// src/lib.rs
use tfhe::{generate_keys, ConfigBuilder, ClientKey, ServerKey, FheUint8, FheUint32};
use tfhe::prelude::*;
use std::fs::File;
use std::io::{Write, Read};
pub mod ethereum;

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

pub fn read_key_from_hex_file(file_path: &str) -> Vec<u8> {
    let mut file = File::open(file_path).unwrap();
    let mut hex_str = String::new();
    file.read_to_string(&mut hex_str).unwrap();
    hex::decode(hex_str.trim()).unwrap()
}

pub fn encrypt_u8_value(client_key: &ClientKey, value: u8) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let encrypted = FheUint8::try_encrypt(value, client_key)?;
    Ok(bincode::serialize(&encrypted)?)
}

pub fn encrypt_u32_value(client_key: &ClientKey, value: u32) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let encrypted = FheUint32::try_encrypt(value, client_key)?;
    Ok(bincode::serialize(&encrypted)?)
}

pub fn load_client_key(bytes: &[u8]) -> ClientKey {
    bincode::deserialize(bytes).unwrap()
}