package noteid

import (
	"strings"
	"testing"
)

func TestValid(t *testing.T) {
	cases := map[string]bool{
		strings.Repeat("a", 43):            true,
		"aZ09_-" + strings.Repeat("x", 37): true,
		strings.Repeat("a", 42):            false,
		strings.Repeat("a", 44):            false,
		strings.Repeat("a", 42) + "!":      false,
		"":                                 false,
	}
	for id, want := range cases {
		if got := Valid(id); got != want {
			t.Errorf("Valid(%q) = %v, want %v", id, got, want)
		}
	}
}
