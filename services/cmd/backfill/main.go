// backfill builds the nullrpc archive from an Erigon archive node (services/README.md).
package main

import (
	"os"

	"github.com/eabz/nullrpc/services/internal/core"
)

func main() { core.BackfillMain(os.Args[1:]) }
