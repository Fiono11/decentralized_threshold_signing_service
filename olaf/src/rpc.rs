use anyhow::{Error, bail};
use reqwest::Url;
use serde_json::{Value, json};
use std::time::Duration;

pub struct RpcClient {
    url: Url,
    client: reqwest::Client,
}

impl RpcClient {
    pub fn new(url: Url) -> Self {
        Self {
            url,
            client: reqwest::ClientBuilder::new()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        }
    }

    async fn rpc_request(&self, request: &Value) -> Result<Value, Error> {
        let result = self
            .client
            .post(self.url.clone())
            .json(request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;

        if let Some(error) = result.get("error") {
            bail!("node returned error: {}", error);
        }

        Ok(result)
    }

    pub async fn receivable(&self, account: &str, count: u32) -> Result<Value, Error> {
        let request = json!({
            "action": "receivable",
            "account": account,
            "count": count,
            "threshold": 1,
        });
        self.rpc_request(&request).await
    }

    pub async fn account_balance(&self, account: &str) -> Result<Value, Error> {
        let request = json!({
            "action": "account_balance",
            "account": account,
        });
        self.rpc_request(&request).await
    }

    pub async fn account_history(&self, account: &str, count: u32) -> Result<Value, Error> {
        let request = json!({
            "action": "account_history",
            "account": account,
            "count": count,
        });
        self.rpc_request(&request).await
    }

    pub async fn work_generate(&self, hash: &str) -> Result<Value, Error> {
        let request = json!({
            "action": "work_generate",
            "hash": hash,
        });
        self.rpc_request(&request).await
    }

    pub async fn process(&self, subtype: &str, block: &str) -> Result<Value, Error> {
        let request_json = json!({
            "action": "process",
            "json_block": "false",
            "subtype": subtype,
            "block": block
        });

        self.rpc_request(&request_json).await
    }

    pub async fn receive_block(
        &self,
        wallet: &str,
        destination: &str,
        block: &str,
    ) -> Result<Value, Error> {
        let request = json!({
            "action": "receive",
            "wallet": wallet,
            "account": destination,
            "block": block
        });
        self.rpc_request(&request).await
    }

    pub async fn account_info_rpc(&self, account: &str) -> Result<AccountInfo, Error> {
        let request = json!({
            "action": "account_info",
            "account": account
        });

        let json = self.rpc_request(&request).await?;

        Ok(AccountInfo {
            frontier: json["frontier"].as_str().unwrap().to_owned(),
            block_count: json["block_count"].as_str().unwrap().to_owned(),
            balance: json["balance"].as_str().unwrap().to_owned(),
        })
    }
}

#[derive(PartialEq, Eq, Debug)]
pub struct AccountInfo {
    pub frontier: String,
    pub block_count: String,
    pub balance: String,
}
