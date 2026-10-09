//! The chain's execution rules from its geth genesis `config` object (docs/storage.md, "Chain
//! config"). Ported from exe-execution `config`, extended to every fork revm supports: block
//! forks from Frontier (with the DAO fork), the Merge by terminal total difficulty, and the
//! timestamp forks through BPO2. Forks the executor does not know (Amsterdam and later) fail
//! only for blocks where they are active.

use alloy_consensus::Header;
use alloy_eips::eip7840::BlobParams;
use alloy_evm::{EvmEnv, eth::spec::EthExecutorSpec};
use alloy_hardforks::{EthereumChainHardforks, EthereumHardfork, EthereumHardforks, ForkCondition};
use alloy_primitives::Address;

#[derive(Clone, Debug)]
pub struct ChainConfig {
    genesis: alloy_genesis::ChainConfig,
    forks: EthereumChainHardforks,
    /// Activation times of forks this executor cannot execute.
    unsupported_after: Option<u64>,
}

pub type Result<T> = std::result::Result<T, String>;

macro_rules! ensure {
    ($cond:expr, $($msg:tt)+) => {
        if !$cond {
            return Err(format!($($msg)+));
        }
    };
}

impl ChainConfig {
    /// From the genesis `config` object.
    pub fn from_value(value: &serde_json::Value) -> Result<Self> {
        let config: alloy_genesis::ChainConfig = serde_json::from_value(value.clone())
            .map_err(|e| format!("invalid chain config: {e}"))?;
        Self::from_config(config)
    }

    pub fn from_config(config: alloy_genesis::ChainConfig) -> Result<Self> {
        ensure!(
            config.clique.is_none() && config.parlia.is_none(),
            "unsupported consensus configuration"
        );
        let block_forks = [
            (EthereumHardfork::Homestead, config.homestead_block),
            (EthereumHardfork::Tangerine, config.eip150_block),
            (EthereumHardfork::SpuriousDragon, config.eip158_block),
            (EthereumHardfork::Byzantium, config.byzantium_block),
            (
                EthereumHardfork::Constantinople,
                config.constantinople_block,
            ),
            (EthereumHardfork::Petersburg, config.petersburg_block),
            (EthereumHardfork::Istanbul, config.istanbul_block),
            (EthereumHardfork::Berlin, config.berlin_block),
            (EthereumHardfork::London, config.london_block),
        ];
        // Block forks are sequential; a missing one means it (and every later one) never
        // activates.
        let mut previous = 0;
        let mut ended = false;
        for (_, block) in block_forks {
            match block {
                Some(block) => {
                    ensure!(!ended && block >= previous, "nonsequential fork schedule");
                    previous = block;
                }
                None => ended = true,
            }
        }
        ensure!(
            config.dao_fork_block.is_none() || config.dao_fork_support,
            "unsupported DAO transition"
        );
        let mut forks = vec![(EthereumHardfork::Frontier, ForkCondition::Block(0))];
        for (fork, block) in block_forks {
            if let Some(block) = block {
                forks.push((fork, ForkCondition::Block(block)));
            }
            if fork == EthereumHardfork::Homestead
                && let Some(dao) = config.dao_fork_block
            {
                forks.push((EthereumHardfork::Dao, ForkCondition::Block(dao)));
            }
        }
        for (fork, block) in [
            (EthereumHardfork::MuirGlacier, config.muir_glacier_block),
            (EthereumHardfork::ArrowGlacier, config.arrow_glacier_block),
            (EthereumHardfork::GrayGlacier, config.gray_glacier_block),
        ] {
            if let Some(block) = block {
                forks.push((fork, ForkCondition::Block(block)));
            }
        }
        if let Some(ttd) = config.terminal_total_difficulty {
            // First post-Merge block. Geth's mainnet config omits it (alloy-hardforks
            // `MAINNET_PARIS_BLOCK`).
            let paris_block = match (config.merge_netsplit_block, config.chain_id) {
                (Some(block), _) => Some(block),
                _ if ttd.is_zero() => Some(0),
                (None, 1) => Some(alloy_hardforks::mainnet::MAINNET_PARIS_BLOCK),
                (None, _) => None,
            };
            if let Some(paris_block) = paris_block {
                forks.push((
                    EthereumHardfork::Paris,
                    if ttd.is_zero() {
                        ForkCondition::Block(paris_block)
                    } else {
                        ForkCondition::TTD {
                            activation_block_number: paris_block,
                            fork_block: config.merge_netsplit_block,
                            total_difficulty: ttd,
                        }
                    },
                ));
            } else if config.terminal_total_difficulty_passed {
                return Err("a chain merged after genesis needs mergeNetsplitBlock".into());
            }
        }
        let mut previous = 0;
        let mut ended = false;
        for (fork, activation) in [
            (EthereumHardfork::Shanghai, config.shanghai_time),
            (EthereumHardfork::Cancun, config.cancun_time),
            (EthereumHardfork::Prague, config.prague_time),
            (EthereumHardfork::Osaka, config.osaka_time),
            (EthereumHardfork::Bpo1, config.bpo1_time),
            (EthereumHardfork::Bpo2, config.bpo2_time),
        ] {
            match activation {
                Some(timestamp) => {
                    ensure!(
                        !ended && timestamp >= previous,
                        "nonsequential fork schedule"
                    );
                    previous = timestamp;
                    forks.push((fork, ForkCondition::Timestamp(timestamp)));
                }
                None => ended = true,
            }
        }
        ensure!(
            config.prague_time.is_none() || config.deposit_contract_address.is_some(),
            "Prague requires the deposit contract address"
        );
        let unsupported_after = [
            config.amsterdam_time,
            config.bogota_time,
            config.bpo3_time,
            config.bpo4_time,
            config.bpo5_time,
        ]
        .into_iter()
        .flatten()
        .min();
        Ok(Self {
            genesis: config,
            forks: EthereumChainHardforks::new(forks),
            unsupported_after,
        })
    }

    pub fn chain_id(&self) -> u64 {
        self.genesis.chain_id
    }

    /// Blob parameters at `timestamp`, None before Cancun.
    pub fn blob_params(&self, timestamp: u64) -> Option<BlobParams> {
        if !self.is_cancun_active_at_timestamp(timestamp) {
            return None;
        }
        let active = |time: Option<u64>| time.is_some_and(|time| timestamp >= time);
        let (name, fallback) = if active(self.genesis.bpo2_time) {
            ("bpo2", BlobParams::bpo2())
        } else if active(self.genesis.bpo1_time) {
            ("bpo1", BlobParams::bpo1())
        } else if active(self.genesis.osaka_time) {
            ("osaka", BlobParams::osaka())
        } else if active(self.genesis.prague_time) {
            ("prague", BlobParams::prague())
        } else {
            ("cancun", BlobParams::cancun())
        };
        let mut params = self
            .genesis
            .blob_schedule
            .get(name)
            .copied()
            .unwrap_or_else(|| {
                if name == "osaka" {
                    self.genesis
                        .blob_schedule
                        .get("prague")
                        .copied()
                        .unwrap_or(fallback)
                } else {
                    fallback
                }
            });
        if active(self.genesis.osaka_time) {
            // EIP-7594 caps blobs per transaction independently of BPO block maxima.
            params.max_blobs_per_tx = 6;
            params.blob_base_cost = alloy_eips::eip7840::BLOB_BASE_COST;
        }
        Some(params)
    }

    /// The EVM environment of `header`'s block.
    pub fn env(&self, header: &Header) -> Result<EvmEnv> {
        if let Some(time) = self.unsupported_after {
            ensure!(
                header.timestamp < time,
                "execution unavailable: the block's fork is not supported by this executor"
            );
        }
        ensure!(
            header.slot_number.is_none() && header.block_access_list_hash.is_none(),
            "execution unavailable: unsupported future header fields"
        );
        let blob_params = self.blob_params(header.timestamp);
        let mut env = EvmEnv::for_eth_block(header, self, self.chain_id(), blob_params);
        if blob_params.is_some() && header.excess_blob_gas.is_none() {
            env.block_env.blob_excess_gas_and_price = None;
        }
        Ok(env)
    }

    /// Ether issued to the miner per block before the Merge (wei), None after it.
    pub fn block_reward(&self, number: u64) -> Option<u128> {
        const ETH: u128 = 1_000_000_000_000_000_000;
        if self.is_paris_active_at_block(number) {
            return None;
        }
        Some(if self.is_constantinople_active_at_block(number) {
            2 * ETH
        } else if self.is_byzantium_active_at_block(number) {
            3 * ETH
        } else {
            5 * ETH
        })
    }

    /// The DAO fork block (its irregular state change runs before the block's transactions).
    pub fn dao_fork_block(&self) -> Option<u64> {
        self.genesis.dao_fork_block
    }
}

impl EthereumHardforks for ChainConfig {
    fn ethereum_fork_activation(&self, fork: EthereumHardfork) -> ForkCondition {
        self.forks.ethereum_fork_activation(fork)
    }
}

impl EthExecutorSpec for ChainConfig {
    fn deposit_contract_address(&self) -> Option<Address> {
        self.genesis.deposit_contract_address
    }
}

#[cfg(test)]
mod tests {
    //! Ported from exe-execution `config` (mainnet schedule), plus pre-Merge forks.
    use super::*;
    use revm::primitives::hardfork::SpecId;

    pub(crate) const MAINNET_CONFIG: &str = r#"{
    "chainId": 1, "homesteadBlock": 1150000, "daoForkBlock": 1920000, "daoForkSupport": true,
    "eip150Block": 2463000, "eip155Block": 2675000, "eip158Block": 2675000,
    "byzantiumBlock": 4370000, "constantinopleBlock": 7280000, "petersburgBlock": 7280000,
    "istanbulBlock": 9069000, "muirGlacierBlock": 9200000, "berlinBlock": 12244000,
    "londonBlock": 12965000, "arrowGlacierBlock": 13773000, "grayGlacierBlock": 15050000,
    "terminalTotalDifficulty": 58750000000000000000000, "terminalTotalDifficultyPassed": true,
    "shanghaiTime": 1681338455, "cancunTime": 1710338135, "pragueTime": 1746612311,
    "osakaTime": 1764798551, "bpo1Time": 1765290071, "bpo2Time": 1767747671,
    "blobSchedule": {
      "cancun": {"target": 3, "max": 6, "baseFeeUpdateFraction": 3338477},
      "prague": {"target": 6, "max": 9, "baseFeeUpdateFraction": 5007716},
      "osaka": {"target": 6, "max": 9, "baseFeeUpdateFraction": 5007716},
      "bpo1": {"target": 10, "max": 15, "baseFeeUpdateFraction": 8346193},
      "bpo2": {"target": 14, "max": 21, "baseFeeUpdateFraction": 11684671}
    },
    "depositContractAddress": "0x00000000219ab540356cBB839Cbe05303d7705Fa",
    "ethash": {}
  }"#;

    fn mainnet() -> ChainConfig {
        ChainConfig::from_value(&serde_json::from_str(MAINNET_CONFIG).unwrap()).unwrap()
    }

    #[test]
    fn mainnet_schedule_matches_alloy_hardforks() {
        let config = mainnet();
        for (fork, condition) in EthereumHardfork::mainnet() {
            assert_eq!(config.ethereum_fork_activation(fork), condition, "{fork:?}");
        }
        assert!(config.is_paris_active_at_block(15_537_394));
        assert!(!config.is_paris_active_at_block(15_537_393));
    }

    #[test]
    fn mainnet_blob_schedule() {
        let config = mainnet();
        let at = |t: u64| {
            let p = config.blob_params(t).unwrap();
            (p.target_blob_count, p.max_blob_count, p.update_fraction)
        };
        assert!(config.blob_params(1_710_338_134).is_none());
        assert_eq!(at(1_710_338_135), (3, 6, 3_338_477));
        assert_eq!(at(1_746_612_311), (6, 9, 5_007_716));
        assert_eq!(at(1_765_290_071), (10, 15, 8_346_193));
        assert_eq!(at(1_767_747_671), (14, 21, 11_684_671));
    }

    #[test]
    fn every_fork_has_an_environment() {
        let config = mainnet();
        let cases = [
            (1_000_000, 1_455_404_053, SpecId::FRONTIER, false),
            (1_150_000, 1_457_981_393, SpecId::HOMESTEAD, false),
            (4_370_000, 1_508_131_331, SpecId::BYZANTIUM, false),
            (12_244_000, 1_618_481_223, SpecId::BERLIN, false),
            (12_965_000, 1_628_166_822, SpecId::LONDON, false),
            (15_537_394, 1_663_224_179, SpecId::MERGE, true),
            (17_034_870, 1_681_338_479, SpecId::SHANGHAI, true),
            (20_000_000, 1_717_281_407, SpecId::CANCUN, true),
            (23_000_000, 1_753_166_591, SpecId::PRAGUE, true),
        ];
        for (number, timestamp, spec, merged) in cases {
            let header = Header {
                number,
                timestamp,
                gas_limit: 30_000_000,
                difficulty: alloy_primitives::U256::from(if merged { 0 } else { 1000 }),
                ..Default::default()
            };
            let env = config.env(&header).unwrap();
            assert_eq!(env.cfg_env.spec, spec, "block {number}");
            assert_eq!(env.block_env.prevrandao.is_some(), merged, "block {number}");
        }
        assert_eq!(
            config.block_reward(1_000_000),
            Some(5_000_000_000_000_000_000)
        );
        assert_eq!(
            config.block_reward(4_370_000),
            Some(3_000_000_000_000_000_000)
        );
        assert_eq!(
            config.block_reward(7_280_000),
            Some(2_000_000_000_000_000_000)
        );
        assert_eq!(config.block_reward(15_537_394), None);
    }

    #[test]
    fn unknown_future_forks_fail_only_when_active() {
        let mut source: serde_json::Value = serde_json::from_str(MAINNET_CONFIG).unwrap();
        source["amsterdamTime"] = 1_800_000_000_u64.into();
        let config = ChainConfig::from_value(&source).unwrap();
        let header = |timestamp| Header {
            number: 24_000_000,
            timestamp,
            ..Default::default()
        };
        assert!(config.env(&header(1_799_999_999)).is_ok());
        assert!(config.env(&header(1_800_000_000)).is_err());
        let mut source: serde_json::Value = serde_json::from_str(MAINNET_CONFIG).unwrap();
        source["cancunTime"] = 1_600_000_000_u64.into();
        assert!(ChainConfig::from_value(&source).is_err());
    }
}
