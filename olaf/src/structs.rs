#[derive(Clone, Debug)]
pub struct StateBlock {
    pub work: u64,
    pub signature: Signature,
    pub hashables: StateHashables,
    pub hash: LazyBlockHash,
    pub sideband: Option<BlockSideband>,
}

impl StateBlock {
    fn hash(&self) -> BlockHash {
        self.hash.hash(&self.hashables)
    }
}

impl From<&StateHashables> for BlockHash {
    fn from(hashables: &StateHashables) -> Self {
        let mut preamble = [0u8; 32];
        preamble[31] = BlockType::State as u8;
        BlockHashBuilder::new()
            .update(preamble)
            .update(hashables.account.0)
            .update(hashables.previous.as_bytes())
            .update(hashables.representative.0)
            .update(hashables.balance.raw.to_be_bytes())
            .update(hashables.link.as_bytes())
            .build()
    }
}

#[repr(u8)]
#[derive(PartialEq, Eq, Debug, Clone, Copy)]
pub enum BlockType {
    Invalid = 0,
    NotABlock = 1,
    LegacySend = 2,
    LegacyReceive = 3,
    LegacyOpen = 4,
    LegacyChange = 5,
    State = 6,
}

impl serde::Serialize for StateBlock {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("Block", 9)?;
        state.serialize_field("type", "state")?;
        state.serialize_field("account", &self.hashables.account)?;
        state.serialize_field("previous", &self.hashables.previous)?;
        state.serialize_field("representative", &self.hashables.representative)?;
        state.serialize_field("balance", &self.hashables.balance.to_string_dec())?;
        state.serialize_field("link", &self.hashables.link.encode_hex())?;
        state.serialize_field("link_as_account", &Account(self.hashables.link.0))?;
        state.serialize_field("signature", &self.signature)?;
        state.serialize_field("work", &to_hex_string(self.work))?;
        state.end()
    }
}

#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct StateHashables {
    // Account# / public key that operates this account
    // Uses:
    // Bulk signature validation in advance of further ledger processing
    // Arranging uncomitted transactions by account
    pub account: Account,

    // Previous transaction in this chain
    pub previous: BlockHash,

    // Representative of this account
    pub representative: Account,

    // Current balance of this account
    // Allows lookup of account balance simply by looking at the head block
    pub balance: Amount,

    // Link field contains source block_hash if receiving, destination account if sending
    pub link: Link,
}

pub fn to_hex_string(i: u64) -> String {
    format!("{:016X}", i)
}

pub fn u64_from_hex_str(s: impl AsRef<str>) -> Result<u64, ParseIntError> {
    u64::from_str_radix(s.as_ref(), 16)
}

#[derive(Clone, Default, Debug)]
pub struct LazyBlockHash {
    // todo: Remove Arc<RwLock>? Maybe remove lazy hash calculation?
    hash: Arc<RwLock<BlockHash>>,
}

impl LazyBlockHash {
    pub fn new() -> Self {
        Self {
            hash: Arc::new(RwLock::new(BlockHash::zero())),
        }
    }
    pub fn hash(&'_ self, factory: impl Into<BlockHash>) -> BlockHash {
        let mut value = self.hash.read().unwrap();
        if value.is_zero() {
            drop(value);
            let mut x = self.hash.write().unwrap();
            let block_hash: BlockHash = factory.into();
            *x = block_hash;
            drop(x);
            value = self.hash.read().unwrap();
        }

        *value
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockSideband {
    pub height: u64,
    pub timestamp: u64,
    /// Successor to the current block
    pub successor: BlockHash,
    pub account: Account,
    pub balance: Amount,
    pub details: BlockDetails,
    pub source_epoch: Epoch,
}

#[derive(PartialEq, Eq, Debug, Clone, Copy, Hash, Default, PartialOrd, Ord)]
pub enum Epoch {
    Invalid = 0,
    #[default]
    Unspecified = 1,
    Epoch0 = 2,
    Epoch1 = 3,
    Epoch2 = 4,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct BlockDetails {
    pub epoch: Epoch,
    pub is_send: bool,
    pub is_receive: bool,
    pub is_epoch: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct Amount {
    pub raw: u128, // native endian!
}

impl std::ops::Add for Amount {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        Amount::raw(self.raw + rhs.raw)
    }
}

impl std::ops::Sub for Amount {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self::Output {
        Amount::raw(self.raw - rhs.raw)
    }
}

impl Amount {
    pub fn to_string_dec(self) -> String {
        self.raw.to_string()
    }

    pub fn decode_hex(s: impl AsRef<str>) -> Result<Self, Error> {
        let value = u128::from_str_radix(s.as_ref(), 16)?;
        Ok(Amount::raw(value))
    }

    pub const fn raw(value: u128) -> Self {
        Self { raw: value }
    }
}

#[derive(Clone, PartialEq, Eq, Debug, PartialOrd, Ord)]
pub struct Signature {
    pub bytes: [u8; 64],
}

use std::{
    fmt::Write as _,
    num::ParseIntError,
    sync::{Arc, RwLock},
};

use anyhow::{Error, bail};
use blake2::{
    Blake2bVar,
    digest::{Update, VariableOutput},
};
use primitive_types::U512;
use serde::ser::SerializeStruct;

impl Signature {
    pub fn encode_hex(&self) -> String {
        let mut result = String::with_capacity(128);
        for byte in self.bytes {
            write!(&mut result, "{:02X}", byte).unwrap();
        }
        result
    }
}

impl serde::Serialize for Signature {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.encode_hex())
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct OpenHashables {
    /// Block with first send transaction to this account
    pub source: BlockHash,
    pub representative: Account,
    pub account: Account,
}

impl From<&OpenHashables> for BlockHash {
    fn from(hashables: &OpenHashables) -> Self {
        BlockHashBuilder::new()
            .update(hashables.source.0)
            .update(hashables.representative.0)
            .update(hashables.account.0)
            .build()
    }
}

impl Default for BlockHashBuilder {
    fn default() -> Self {
        Self {
            blake: Blake2bVar::new(32).unwrap(),
        }
    }
}

pub struct BlockHashBuilder {
    blake: Blake2bVar,
}

impl BlockHashBuilder {
    pub fn new() -> Self {
        Default::default()
    }

    pub fn update(mut self, data: impl AsRef<[u8]>) -> Self {
        self.blake.update(data.as_ref());
        self
    }

    pub fn build(self) -> BlockHash {
        let mut hash_bytes = [0u8; 32];
        self.blake.finalize_variable(&mut hash_bytes).unwrap();
        BlockHash(hash_bytes)
    }
}

#[derive(PartialEq, Eq, Clone, Copy, Hash, Default, PartialOrd, Ord, Debug)]
pub struct Link(pub [u8; 32]);

impl Link {
    pub fn encode_hex(&self) -> String {
        use std::fmt::Write;
        let mut result = String::with_capacity(64);
        for &byte in self.as_bytes() {
            write!(&mut result, "{:02X}", byte).unwrap();
        }
        result
    }

    pub fn as_bytes(&'_ self) -> &'_ [u8; 32] {
        &self.0
    }
}

#[derive(PartialEq, Eq, Clone, Copy, Hash, Default, PartialOrd, Ord, Debug)]
pub struct Account(pub [u8; 32]);

impl Account {
    pub fn encode_account(&self) -> String {
        let mut number = U512::from_big_endian(&self.0);
        let check = U512::from_little_endian(&self.account_checksum());
        number <<= 40;
        number |= check;

        let mut result = String::with_capacity(65);

        for _i in 0..60 {
            let r = number.byte(0) & 0x1f_u8;
            number >>= 5;
            result.push(account_encode(r));
        }
        result.push_str("_onan"); // nano_
        result.chars().rev().collect()
    }

    fn account_checksum(&self) -> [u8; 5] {
        let mut check = [0u8; 5];
        let mut blake = Blake2bVar::new(check.len()).unwrap();
        blake.update(&self.0);
        blake.finalize_variable(&mut check).unwrap();

        check
    }

    pub fn decode_account(source: impl AsRef<str>) -> Result<Account, Error> {
        EncodedAccountStr(source.as_ref()).to_u512()?.to_account()
    }
}

struct EncodedAccountStr<'a>(&'a str);

impl<'a> EncodedAccountStr<'a> {
    fn to_u512(&self) -> Result<EncodedAccountU512, Error> {
        //if !self.is_valid() {
        //bail!("invalid account string");
        //}

        let mut number = U512::default();
        for character in self.chars_after_prefix() {
            match self.decode_byte(character) {
                Some(byte) => {
                    number <<= 5;
                    number = number + byte;
                }
                None => bail!("invalid hex string"),
            }
        }
        Ok(EncodedAccountU512(number))
    }

    fn decode_byte(&self, character: char) -> Option<u8> {
        if character.is_ascii() {
            let character = character as u8;
            if (0x30..0x80).contains(&character) {
                let byte: u8 = account_decode(character);
                if byte != b'~' {
                    return Some(byte);
                }
            }
        }

        None
    }

    fn chars_after_prefix(&'_ self) -> impl Iterator<Item = char> + '_ {
        self.0.chars().skip(5)
    }
}

fn account_decode(value: u8) -> u8 {
    let mut result = ACCOUNT_REVERSE[(value - 0x30) as usize] as u8;
    if result != b'~' {
        result -= 0x30;
    }
    result
}

const ACCOUNT_REVERSE: &[char] = &[
    '~', '0', '~', '1', '2', '3', '4', '5', '6', '7', '~', '~', '~', '~', '~', '~', '~', '~', '~',
    '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '~',
    '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '~', '8', '9', ':', ';', '<', '=', '>', '?',
    '@', 'A', 'B', '~', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', '~', 'L', 'M', 'N', 'O', '~',
    '~', '~', '~', '~',
];

struct EncodedAccountU512(U512);

impl EncodedAccountU512 {
    fn account_bytes(&self) -> [u8; 32] {
        let mut bytes_512 = [0u8; 64];
        (self.0 >> 40).write_as_big_endian(&mut bytes_512);
        let mut bytes_256 = [0u8; 32];
        bytes_256.copy_from_slice(&bytes_512[32..]);
        bytes_256
    }

    fn to_account(&self) -> Result<Account, Error> {
        let account = Account(self.account_bytes());
        /*if account.account_checksum() == self.checksum_bytes() {
            Ok(account)
        } else {
            Err(anyhow!("invalid checksum"))
            }*/
        Ok(account)
    }
}

const ACCOUNT_LOOKUP: &[char] = &[
    '1', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k',
    'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'w', 'x', 'y', 'z',
];

fn account_encode(value: u8) -> char {
    ACCOUNT_LOOKUP[value as usize]
}

impl serde::Serialize for Account {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.encode_account())
    }
}

#[derive(PartialEq, Eq, Clone, Copy, Hash, Default, PartialOrd, Ord, Debug)]
pub struct BlockHash(pub [u8; 32]);

#[derive(PartialEq, Eq, Clone, Copy, Hash, Default, PartialOrd, Ord, Debug)]
pub struct RawKey([u8; 32]);

impl BlockHash {
    pub const fn zero() -> Self {
        Self([0; 32])
    }

    pub fn is_zero(&self) -> bool {
        self.0 == [0; 32]
    }

    pub fn as_bytes(&'_ self) -> &'_ [u8; 32] {
        &self.0
    }

    pub fn encode_hex(&self) -> String {
        use std::fmt::Write;
        let mut result = String::with_capacity(64);
        for &byte in self.as_bytes() {
            write!(&mut result, "{:02X}", byte).unwrap();
        }
        result
    }
}

impl serde::Serialize for BlockHash {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.encode_hex())
    }
}
