use blake2::{Blake2b512, Digest};
use js_sys::Uint8Array;
use schnorrkel::olaf::simplpedpop::AllMessage;
use schnorrkel::{KEYPAIR_LENGTH, Keypair, MiniSecretKey, PUBLIC_KEY_LENGTH, PublicKey};
//use sp_core::{Pair, sr25519::Pair as Sr25519Pair};
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

/*#[wasm_bindgen]
pub fn wasm_secret_key_to_ss58_address(secret_key_bytes: &[u8]) -> Result<String, JsValue> {
    if secret_key_bytes.len() != 32 {
        return Err(JsValue::from_str("invalid secret key length"));
    }

    // Create keypair from secret key using schnorrkel
    let keypair = MiniSecretKey::from_bytes(secret_key_bytes)
        .map_err(|_| JsValue::from_str("invalid secret key bytes"))?
        .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);

    // Get the public key bytes
    let public_key_bytes = keypair.public.to_bytes();

    // Convert public key to SS58 address (using Substrate network prefix 42)
    let ss58_address = ss58_encode(&public_key_bytes);

    Ok(ss58_address)
}*/

#[wasm_bindgen]
pub fn wasm_simplpedpop_recipient_all(
    keypair_bytes: &[u8],
    all_messages_concat: &[u8],
) -> Result<Uint8Array, JsValue> {
    if keypair_bytes.len() != KEYPAIR_LENGTH {
        return Err(JsValue::from_str("invalid keypair length"));
    }

    let keypair = Keypair::from_bytes(keypair_bytes)
        .map_err(|_| JsValue::from_str("invalid keypair bytes"))?;

    // Parse the concatenated AllMessage bytes
    // First, we need to deserialize the JSON array of byte arrays
    let all_messages_string = String::from_utf8(all_messages_concat.to_vec())
        .map_err(|_| JsValue::from_str("invalid UTF-8 in all_messages_concat"))?;

    let all_messages_bytes: Vec<Vec<u8>> =
        serde_json::from_str(&all_messages_string).map_err(|e| {
            JsValue::from_str(&format!("Failed to deserialize all_messages data: {}", e))
        })?;

    let all_messages: Vec<AllMessage> = all_messages_bytes
        .iter()
        .map(|all_message_bytes| {
            AllMessage::from_bytes(all_message_bytes)
                .map_err(|e| JsValue::from_str(&format!("Failed to parse AllMessage: {:?}", e)))
        })
        .collect::<Result<_, _>>()?;

    let result = keypair
        .simplpedpop_recipient_all(&all_messages)
        .map_err(|e| JsValue::from_str(&format!("Failed to process AllMessages: {:?}", e)))?;

    let bytes = result.0.spp_output().threshold_public_key().0.to_bytes();
    Ok(Uint8Array::from(bytes.as_slice()))
}

#[cfg(test)]
mod tests {
    use schnorrkel::SecretKey;

    use super::*;

    /*#[test]
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

        // Get the SS58 address using our ss58_encode function
        let public_key = sr25519_pair.public();
        let public_key_bytes: &[u8; 32] = public_key.as_ref();
        let ss58_address = ss58_encode(public_key_bytes);

        // Assert the addresses match
        assert_eq!(
            ss58_address, expected_address,
            "SS58 address mismatch: got {}, expected {}",
            ss58_address, expected_address
        );
    }*/

    /*#[test]
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
    }*/

    /*#[test]
    fn test_wasm_keypair_and_ss58_address_consistency() {
        // Secret key as hex string (without 0x prefix)
        let secret_key_hex = "473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce";

        // Decode hex to bytes
        let secret_key_bytes =
            hex::decode(secret_key_hex).expect("Failed to decode hex secret key");

        // Method 1: Get SS58 address using Sr25519Pair (same as wasm_secret_key_to_ss58_address)
        let sr25519_pair =
            Sr25519Pair::from_seed_slice(&secret_key_bytes).expect("Failed to create Sr25519Pair");
        let public_key_sr25519 = sr25519_pair.public();
        let public_key_bytes_sr25519: &[u8; 32] = public_key_sr25519.as_ref();
        let ss58_address_sr25519 = ss58_encode(public_key_bytes_sr25519);

        // Method 2: Get keypair using schnorrkel (same as wasm_keypair_from_secret)
        let keypair = MiniSecretKey::from_bytes(&secret_key_bytes)
            .expect("Failed to create MiniSecretKey")
            .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);
        let public_key_bytes_schnorrkel: [u8; 32] = keypair.public.to_bytes();
        let ss58_address_schnorrkel = ss58_encode(&public_key_bytes_schnorrkel);

        // Assert both methods produce the same SS58 address
        assert_eq!(
            ss58_address_sr25519, ss58_address_schnorrkel,
            "SS58 addresses should match: Sr25519Pair method returned {}, but schnorrkel method produced {}",
            ss58_address_sr25519, ss58_address_schnorrkel
        );

        // Also verify the public keys are identical
        assert_eq!(
            public_key_bytes_sr25519, &public_key_bytes_schnorrkel,
            "Public keys should be identical"
        );
    }*/

    #[test]
    fn test_simplpedpop_with_test_keys() {
        use curve25519_dalek::Scalar;
        use hex_literal::hex;

        const TEST_SECRET_KEY_1: [u8; 32] =
            hex!("473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce");
        const TEST_SECRET_KEY_2: [u8; 32] =
            hex!("db9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7");

        // Create keypairs from the test secret keys
        let scalar1 = Scalar::from_bytes_mod_order(TEST_SECRET_KEY_1);
        let scalar2 = Scalar::from_bytes_mod_order(TEST_SECRET_KEY_2);

        let mut nonce1 = [0u8; 32];
        let mut nonce2 = [0u8; 32];
        //crate::getrandom_or_panic().fill_bytes(&mut nonce1);
        //crate::getrandom_or_panic().fill_bytes(&mut nonce2);

        let secret_key1 = SecretKey {
            key: scalar1,
            nonce: nonce1,
        };
        let secret_key2 = SecretKey {
            key: scalar2,
            nonce: nonce2,
        };

        let keypair1 = Keypair::from(secret_key1);
        let keypair2 = Keypair::from(secret_key2);

        // For this test, we'll use the keypairs as both contributors and recipients
        let contributors = vec![keypair1.clone(), keypair2.clone()];
        let recipients = vec![keypair1.public, keypair2.public];

        let threshold = 2u16;
        let participants = 2u16;

        println!("Running SimplPedPoP protocol with test keys:");
        println!("Threshold: {}", threshold);
        println!("Participants: {}", participants);
        println!(
            "Contributor 1 public key: {:?}",
            contributors[0].public.to_bytes()
        );
        println!(
            "Contributor 2 public key: {:?}",
            contributors[1].public.to_bytes()
        );

        // Generate messages from contributors
        let mut all_messages = Vec::new();

        for (i, contributor) in contributors.iter().enumerate() {
            println!("\n--- Contributor {} ---", i + 1);
            let message: AllMessage = contributor
                .simplpedpop_contribute_all(threshold, recipients.clone())
                .expect("Failed to create message");

            println!(
                "Message content sender: {:?}",
                message.content.sender.to_bytes()
            );
            println!("Encryption nonce: {:?}", message.content.encryption_nonce);
            println!(
                "Parameters: participants={}, threshold={}",
                message.content.parameters.participants, message.content.parameters.threshold
            );
            println!("Recipients hash: {:?}", message.content.recipients_hash);
            println!(
                "Polynomial commitment coefficients: {} points",
                message
                    .content
                    .polynomial_commitment
                    .coefficients_commitments
                    .len()
            );
            println!(
                "Encrypted secret shares: {} shares",
                message.content.encrypted_secret_shares.len()
            );
            println!(
                "Ephemeral key: {:?}",
                message.content.ephemeral_key.to_bytes()
            );
            println!("Signature: {:?}", message.signature.to_bytes());
            println!(
                "Proof of possession: {:?}",
                message.proof_of_possession.to_bytes()
            );

            all_messages.push(message);
        }

        // Process messages as recipients
        let mut spp_outputs = Vec::new();

        for (i, recipient) in contributors.iter().enumerate() {
            println!("\n--- Recipient {} processing ---", i + 1);
            let spp_output = recipient
                .simplpedpop_recipient_all(&all_messages)
                .expect("Failed to process messages");

            spp_output.0.verify_signature().expect("Invalid signature");

            println!("SPP Output signer: {:?}", spp_output.0.signer.0.to_bytes());
            println!(
                "SPP Output signature: {:?}",
                spp_output.0.signature.to_bytes()
            );
            println!(
                "Threshold public key: {:?}",
                spp_output.0.spp_output.threshold_public_key.0.to_bytes()
            );
            println!(
                "Verifying keys count: {}",
                spp_output.0.spp_output.verifying_keys.len()
            );

            for (j, (id, verifying_share)) in
                spp_output.0.spp_output.verifying_keys.iter().enumerate()
            {
                println!(
                    "  Verifying key {}: ID={:?}, Share={:?}",
                    j,
                    id.0.to_bytes(),
                    verifying_share.0.to_bytes()
                );
            }

            spp_outputs.push(spp_output);
        }

        // Verify that all threshold_public_keys are equal
        let threshold_pk = &spp_outputs[0].0.spp_output.threshold_public_key.0;
        for (i, spp_output) in spp_outputs.iter().enumerate() {
            assert_eq!(
                threshold_pk.to_bytes(),
                spp_output.0.spp_output.threshold_public_key.0.to_bytes(),
                "Threshold public keys should be identical for recipient {}",
                i
            );
        }

        println!("\n=== FINAL RESULTS ===");
        println!("Threshold Public Key: {:?}", threshold_pk.to_bytes());
        println!("All messages processed successfully!");
        println!(
            "Protocol completed with {} participants and threshold {}",
            participants, threshold
        );
    }
}
