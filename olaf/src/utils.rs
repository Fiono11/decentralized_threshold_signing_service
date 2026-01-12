use crate::{
    rpc::RpcClient,
    structs::{Account, Amount},
};
use anyhow::Result;
use olaf_lib::{
    SigningKeypair,
    frost::{SigningCommitments, SigningNonces},
    simplpedpop::SPPOutputMessage,
};
use reqwest::Url;
use std::{fs, path::Path};

pub(crate) async fn get_rpc_client(rpc_url: Option<String>) -> RpcClient {
    let url = rpc_url.unwrap_or_else(|| "https://rpcproxy.bnano.info/proxy".to_string());
    RpcClient::new(Url::parse(&url).unwrap())
}

pub(crate) async fn get_previous(
    rpc_client: &RpcClient,
    origin: &str,
) -> Result<([u8; 32], String)> {
    let account_history: serde_json::Value = rpc_client.account_history(origin, 1).await?;
    let previous_str = account_history
        .get("history")
        .and_then(|history| history.as_array())
        .and_then(|array| array.first())
        .and_then(|first| first.get("hash"))
        .and_then(|hash| hash.as_str())
        .ok_or_else(|| anyhow::anyhow!("Failed to retrieve previous hash"))?
        .to_string();
    let previous_decoded = hex::decode(&previous_str)?;
    let mut previous = [0; 32];
    previous.copy_from_slice(&previous_decoded);
    Ok((previous, previous_str))
}

pub async fn get_balance(rpc_client: &RpcClient, origin: &str) -> Result<Amount> {
    let account_balance = rpc_client.account_balance(origin).await?;
    let balance_rpc = account_balance
        .get("balance")
        .and_then(|balance| balance.as_str())
        .ok_or_else(|| anyhow::anyhow!("Failed to retrieve balance"))?;
    Ok(Amount::raw(balance_rpc.parse()?))
}

pub(crate) async fn handle_receive(
    rpc_client: &RpcClient,
    origin: &str,
    balance: Amount,
) -> Result<(Amount, [u8; 32])> {
    let receivable = rpc_client.receivable(origin, 1).await?;
    let blocks = receivable
        .get("blocks")
        .and_then(|blocks| blocks.as_object())
        .ok_or_else(|| anyhow::anyhow!("Missing blocks field or blocks field is not an object"))?;
    let (key, value) = blocks
        .iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No receivable blocks"))?;

    let link_decoded = hex::decode(key)?;
    let mut link = [0; 32];
    link.copy_from_slice(&link_decoded);

    let new_balance = Amount::raw(value.as_str().unwrap().parse()?) + balance;

    Ok((new_balance, link))
}

pub(crate) async fn handle_send(
    _rpc_client: &RpcClient,
    destination: &str,
    amount: u128,
    balance: Amount,
) -> Result<(Amount, [u8; 32])> {
    let link_decoded = Account::decode_account(destination)?;
    let mut link = [0; 32];
    link.copy_from_slice(&link_decoded.0);

    let new_balance = balance - Amount::raw(amount);

    Ok((new_balance, link))
}

pub(crate) fn load_files(
    file_path: &Path,
) -> Result<(
    Vec<SigningCommitments>,
    SigningNonces,
    SigningKeypair,
    SPPOutputMessage,
)> {
    let signing_commitments_string =
        fs::read_to_string(file_path.join("signing_commitments.json"))?;
    let signing_commitments_bytes: Vec<Vec<u8>> =
        serde_json::from_str(&signing_commitments_string)?;
    let signing_commitments: Vec<SigningCommitments> = signing_commitments_bytes
        .iter()
        .map(|bytes| SigningCommitments::from_bytes(bytes).unwrap())
        .collect();

    let signing_nonces_string = fs::read_to_string(file_path.join("signing_nonces.json"))?;
    let signing_nonces_bytes: Vec<u8> = serde_json::from_str(&signing_nonces_string)?;
    let signing_nonces = SigningNonces::from_bytes(&signing_nonces_bytes).unwrap();

    let signing_share_string = fs::read_to_string(file_path.join("signing_share.json"))?;
    let signing_share_vec: Vec<u8> = serde_json::from_str(&signing_share_string)?;
    let mut signing_share_bytes = [0; 64];
    signing_share_bytes.copy_from_slice(&signing_share_vec);
    let signing_share = SigningKeypair::from_bytes(&signing_share_bytes)
        .map_err(|e| anyhow::anyhow!("Failed to create signing keypair: {:?}", e))?;

    let output_string = fs::read_to_string(file_path.join("spp_output.json"))?;
    let output_bytes: Vec<u8> = serde_json::from_str(&output_string)?;
    let spp_output_message = SPPOutputMessage::from_bytes(&output_bytes).unwrap();

    Ok((
        signing_commitments,
        signing_nonces,
        signing_share,
        spp_output_message,
    ))
}
