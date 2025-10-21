use blake2::{Blake2b512, Digest};
use js_sys::Uint8Array;
use schnorrkel::{KEYPAIR_LENGTH, Keypair, MiniSecretKey, PUBLIC_KEY_LENGTH, PublicKey};
use sp_core::{Pair, sr25519::Pair as Sr25519Pair};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;

/// SS58 encode a public key with network ID 42 (Substrate)
fn ss58_encode(pubkey: &[u8; 32]) -> String {
    const SS58_PREFIX: u8 = 42; // Substrate generic network
    const PREFIX_BYTES: &[u8] = b"SS58PRE";

    // Build the data to encode: prefix + public key
    let mut data = Vec::with_capacity(35); // 1 prefix + 32 pubkey + 2 checksum
    data.push(SS58_PREFIX);
    data.extend_from_slice(pubkey);

    // Calculate checksum using Blake2b-512
    let mut hasher = Blake2b512::new();
    hasher.update(PREFIX_BYTES);
    hasher.update(&data);
    let hash = hasher.finalize();

    // Append first 2 bytes of hash as checksum
    data.extend_from_slice(&hash[0..2]);

    // Base58 encode
    bs58::encode(&data).into_string()
}

#[wasm_bindgen]
pub fn wasm_keypair_from_secret(secret_key_bytes: &[u8]) -> Result<Uint8Array, JsValue> {
    if secret_key_bytes.len() != 32 {
        return Err(JsValue::from_str("invalid secret key length"));
    }

    let keypair = MiniSecretKey::from_bytes(secret_key_bytes)
        .map_err(|_| JsValue::from_str("invalid secret key bytes"))?
        .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);

    Ok(Uint8Array::from(keypair.to_bytes().as_ref()))
}

#[wasm_bindgen]
pub fn wasm_simplpedpop_contribute_all(
    keypair_bytes: &[u8],
    threshold: u16,
    recipients_concat: &[u8],
) -> Result<Uint8Array, JsValue> {
    if keypair_bytes.len() != KEYPAIR_LENGTH {
        return Err(JsValue::from_str("invalid keypair length"));
    }
    if recipients_concat.len() % PUBLIC_KEY_LENGTH != 0 {
        return Err(JsValue::from_str("invalid recipients bytes length"));
    }

    let keypair = Keypair::from_bytes(keypair_bytes)
        .map_err(|_| JsValue::from_str("invalid keypair bytes"))?;

    let recipients: Vec<PublicKey> = recipients_concat
        .chunks(PUBLIC_KEY_LENGTH)
        .map(|chunk| {
            PublicKey::from_bytes(chunk).map_err(|_| JsValue::from_str("invalid public key bytes"))
        })
        .collect::<Result<_, _>>()?;

    let msg = keypair
        .simplpedpop_contribute_all(threshold, recipients)
        .map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;
    let bytes = msg.to_bytes();
    Ok(Uint8Array::from(bytes.as_slice()))
}

#[wasm_bindgen]
pub fn wasm_secret_key_to_ss58_address(secret_key_bytes: &[u8]) -> Result<String, JsValue> {
    if secret_key_bytes.len() != 32 {
        return Err(JsValue::from_str("invalid secret key length"));
    }

    // Create Sr25519Pair from secret key
    let sr25519_pair = Sr25519Pair::from_seed_slice(secret_key_bytes)
        .map_err(|_| JsValue::from_str("invalid secret key bytes"))?;

    // Get the public key bytes
    let public_key = sr25519_pair.public();
    let public_key_bytes: &[u8; 32] = public_key.as_ref();

    // Convert public key to SS58 address (using Substrate network prefix 42)
    let ss58_address = ss58_encode(public_key_bytes);

    Ok(ss58_address)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sp_core::{Pair, crypto::Ss58Codec, sr25519::Pair as Sr25519Pair};

    #[test]
    fn test_secret_key_to_ss58_address() {
        // Secret key as hex string (without 0x prefix)
        let secret_key_hex = "473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce";

        // Expected SS58 address
        let expected_address = "5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw";

        // Decode hex to bytes
        let secret_key_bytes =
            hex::decode(secret_key_hex).expect("Failed to decode hex secret key");

        // Generate the keypair using schnorrkel (same as the wasm function)
        let _keypair = MiniSecretKey::from_bytes(&secret_key_bytes)
            .expect("Failed to create MiniSecretKey")
            .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);

        // Convert to sp_core Sr25519Pair to use SS58 encoding
        // We create a pair from the secret + public key
        let sr25519_pair =
            Sr25519Pair::from_seed_slice(&secret_key_bytes).expect("Failed to create Sr25519Pair");

        // Get the SS58 address (using Substrate network prefix 42)
        let ss58_address = sr25519_pair.public().to_ss58check();

        // Assert the addresses match
        assert_eq!(
            ss58_address, expected_address,
            "SS58 address mismatch: got {}, expected {}",
            ss58_address, expected_address
        );
    }

    #[test]
    fn test_wasm_secret_key_to_ss58_address() {
        // Secret key as hex string (without 0x prefix)
        let secret_key_hex = "473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce";

        // Expected SS58 address
        let expected_address = "5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw";

        // Decode hex to bytes
        let secret_key_bytes =
            hex::decode(secret_key_hex).expect("Failed to decode hex secret key");

        // Call the WASM function
        let result = wasm_secret_key_to_ss58_address(&secret_key_bytes);

        // Assert the result is Ok
        assert!(result.is_ok(), "WASM function should succeed");

        // Assert the addresses match
        let ss58_address = result.unwrap();
        assert_eq!(
            ss58_address, expected_address,
            "SS58 address mismatch: got {}, expected {}",
            ss58_address, expected_address
        );
    }
}
