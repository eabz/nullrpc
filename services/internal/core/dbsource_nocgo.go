//go:build !cgo

package core

import (
	"context"
	"errors"
)

// Erigon's MDBX bindings need cgo; without it only the RPC source exists.
const defaultBlockSource = "rpc"

func newDBBlockSource(context.Context, blockSourceOptions, *rpcClient, []blockTx, recordRules) (blockSource, func(), error) {
	return nil, nil, errors.New("this nullrpc-backfill was built without cgo, so it cannot read Erigon's database; rebuild with CGO_ENABLED=1 or use --block-source rpc")
}
