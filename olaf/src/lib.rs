use js_sys::Object;
use js_sys::Uint8Array;
use schnorrkel::olaf::SigningKeypair;
use schnorrkel::olaf::multisig::SigningCommitments;
use schnorrkel::olaf::multisig::SigningNonces;
use schnorrkel::olaf::multisig::SigningPackage;
use schnorrkel::olaf::multisig::aggregate;
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

#[wasm_bindgen]
pub fn wasm_aggregate_threshold_signature(
    signing_packages_json: &[u8],
) -> Result<Uint8Array, JsValue> {
    // Parse signing packages from JSON array
    let signing_packages_string = String::from_utf8(signing_packages_json.to_vec())
        .map_err(|_| JsValue::from_str("invalid UTF-8 in signing_packages_json"))?;

    let signing_packages_bytes_vec: Vec<Vec<u8>> = serde_json::from_str(&signing_packages_string)
        .map_err(|e| {
        JsValue::from_str(&format!("Failed to deserialize signing packages: {}", e))
    })?;

    let signing_packages: Vec<SigningPackage> = signing_packages_bytes_vec
        .iter()
        .map(|sp_bytes| {
            SigningPackage::from_bytes(sp_bytes)
                .map_err(|e| JsValue::from_str(&format!("Failed to parse SigningPackage: {:?}", e)))
        })
        .collect::<Result<_, _>>()?;

    // Aggregate the signing packages into a final signature
    let group_signature = aggregate(&signing_packages).map_err(|e| {
        JsValue::from_str(&format!("Failed to aggregate threshold signature: {:?}", e))
    })?;

    // Return signature bytes
    Ok(Uint8Array::from(group_signature.to_bytes().as_slice()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_olaf_with_test_keys() {
        use hex_literal::hex;

        const TEST_SECRET_KEY_1: [u8; 32] =
            hex!("473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce");
        const TEST_SECRET_KEY_2: [u8; 32] =
            hex!("db9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7");

        // Create keypairs from the test secret keys using the same logic as wasm_keypair_from_secret
        let keypair1 = MiniSecretKey::from_bytes(&TEST_SECRET_KEY_1)
            .expect("Failed to create MiniSecretKey from test key 1")
            .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);
        let keypair2 = MiniSecretKey::from_bytes(&TEST_SECRET_KEY_2)
            .expect("Failed to create MiniSecretKey from test key 2")
            .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);

        let keypair1_bytes = keypair1.to_bytes().to_vec();

        // Extract public keys using the same logic as wasm_public_key_from_keypair
        let public1_bytes = keypair1.public.to_bytes().to_vec();
        let public2_bytes = keypair2.public.to_bytes().to_vec();

        // Concatenate recipients (same format as WASM function expects)
        let mut recipients_concat = Vec::new();
        recipients_concat.extend_from_slice(&public1_bytes);
        recipients_concat.extend_from_slice(&public2_bytes);

        // Parse recipients (same logic as wasm_simplpedpop_contribute_all)
        let recipients: Vec<PublicKey> = recipients_concat
            .chunks(PUBLIC_KEY_LENGTH)
            .map(|chunk| PublicKey::from_bytes(chunk).expect("Failed to parse public key"))
            .collect();

        let threshold = 2u16;
        let participants = 2u16;

        println!("Running SimplPedPoP protocol with test keys:");
        println!("Threshold: {}", threshold);
        println!("Participants: {}", participants);

        // Generate messages from contributors using the same logic as wasm_simplpedpop_contribute_all
        let all_message1: AllMessage = keypair1
            .simplpedpop_contribute_all(threshold, recipients.clone())
            .expect("Failed to create message 1");
        let all_message2: AllMessage = keypair2
            .simplpedpop_contribute_all(threshold, recipients.clone())
            .expect("Failed to create message 2");

        let all_message1_bytes = all_message1.to_bytes();
        let all_message2_bytes = all_message2.to_bytes();

        println!("\n--- Contributor 1 ---");
        println!("Message size: {} bytes", all_message1_bytes.len());
        println!("\n--- Contributor 2 ---");
        println!("Message size: {} bytes", all_message2_bytes.len());

        // Prepare all messages (same format as WASM function: JSON array of byte arrays)
        let all_messages_array = vec![all_message1_bytes.clone(), all_message2_bytes.clone()];
        let all_messages_json =
            serde_json::to_string(&all_messages_array).expect("Failed to serialize all_messages");
        let all_messages_bytes = all_messages_json.into_bytes();

        // Parse all messages from JSON (same logic as wasm_simplpedpop_recipient_all)
        let all_messages_string =
            String::from_utf8(all_messages_bytes.clone()).expect("Failed to convert to UTF-8");
        let all_messages_bytes_vec: Vec<Vec<u8>> =
            serde_json::from_str(&all_messages_string).expect("Failed to deserialize all_messages");
        let all_messages: Vec<AllMessage> = all_messages_bytes_vec
            .iter()
            .map(|bytes| AllMessage::from_bytes(bytes).expect("Failed to parse AllMessage"))
            .collect();

        // Process messages as recipients using the same logic as wasm_simplpedpop_recipient_all
        let mut spp_outputs = Vec::new();
        let mut signing_keypair_bytes_vec = Vec::new();
        let mut spp_output_bytes_vec = Vec::new();

        for (i, keypair) in [&keypair1, &keypair2].iter().enumerate() {
            println!("\n--- Recipient {} processing ---", i + 1);

            // Use the same logic as wasm_simplpedpop_recipient_all
            let (spp_output_message, signing_keypair) = keypair
                .simplpedpop_recipient_all(&all_messages)
                .expect("Failed to process messages");

            let signing_keypair_bytes = signing_keypair.to_bytes().to_vec();
            let spp_output_bytes = spp_output_message.to_bytes();

            // Store bytes for later use
            signing_keypair_bytes_vec.push(signing_keypair_bytes.clone());
            spp_output_bytes_vec.push(spp_output_bytes.clone());

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

        // Test Round 1 signing using the same logic as wasm_threshold_sign_round1
        println!("\n=== TESTING ROUND 1 SIGNING ===");
        let mut round1_nonces_bytes_vec = Vec::new();
        let mut round1_commitments_bytes_vec = Vec::new();

        for (i, signing_keypair_bytes) in signing_keypair_bytes_vec.iter().enumerate() {
            println!("\n--- Round 1 for participant {} ---", i + 1);

            // Use the same logic as wasm_threshold_sign_round1
            let signing_share: SigningKeypair = SigningKeypair::from_bytes(signing_keypair_bytes)
                .expect(&format!(
                    "Failed to parse signing share for participant {}",
                    i + 1
                ));

            let (signing_nonces, signing_commitments) = signing_share.commit();

            // Serialize to bytes (same format as WASM function returns)
            let nonces_bytes = signing_nonces.to_bytes();
            let commitments_bytes = signing_commitments.to_bytes();

            // Convert arrays to Vec for storing (same format as WASM function)
            // to_bytes() returns a fixed-size array, convert to Vec<u8>

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

            // Store for round 2 (convert arrays to Vec<u8>)
            round1_nonces_bytes_vec.push(nonces_bytes.as_slice().to_vec());
            round1_commitments_bytes_vec.push(commitments_bytes.as_slice().to_vec());
        }

        println!("Round 1 signing completed successfully for all participants!");

        // Test Round 2 signing using the same logic as wasm_threshold_sign_round2
        println!("\n=== TESTING ROUND 2 SIGNING ===");

        // Prepare test payload and context
        let context = "test context for threshold signing";
        let payload = b"test payload to sign with threshold signature";

        // Prepare all commitments (same format as WASM function: parse from JSON)
        let all_commitments_json = serde_json::to_string(&round1_commitments_bytes_vec)
            .expect("Failed to serialize commitments");
        let all_commitments_string = String::from_utf8(all_commitments_json.into_bytes())
            .expect("Failed to convert to UTF-8");
        let all_commitments_bytes_vec: Vec<Vec<u8>> = serde_json::from_str(&all_commitments_string)
            .expect("Failed to deserialize commitments");
        let all_commitments: Vec<SigningCommitments> = all_commitments_bytes_vec
            .iter()
            .map(|bytes| {
                SigningCommitments::from_bytes(bytes).expect("Failed to parse SigningCommitments")
            })
            .collect();

        // Test round 2 signing for each participant
        let mut round2_outputs_bytes_vec = Vec::new();

        for (i, (signing_keypair_bytes, signing_nonces_bytes, spp_output_bytes)) in
            signing_keypair_bytes_vec
                .iter()
                .zip(round1_nonces_bytes_vec.iter())
                .zip(spp_output_bytes_vec.iter())
                .map(|((a, b), c)| (a, b, c))
                .enumerate()
        {
            println!("\n--- Round 2 for participant {} ---", i + 1);

            // Use the same logic as wasm_threshold_sign_round2
            let signing_share = SigningKeypair::from_bytes(signing_keypair_bytes).expect(&format!(
                "Failed to parse signing share for participant {}",
                i + 1
            ));
            let signing_nonces = SigningNonces::from_bytes(signing_nonces_bytes).expect(&format!(
                "Failed to parse signing nonces for participant {}",
                i + 1
            ));
            let generation_output =
                SPPOutputMessage::from_bytes(spp_output_bytes).expect(&format!(
                    "Failed to parse generation output for participant {}",
                    i + 1
                ));

            // Create signing package
            let signing_package = signing_share
                .sign(
                    context.as_bytes().to_vec(),
                    payload.to_vec(),
                    generation_output.spp_output(),
                    all_commitments.clone(),
                    &signing_nonces,
                )
                .expect(&format!(
                    "Failed to create signing package for participant {}",
                    i + 1
                ));

            let signing_package_bytes = signing_package.to_bytes().as_slice().to_vec();

            println!(
                "Signing package bytes length: {}",
                signing_package_bytes.len()
            );

            round2_outputs_bytes_vec.push(signing_package_bytes);
        }

        // Verify all participants produced signing packages
        assert_eq!(
            round2_outputs_bytes_vec.len(),
            participants as usize,
            "All participants should produce signing packages"
        );

        // Verify signing packages are non-empty
        for (i, signing_package_bytes) in round2_outputs_bytes_vec.iter().enumerate() {
            assert!(
                !signing_package_bytes.is_empty(),
                "Signing package for participant {} should not be empty",
                i + 1
            );
            println!(
                "Participant {} signing package size: {} bytes",
                i + 1,
                signing_package_bytes.len()
            );
        }

        println!("Round 2 signing completed successfully for all participants!");

        // Test signature aggregation using the same logic as wasm_aggregate_threshold_signature
        println!("\n=== TESTING SIGNATURE AGGREGATION ===");

        // Prepare signing packages (same format as WASM function: parse from JSON)
        let signing_packages_json = serde_json::to_string(&round2_outputs_bytes_vec)
            .expect("Failed to serialize signing packages");
        let signing_packages_string = String::from_utf8(signing_packages_json.into_bytes())
            .expect("Failed to convert to UTF-8");
        let signing_packages_bytes_vec: Vec<Vec<u8>> =
            serde_json::from_str(&signing_packages_string)
                .expect("Failed to deserialize signing packages");
        let signing_packages: Vec<SigningPackage> = signing_packages_bytes_vec
            .iter()
            .map(|bytes| SigningPackage::from_bytes(bytes).expect("Failed to parse SigningPackage"))
            .collect();

        // Aggregate all signing packages into a final signature
        let final_signature =
            aggregate(&signing_packages).expect("Failed to aggregate threshold signature");
        let signature_bytes = final_signature.to_bytes().as_slice().to_vec();

        println!(
            "Aggregated signature bytes length: {}",
            signature_bytes.len()
        );
        println!("Signature: {:?}", signature_bytes);
        // Print signature in hex format for comparison with JavaScript test
        let signature_hex: String = signature_bytes
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        println!("Signature (hex): {}", signature_hex);

        // Verify the aggregated signature with the threshold public key
        let verification_result =
            threshold_pk_0
                .0
                .verify_simple(context.as_bytes(), payload, &final_signature);

        assert!(
            verification_result.is_ok(),
            "Aggregated signature should be valid for the threshold public key"
        );

        println!("✓ Aggregated signature verified successfully!");

        // Test round-trip serialization of signature
        println!("Signature serialization: {} bytes", signature_bytes.len());
        assert!(!signature_bytes.is_empty(), "Signature should not be empty");

        // Test that aggregating the same signing packages produces the same signature
        let final_signature_2 = aggregate(&signing_packages)
            .expect("Failed to aggregate threshold signature on second attempt");
        let signature_bytes_2 = final_signature_2.to_bytes().as_slice().to_vec();

        assert_eq!(
            signature_bytes, signature_bytes_2,
            "Aggregating the same signing packages should produce the same signature"
        );

        println!("✓ Signature aggregation is deterministic!");

        // Test that all signature shares are required
        assert_eq!(
            round2_outputs_bytes_vec.len(),
            threshold as usize,
            "We should have exactly threshold signature shares"
        );

        // Test signature aggregation with fewer shares should fail
        if threshold > 1 {
            let insufficient_shares_packages = &signing_packages[..threshold as usize - 1];
            let aggregation_result = aggregate(insufficient_shares_packages);
            assert!(
                aggregation_result.is_err(),
                "Aggregating with fewer than threshold shares should fail"
            );
            println!("✓ Verified that insufficient shares fail aggregation");
        }

        println!("\n=== ALL TESTS PASSED ===");

        assert!(
            threshold_pk_0
                .0
                .verify_simple(context.as_bytes(), payload, &final_signature)
                .is_ok()
        );
    }
}
