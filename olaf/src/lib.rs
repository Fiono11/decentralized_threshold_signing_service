use js_sys::Object;
use js_sys::Uint8Array;
use schnorrkel::olaf::SigningKeypair;
use schnorrkel::olaf::multisig::SigningCommitments;
use schnorrkel::olaf::multisig::SigningNonces;
use schnorrkel::olaf::simplpedpop::AllMessage;
use schnorrkel::olaf::simplpedpop::SPPOutputMessage;
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
) -> Result<JsValue, JsValue> {
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

    // Extract the SPPOutputMessage and SigningKeypair
    let (spp_output_message, signing_keypair) = result;

    // Extract the threshold public key
    let threshold_pk = spp_output_message.spp_output().threshold_public_key();
    let threshold_pk_bytes = threshold_pk.0.to_bytes();

    // Serialize the SigningKeypair to bytes
    let signing_keypair_bytes = signing_keypair.to_bytes();

    // Create a JavaScript object to return the full result
    let js_result = Object::new();

    // Add the threshold public key
    js_sys::Reflect::set(
        &js_result,
        &JsValue::from_str("threshold_public_key"),
        &Uint8Array::from(threshold_pk_bytes.as_slice()).into(),
    )
    .map_err(|_| JsValue::from_str("Failed to set threshold_public_key in result object"))?;

    // Add the SPPOutputMessage bytes (serialized)
    let spp_output_bytes = spp_output_message.to_bytes();
    js_sys::Reflect::set(
        &js_result,
        &JsValue::from_str("spp_output_message"),
        &Uint8Array::from(spp_output_bytes.as_slice()).into(),
    )
    .map_err(|_| JsValue::from_str("Failed to set spp_output_message in result object"))?;

    // Add the SigningKeypair bytes
    js_sys::Reflect::set(
        &js_result,
        &JsValue::from_str("signing_keypair"),
        &Uint8Array::from(signing_keypair_bytes.as_slice()).into(),
    )
    .map_err(|_| JsValue::from_str("Failed to set signing_keypair in result object"))?;

    Ok(js_result.into())
}

#[wasm_bindgen]
pub fn wasm_threshold_sign_round1(signing_share_bytes: &[u8]) -> Result<JsValue, JsValue> {
    let signing_share: SigningKeypair = SigningKeypair::from_bytes(&signing_share_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse signing share: {:?}", e)))?;

    let (signing_nonces, signing_commitments) = signing_share.commit();

    // Serialize signing nonces to bytes and convert to JSON
    let nonces_bytes = signing_nonces.to_bytes();
    let nonces_json = serde_json::to_string(&nonces_bytes.to_vec())
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize nonces: {}", e)))?;

    // Serialize signing commitments to bytes and convert to JSON
    let commitments_bytes = signing_commitments.to_bytes();
    let commitments_json = serde_json::to_string(&commitments_bytes.to_vec())
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize commitments: {}", e)))?;

    // Create a JavaScript object to return both values
    let js_result = Object::new();

    // Add the signing nonces
    js_sys::Reflect::set(
        &js_result,
        &JsValue::from_str("signing_nonces"),
        &JsValue::from_str(&nonces_json),
    )
    .map_err(|_| JsValue::from_str("Failed to set signing_nonces in result object"))?;

    // Add the signing commitments
    js_sys::Reflect::set(
        &js_result,
        &JsValue::from_str("signing_commitments"),
        &JsValue::from_str(&commitments_json),
    )
    .map_err(|_| JsValue::from_str("Failed to set signing_commitments in result object"))?;

    Ok(js_result.into())
}

#[wasm_bindgen]
pub fn wasm_threshold_sign_round2(
    signing_share_bytes: &[u8],
    signing_nonces_bytes: &[u8],
    signing_commitments_bytes_json: &[u8],
    generation_output_bytes: &[u8],
    payload_bytes: &[u8],
    context: &str,
) -> Result<Uint8Array, JsValue> {
    // Parse signing share
    let signing_share = SigningKeypair::from_bytes(&signing_share_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse signing share: {:?}", e)))?;

    // Parse signing nonces
    let signing_nonces = SigningNonces::from_bytes(&signing_nonces_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse signing nonces: {:?}", e)))?;

    // Parse signing commitments from JSON
    let signing_commitments_string = String::from_utf8(signing_commitments_bytes_json.to_vec())
        .map_err(|_| JsValue::from_str("invalid UTF-8 in signing_commitments_bytes_json"))?;

    let signing_commitments_bytes_vec: Vec<Vec<u8>> =
        serde_json::from_str(&signing_commitments_string).map_err(|e| {
            JsValue::from_str(&format!("Failed to deserialize signing commitments: {}", e))
        })?;

    let signing_commitments: Vec<SigningCommitments> = signing_commitments_bytes_vec
        .iter()
        .map(|sc_bytes| {
            SigningCommitments::from_bytes(sc_bytes).map_err(|e| {
                JsValue::from_str(&format!("Failed to parse SigningCommitments: {:?}", e))
            })
        })
        .collect::<Result<_, _>>()?;

    // Parse generation output (SPPOutputMessage)
    let generation_output = SPPOutputMessage::from_bytes(&generation_output_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse generation output: {:?}", e)))?;

    // Create signing package
    let signing_package = signing_share
        .sign(
            context.as_bytes().to_vec(),
            payload_bytes.to_vec(),
            generation_output.spp_output(),
            signing_commitments,
            &signing_nonces,
        )
        .map_err(|e| JsValue::from_str(&format!("Failed to create signing package: {:?}", e)))?;

    // Return signing package bytes
    Ok(Uint8Array::from(signing_package.to_bytes().as_slice()))
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
            let (spp_output_message, signing_keypair) = recipient
                .simplpedpop_recipient_all(&all_messages)
                .expect("Failed to process messages");

            spp_output_message
                .verify_signature()
                .expect("Invalid signature");

            let threshold_pk = spp_output_message.spp_output().threshold_public_key();
            println!("Threshold public key: {:?}", threshold_pk.0.to_bytes());
            println!("Signing keypair bytes: {:?}", signing_keypair.to_bytes());

            spp_outputs.push((spp_output_message, signing_keypair));
        }

        // Verify that all threshold_public_keys are equal
        let threshold_pk_0 = spp_outputs[0].0.spp_output().threshold_public_key();
        for (i, (spp_output_message, _signing_keypair)) in spp_outputs.iter().enumerate() {
            assert_eq!(
                threshold_pk_0.0.to_bytes(),
                spp_output_message
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

        // Test Round 1 signing
        println!("\n=== TESTING ROUND 1 SIGNING ===");
        let mut round1_outputs = Vec::new();

        for (i, (_spp_output, signing_keypair)) in spp_outputs.iter().enumerate() {
            println!("\n--- Round 1 for participant {} ---", i + 1);
            let (signing_nonces, signing_commitments) = signing_keypair.commit();

            // Serialize to bytes for testing (to_bytes() takes ownership)
            let nonces_bytes = signing_nonces.to_bytes();
            let commitments_bytes = signing_commitments.to_bytes();

            println!("Nonces bytes length: {}", nonces_bytes.len());
            println!("Commitments bytes length: {}", commitments_bytes.len());

            // Test deserialization immediately
            let parsed_nonces = SigningNonces::from_bytes(&nonces_bytes)
                .expect(&format!("Failed to parse nonces for participant {}", i + 1));
            let parsed_commitments = SigningCommitments::from_bytes(&commitments_bytes).expect(
                &format!("Failed to parse commitments for participant {}", i + 1),
            );

            // Verify deserialization by comparing serialized output
            let parsed_nonces_bytes = parsed_nonces.to_bytes();
            let parsed_commitments_bytes = parsed_commitments.to_bytes();

            assert_eq!(
                nonces_bytes,
                parsed_nonces_bytes,
                "Nonces should serialize/deserialize correctly for participant {}",
                i + 1
            );
            assert_eq!(
                commitments_bytes,
                parsed_commitments_bytes,
                "Commitments should serialize/deserialize correctly for participant {}",
                i + 1
            );

            // For round 2, we need the actual objects, so commit again
            let (signing_nonces, signing_commitments) = signing_keypair.commit();
            round1_outputs.push((signing_nonces, signing_commitments));
        }

        println!("Round 1 signing completed successfully for all participants!");

        // Test Round 2 signing
        println!("\n=== TESTING ROUND 2 SIGNING ===");

        // Prepare test payload and context
        let context = "test context for threshold signing";
        let payload = b"test payload to sign with threshold signature";

        // Collect all commitments for round 2
        let all_commitments: Vec<SigningCommitments> = round1_outputs
            .iter()
            .map(|(_nonces, commitments)| commitments.clone())
            .collect();

        // Test round 2 signing for each participant
        let mut round2_outputs = Vec::new();

        for (i, ((spp_output, signing_keypair), (signing_nonces, _signing_commitments))) in
            spp_outputs.iter().zip(round1_outputs.iter()).enumerate()
        {
            println!("\n--- Round 2 for participant {} ---", i + 1);

            // Create signing package
            let signing_package = signing_keypair
                .sign(
                    context.as_bytes().to_vec(),
                    payload.to_vec(),
                    spp_output.spp_output(),
                    all_commitments.clone(),
                    signing_nonces,
                )
                .expect(&format!(
                    "Failed to create signing package for participant {}",
                    i + 1
                ));

            let signing_package_bytes = signing_package.to_bytes();
            println!(
                "Signing package bytes length: {}",
                signing_package_bytes.len()
            );

            round2_outputs.push(signing_package);
        }

        // Verify all participants produced signing packages
        assert_eq!(
            round2_outputs.len(),
            participants as usize,
            "All participants should produce signing packages"
        );

        // Verify signing packages are non-empty
        for (i, signing_package) in round2_outputs.iter().enumerate() {
            let bytes = signing_package.to_bytes();
            assert!(
                !bytes.is_empty(),
                "Signing package for participant {} should not be empty",
                i + 1
            );
            println!(
                "Participant {} signing package size: {} bytes",
                i + 1,
                bytes.len()
            );
        }

        println!("Round 2 signing completed successfully for all participants!");
        println!("\n=== ALL TESTS PASSED ===");
    }
}
