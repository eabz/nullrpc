package main

// Blob base fee (EIP-4844) from a block's excess blob gas and the fork's blob
// schedule, so archived blob gas prices do not depend on Erigon's receipts.

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"sort"
)

// Forks that can set blob parameters, in activation order. A fork without its
// own blobSchedule entry (Osaka) keeps the previous fork's parameters.
var blobForks = []string{"cancun", "prague", "osaka", "bpo1", "bpo2", "bpo3", "bpo4", "bpo5"}

type blobFork struct {
	time     uint64
	fraction uint64
}

// blobSchedule maps a block timestamp to the active base fee update fraction.
type blobSchedule []blobFork

func parseBlobSchedule(genesisJSON []byte) (blobSchedule, error) {
	var g struct {
		Config map[string]json.RawMessage `json:"config"`
	}
	if err := json.Unmarshal(genesisJSON, &g); err != nil {
		return nil, fmt.Errorf("genesis config: %w", err)
	}
	var params map[string]struct {
		BaseFeeUpdateFraction uint64 `json:"baseFeeUpdateFraction"`
	}
	if raw, ok := g.Config["blobSchedule"]; ok {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, fmt.Errorf("blobSchedule: %w", err)
		}
	}
	var out blobSchedule
	var fraction uint64
	for _, fork := range blobForks {
		raw, ok := g.Config[fork+"Time"]
		if !ok {
			continue
		}
		var t uint64
		if err := json.Unmarshal(raw, &t); err != nil {
			return nil, fmt.Errorf("%sTime: %w", fork, err)
		}
		if p, ok := params[fork]; ok {
			fraction = p.BaseFeeUpdateFraction
		}
		if fraction == 0 {
			return nil, fmt.Errorf("no blob base fee update fraction for %s", fork)
		}
		out = append(out, blobFork{t, fraction})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].time < out[j].time })
	return out, nil
}

// recordRules are the chain parameters the block record checks use.
type recordRules struct {
	blobs blobSchedule
	// byzantium is the first Byzantium block (nil: not scheduled). Earlier
	// receipts carry post-state roots instead of a status.
	byzantium *uint64
	// statusBeforeByzantium accepts pre-Byzantium receipts whose source
	// gives a status instead of the post-state root (Erigon v3.7.1 does not
	// keep those roots), so their receipts root cannot be checked; the logs
	// bloom and gas are checked instead (--pre-byzantium-receipts=status).
	statusBeforeByzantium bool
}

func (r recordRules) price(timestamp, excess uint64) (*big.Int, error) {
	return r.blobs.price(timestamp, excess)
}

func (r recordRules) preByzantium(block uint64) bool {
	return r.byzantium == nil || block < *r.byzantium
}

// parseRecordRules reads the blob schedule and the Byzantium block.
func parseRecordRules(genesisJSON []byte) (recordRules, error) {
	blobs, err := parseBlobSchedule(genesisJSON)
	if err != nil {
		return recordRules{}, err
	}
	var g struct {
		Config struct {
			Byzantium *uint64 `json:"byzantiumBlock"`
		} `json:"config"`
	}
	if err := json.Unmarshal(genesisJSON, &g); err != nil {
		return recordRules{}, err
	}
	return recordRules{blobs: blobs, byzantium: g.Config.Byzantium}, nil
}

// preByzantiumFlag registers --pre-byzantium-receipts.
func preByzantiumFlag(fs *flag.FlagSet) *string {
	return fs.String("pre-byzantium-receipts", "fail", "pre-Byzantium receipts that come with a status instead of the post-state root "+
		"(Erigon v3.7.1 keeps no such roots, so the receipts root cannot be checked): fail, or status to archive Erigon's "+
		"status after checking the logs bloom and gas instead (needed for mainnet)")
}

func applyPreByzantium(rules *recordRules, value string) error {
	switch value {
	case "fail":
		rules.statusBeforeByzantium = false
	case "status":
		rules.statusBeforeByzantium = true
	default:
		return fmt.Errorf("--pre-byzantium-receipts must be fail or status, not %q", value)
	}
	return nil
}

// price is the blob base fee of a block with this timestamp and excess blob
// gas: fake_exponential(MIN_BASE_FEE_PER_BLOB_GAS = 1, excess, fraction).
func (b blobSchedule) price(timestamp, excess uint64) (*big.Int, error) {
	var fraction uint64
	for _, f := range b {
		if timestamp >= f.time {
			fraction = f.fraction
		}
	}
	if fraction == 0 {
		return nil, errors.New("block is before the first blob fork")
	}
	return fakeExponential(big.NewInt(1), new(big.Int).SetUint64(excess), new(big.Int).SetUint64(fraction)), nil
}

// fakeExponential approximates factor * e^(numerator/denominator) (EIP-4844).
func fakeExponential(factor, numerator, denominator *big.Int) *big.Int {
	output := new(big.Int)
	acc := new(big.Int).Mul(factor, denominator)
	for i := int64(1); acc.Sign() > 0; i++ {
		output.Add(output, acc)
		acc.Mul(acc, numerator)
		acc.Div(acc, new(big.Int).Mul(denominator, big.NewInt(i)))
	}
	return output.Div(output, denominator)
}
