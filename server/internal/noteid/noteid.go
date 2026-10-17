// Package noteid holds the one rule for note ids, shared by every HTTP and WebSocket handler.
package noteid

import "regexp"

// A note id is base64url(HKDF output): 32 bytes → exactly 43 URL-safe characters.
var pattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// Valid reports whether id is a well-formed note id.
func Valid(id string) bool { return pattern.MatchString(id) }
