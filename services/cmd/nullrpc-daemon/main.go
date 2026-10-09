// nullrpc-daemon follows a pruned node and keeps nullrpc's live window and R2 archive current
// (services/README.md).
package main

import (
	"os"

	"github.com/eabz/nullrpc/services/internal/core"
)

func main() { core.DaemonMain(os.Args[1:]) }
