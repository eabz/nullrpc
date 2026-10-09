//go:build !cgo

package core

import (
	"context"
	"errors"
)

// Witnesses execute blocks against Erigon's database, which needs cgo.
type witnessExecutor struct{}

type witnessTx interface{ Rollback() }

func newWitnessExecutor(context.Context, string) (*witnessExecutor, func(), error) {
	return nil, nil, errors.New("this backfill was built without cgo, so it cannot execute blocks against Erigon's database; rebuild with CGO_ENABLED=1")
}

func (x *witnessExecutor) readTx(context.Context) (witnessTx, error) { return nil, errors.ErrUnsupported }

func (x *witnessExecutor) execute(context.Context, witnessTx, uint64) (*blockWitness, error) {
	return nil, errors.ErrUnsupported
}
