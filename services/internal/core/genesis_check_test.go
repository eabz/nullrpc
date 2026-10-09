package core

import "testing"

// The bundled genesis files must hash to each chain's real genesis block.
func TestBundledGenesis(t *testing.T) {
	for chain, want := range map[uint64]string{
		1:      "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
		560048: "0xbbe312868b376a3001692a646dd2d7d1e4406380dfd86b98aa8a34d1557c971b",
	} {
		g, err := genesisFor(chain)
		if err != nil {
			t.Fatal(err)
		}
		if err := checkGenesis(g, chain, want); err != nil {
			t.Fatalf("chain %d: %v", chain, err)
		}
	}
}
