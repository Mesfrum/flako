package store

import "testing"

func TestMemoryContract(t *testing.T) {
	runContract(t, func(t *testing.T) Store { return NewMemory() })
}
