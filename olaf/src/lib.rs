use js_sys::Uint8Array;
use schnorrkel::olaf::simplpedpop::AllMessage;
use schnorrkel::{KEYPAIR_LENGTH, Keypair, MiniSecretKey, PUBLIC_KEY_LENGTH, PublicKey};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;

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
pub fn wasm_simplpedpop_recipient_all(
    keypair_bytes: &[u8],
    all_messages_concat: &[u8],
) -> Result<Uint8Array, JsValue> {
    if keypair_bytes.len() != KEYPAIR_LENGTH {
        return Err(JsValue::from_str("invalid keypair length"));
    }

    let keypair = Keypair::from_bytes(keypair_bytes)
        .map_err(|_| JsValue::from_str("invalid keypair bytes"))?;

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
    use super::*;

    #[test]
    fn test_simplpedpop_with_test_keys() {
        use hex_literal::hex;

        const TEST_SECRET_KEY_1: [u8; 32] =
            hex!("473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce");
        const TEST_SECRET_KEY_2: [u8; 32] =
            hex!("db9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7");

        // Create keypairs from the test secret keys using MiniSecretKey
        let keypair1 = MiniSecretKey::from_bytes(&TEST_SECRET_KEY_1)
            .expect("Failed to create MiniSecretKey from test key 1")
            .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);

        let keypair2 = MiniSecretKey::from_bytes(&TEST_SECRET_KEY_2)
            .expect("Failed to create MiniSecretKey from test key 2")
            .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);

        // For this test, we'll use the keypairs as both contributors and recipients
        let contributors = vec![keypair1.clone(), keypair2.clone()];
        let recipients = vec![keypair1.public, keypair2.public];

        let threshold = 2u16;
        let participants = 2u16;

        println!("Running SimplPedPoP protocol with test keys:");
        println!("Threshold: {}", threshold);
        println!("Participants: {}", participants);

        // Generate messages from contributors
        let mut all_messages = Vec::new();

        for (i, contributor) in contributors.iter().enumerate() {
            println!("\n--- Contributor {} ---", i + 1);
            let message: AllMessage = contributor
                .simplpedpop_contribute_all(threshold, recipients.clone())
                .expect("Failed to create message");

            let message_bytes = message.to_bytes();
            println!("Message size: {} bytes", message_bytes.len());

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

            let threshold_pk = spp_output.0.spp_output().threshold_public_key();
            println!("Threshold public key: {:?}", threshold_pk.0.to_bytes());

            spp_outputs.push(spp_output);
        }

        // Verify that all threshold_public_keys are equal
        let threshold_pk_0 = spp_outputs[0].0.spp_output().threshold_public_key();
        for (i, spp_output) in spp_outputs.iter().enumerate() {
            assert_eq!(
                threshold_pk_0.0.to_bytes(),
                spp_output
                    .0
                    .spp_output()
                    .threshold_public_key()
                    .0
                    .to_bytes(),
                "Threshold public keys should be identical for recipient {}",
                i
            );
        }

        println!("\n=== FINAL RESULTS ===");
        println!("Threshold Public Key: {:?}", threshold_pk_0.0.to_bytes());
        println!("All messages processed successfully!");
        println!(
            "Protocol completed with {} participants and threshold {}",
            participants, threshold
        );
    }
}
