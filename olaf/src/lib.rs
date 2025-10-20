use js_sys::Uint8Array;
use schnorrkel::{KEYPAIR_LENGTH, Keypair, PUBLIC_KEY_LENGTH, PublicKey};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

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
