package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

// namespacePattern is the archive root inside the bucket: CHAIN_ID-GENESIS_HASH.
var namespacePattern = regexp.MustCompile(`^([0-9]+)-([0-9a-f]{64})$`)

func rpcAnchor(rpc *rpcClient, tag string) (BlockAnchor, error) {
	raw, err := rpc.call("eth_getBlockByNumber", tag, false)
	if err != nil {
		return BlockAnchor{}, err
	}
	var b struct{ Number, Hash, StateRoot string }
	if err := json.Unmarshal(raw, &b); err != nil {
		return BlockAnchor{}, err
	}
	n, err := parseQuantity(b.Number)
	return BlockAnchor{Number: n, Hash: strings.ToLower(b.Hash), StateRoot: strings.ToLower(b.StateRoot)}, err
}

func readJSONFile(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

// publishInputs are the stage outputs generation 1 is built from, all in the work directory.
type publishInputs struct {
	layer     string // state-layer.json
	bundles   string // bundles.json
	rootCheck string // root-check.json
	hashIndex string // hash-index.json
	logIndex  string // log-index.json
	witnesses string // witnesses.json
}

// publish writes generation 1 (manifest and HEAD.json) into the local tree, after checking
// every stage's output against the node. The upload stage sends HEAD.json last.
func publish(rpc *rpcClient, archive localArchive, namespace string, in publishInputs, genesisBytes []byte, chunkBlocks uint64) error {
	m := namespacePattern.FindStringSubmatch(namespace)
	if m == nil {
		return errors.New("namespace must be CHAIN_ID-GENESIS_HASH")
	}
	if len(genesisBytes) == 0 {
		return errors.New("genesis configuration is empty")
	}
	var layer StateHistoryLayerRef
	if err := readJSONFile(in.layer, &layer); err != nil {
		return err
	}
	var bundles []BundleRef
	if err := readJSONFile(in.bundles, &bundles); err != nil {
		return err
	}
	var root rootCheck
	if err := readJSONFile(in.rootCheck, &root); err != nil {
		return fmt.Errorf("state root check: %w", err)
	}
	var hashes hashIndexState
	if err := readJSONFile(in.hashIndex, &hashes); err != nil {
		return fmt.Errorf("hash index: %w", err)
	}
	var logs logIndexState
	if err := readJSONFile(in.logIndex, &logs); err != nil {
		return fmt.Errorf("log index: %w", err)
	}
	// Key size and partition size are manifest-level fields, not stored per object.
	hashes.Object.KeyBytes = hashIndexKeyBytes
	logs.Object.KeyBytes, logs.Object.PartitionBlocks = logIndexKeyBytes, logIndexPartitionBlocks
	var witnesses witnessState
	if err := readJSONFile(in.witnesses, &witnesses); err != nil {
		return fmt.Errorf("witnesses: %w", err)
	}

	chainRaw, err := rpc.call("eth_chainId")
	if err != nil {
		return err
	}
	var chainHex string
	json.Unmarshal(chainRaw, &chainHex)
	chainID, err := parseQuantity(chainHex)
	if err != nil {
		return err
	}
	genesisAnchor, err := rpcAnchor(rpc, "0x0")
	if err != nil {
		return err
	}
	if fmt.Sprint(chainID) != m[1] || genesisAnchor.Hash[2:] != m[2] {
		return fmt.Errorf("namespace does not match the node (chain %d, genesis %s)", chainID, genesisAnchor.Hash)
	}
	if err := checkGenesis(genesisBytes, chainID, genesisAnchor.Hash); err != nil {
		return err
	}

	// Segments cover exactly the state layer, contiguously from genesis.
	next, prev := uint64(0), ""
	for _, b := range bundles {
		if b.FirstBlock != next || (prev != "" && b.FirstParentHash != prev) || b.FirstBlock/chunkBlocks != b.ChunkID || b.LastBlock/chunkBlocks != b.ChunkID {
			return fmt.Errorf("segment %d-%d breaks coverage", b.FirstBlock, b.LastBlock)
		}
		next, prev = b.LastBlock+1, b.LastBlockHash
	}
	if len(bundles) == 0 || next != layer.LastBlock+1 || layer.FirstBlock != 0 {
		return fmt.Errorf("segments end at %d but state covers 0-%d", next, layer.LastBlock)
	}
	// Every segment still ends on the node's canonical chain.
	for _, b := range bundles {
		canonical, err := rpcAnchor(rpc, fmt.Sprintf("0x%x", b.LastBlock))
		if err != nil {
			return err
		}
		if canonical.Hash != b.LastBlockHash {
			return fmt.Errorf("block %d changed since it was archived (%s != %s)", b.LastBlock, b.LastBlockHash, canonical.Hash)
		}
	}
	through, err := rpcAnchor(rpc, fmt.Sprintf("0x%x", layer.LastBlock))
	if err != nil {
		return err
	}
	if through.Hash != prev {
		return errors.New("archived tip hash differs from the node's canonical block")
	}
	finalized, err := rpcAnchor(rpc, "finalized")
	if err != nil {
		return err
	}
	if finalized.Number < through.Number {
		return errors.New("archive would exceed the finalized block")
	}
	if root.Block != through.Number || root.StateRoot != through.StateRoot {
		return fmt.Errorf("state root check was for block %d root %s, the archive ends at %d root %s",
			root.Block, root.StateRoot, through.Number, through.StateRoot)
	}
	if err := checkWitnessRanges(witnesses, bundles); err != nil {
		return err
	}

	var networkID string
	if raw, err := rpc.call("net_version"); err == nil {
		json.Unmarshal(raw, &networkID)
	}
	config, err := archive.putBytes(fmt.Sprintf("%s/config/%s.json", namespace, sha256Hex(genesisBytes)), genesisBytes)
	if err != nil {
		return err
	}
	layer.Level = baseLevel
	manifest := Manifest{
		Format: manifestFormat, Version: 1, Generation: 1,
		Chain:  ChainInfo{ID: chainID, NetworkID: networkID, GenesisHash: genesisAnchor.Hash},
		Config: config, FirstBlock: 0,
		ArchivedThrough:   through,
		FinalizedObserved: Anchor{Number: finalized.Number, Hash: finalized.Hash},
		ChunkBlocks:       chunkBlocks,
		Segments:          segmentRefs(bundles),
		StateHistory:      StateHistory{Layers: []StateHistoryLayerRef{layer}},
		Witnesses:         Witnesses{FirstBlock: witnesses.FirstBlock, Ranges: witnesses.Ranges},
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	}
	if o := hashes.Object; o.FirstBlock != 0 || o.LastBlock != through.Number {
		return fmt.Errorf("hash index covers %d-%d, the archive 0-%d", o.FirstBlock, o.LastBlock, through.Number)
	}
	manifest.HashIndex = &HashIndex{KeyBytes: hashIndexKeyBytes, Objects: []HashIndexObject{hashes.Object}}
	if err := checkHashIndex(namespace, &manifest); err != nil {
		return err
	}
	if o := logs.Object; o.FirstBlock != 0 || o.LastBlock != through.Number {
		return fmt.Errorf("log index covers %d-%d, the archive 0-%d", o.FirstBlock, o.LastBlock, through.Number)
	}
	manifest.LogIndex = &LogIndex{KeyBytes: logIndexKeyBytes, PartitionBlocks: logs.Object.PartitionBlocks, Objects: []LogIndexObject{logs.Object}}
	if err := checkLogIndex(namespace, &manifest); err != nil {
		return err
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	ref, err := archive.putBytes(fmt.Sprintf("%s/manifests/%020d-%s.json", namespace, manifest.Generation, sha256Hex(data)), data)
	if err != nil {
		return err
	}
	head, _ := json.Marshal(Head{Version: 1, Generation: manifest.Generation, Manifest: ref})
	if err := os.WriteFile(archive.path(namespace+"/HEAD.json"), head, 0o644); err != nil {
		return err
	}
	fmt.Printf("{\"namespace\":%q,\"archived_through\":%d,\"finalized\":%d,\"segments\":%d,\"witness_ranges\":%d,\"manifest\":%q}\n",
		namespace, through.Number, finalized.Number, len(bundles), len(witnesses.Ranges), ref.Key)
	return nil
}
